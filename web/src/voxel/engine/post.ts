import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import type { ResolvedPalette } from './palette'

/**
 * 调色 pass：曝光 → 饱和度 → 冷暖分离（split-tone）→ 着色暗角 → 哈希颗粒。
 * 颗粒时间种子乘 uMotion：reduced-motion 时颗粒静止（AC7）。
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uExposure: { value: 1 },
    uSaturation: { value: 1 },
    uShadowTint: { value: new THREE.Vector3(0.75, 0.82, 1.04) },
    uHighTint: { value: new THREE.Vector3(1.06, 1.0, 0.9) },
    uVignette: { value: 0.28 },
    uGrain: { value: 0.014 },
    uTime: { value: 0 },
    uMotion: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uSaturation;
    uniform vec3 uShadowTint;
    uniform vec3 uHighTint;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    uniform float uMotion;
    varying vec2 vUv;

    float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      c *= uExposure;
      float l = luma(c);
      // 饱和度
      c = mix(vec3(l), c, uSaturation);
      // 冷暖分离：暗部偏冷、亮部偏暖
      c *= mix(uShadowTint, uHighTint, smoothstep(0.12, 0.72, l));
      // 着色暗角：向 shadowTint 变暗，不压纯黑
      float d = distance(vUv, vec2(0.5));
      float v = smoothstep(0.38, 0.78, d) * uVignette;
      c *= mix(vec3(1.0), uShadowTint, v);
      // 胶片颗粒（uMotion=0 时种子冻结 → 颗粒静止）
      float g = hash(vUv * vec2(1831.0, 1017.0) + fract(uTime * uMotion) * 61.7) - 0.5;
      c += g * uGrain;
      gl_FragColor = vec4(max(c, vec3(0.0)), 1.0);
    }
  `,
}

/** 检测软件渲染后端（SwiftShader / llvmpipe 等），用于后处理与阴影降级 */
export function isSoftwareGL(renderer: THREE.WebGLRenderer): boolean {
  try {
    const gl = renderer.getContext()
    const dbg = gl.getExtension('WEBGL_debug_renderer_info')
    const name = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : ''
    return /swiftshader|llvmpipe|softpipe|software/i.test(name)
  } catch {
    return false
  }
}

/**
 * 后处理链：RenderPass → UnrealBloom → Grade → Output。
 * MSAA 由 composer RenderTarget(samples=4) 承担（WebGL2），HalfFloat 保留超亮源供 bloom。
 * bloom 阈值 0.85：让夜晚灯火（顶点色 ≈1）也能泛光（AC2），而非仅太阳。
 */
export class PostPipeline {
  enabled = true
  private composer: EffectComposer
  private renderPass: RenderPass
  private bloom: UnrealBloomPass
  private grade: ShaderPass
  private gradeUniforms: typeof GradeShader.uniforms
  private softwareBloomScale = 1

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private cameraProvider: () => THREE.Camera,
  ) {
    const size = renderer.getSize(new THREE.Vector2())
    const pixelRatio = renderer.getPixelRatio()
    // 软件渲染（SwiftShader/llvmpipe）降级：关 MSAA、字节 RT、bloom 半分辨率；
    // 真 GPU 保持 plan 品质档（MSAA4 + HalfFloat HDR + 全分辨率 bloom）
    const software = isSoftwareGL(renderer)
    const rt = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
      samples: software ? 0 : 4,
      type: software ? THREE.UnsignedByteType : THREE.HalfFloatType,
    })
    this.composer = new EffectComposer(renderer, rt)
    this.composer.setPixelRatio(pixelRatio)
    this.composer.setSize(size.x, size.y)

    this.renderPass = new RenderPass(scene, cameraProvider())
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.3, 0.4, 0.85)
    if (software) this.bloom.setSize(size.x / 2, size.y / 2)
    this.softwareBloomScale = software ? 0.5 : 1
    this.grade = new ShaderPass(GradeShader)
    this.gradeUniforms = this.grade.uniforms as typeof GradeShader.uniforms

    this.composer.addPass(this.renderPass)
    this.composer.addPass(this.bloom)
    this.composer.addPass(this.grade)
    this.composer.addPass(new OutputPass())
  }

  /** 每帧写调色 uniforms；单项强度归零即等效该效果关闭（N3） */
  update(post: ResolvedPalette['post'], opts: { motion: number; time: number }): void {
    this.bloom.strength = post.bloomStrength
    const u = this.gradeUniforms
    u.uExposure.value = post.exposure
    u.uSaturation.value = post.saturation
    u.uShadowTint.value.set(...post.shadowTint)
    u.uHighTint.value.set(...post.highTint)
    u.uVignette.value = post.vignette
    u.uGrain.value = post.grain
    u.uTime.value = opts.time
    u.uMotion.value = opts.motion
  }

  resize(width: number, height: number): void {
    this.composer.setSize(width, height)
    if (this.softwareBloomScale !== 1) {
      this.bloom.setSize(width * this.softwareBloomScale, height * this.softwareBloomScale)
    }
  }

  render(dt: number): void {
    this.renderPass.camera = this.cameraProvider()
    this.composer.render(dt)
  }

  dispose(): void {
    this.composer.dispose()
    this.bloom.dispose()
    this.grade.dispose()
  }
}
