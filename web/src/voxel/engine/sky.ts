import * as THREE from 'three'
import type { ResolvedPalette } from './palette'

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position; // 单位球穹，object-space 方向即视线方向
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAG = /* glsl */ `
varying vec3 vDir;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uFogColor;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunIntensity;
uniform vec3 uMoonDir;
uniform float uMoonIntensity;
uniform float uStarIntensity;
uniform float uCloudCoverage;
uniform vec3 uCloudTint;
uniform float uTime;
uniform float uMotion;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

vec3 hash33(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.xxy + p.yxx) * p.zyx);
}

float hash21(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
    mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
    f.y
  );
}

float fbm(vec2 p) {
  return vnoise(p) * 0.6 + vnoise(p * 2.13 + 7.7) * 0.4;
}

void main() {
  vec3 dir = normalize(vDir);

  // 天顶-地平线渐变；地平线以下向雾色收敛（与 FogExp2 衔接，无断层）
  // pow 指数 0.38:天顶色快速抵达,俯视常态视角也能看到竖向渐变
  float h = clamp(dir.y, 0.0, 1.0);
  vec3 sky = mix(uHorizon, uZenith, pow(h, 0.38));
  // 地平线以下不平涂:向画面底部微暗微冷(伪大气纵深),俯视全景不再是一块纯色
  vec3 belowBand = mix(uFogColor * vec3(0.86, 0.9, 0.97), uFogColor, smoothstep(-0.45, 0.02, dir.y));
  sky = mix(belowBand, sky, smoothstep(-0.1, 0.03, dir.y));

  // 星空：方向网格哈希星点，白昼/地平线淡出，轻微闪烁
  if (uStarIntensity > 0.001) {
    vec3 sp = dir * 90.0;
    vec3 id = floor(sp);
    vec3 starPos = hash33(id);
    float sd = length(fract(sp) - starPos);
    float star = smoothstep(0.12, 0.0, sd);
    float twinkle = 0.7 + 0.3 * sin(uTime * (1.0 + hash13(id) * 3.0) + hash13(id.zyx) * 6.2831);
    sky += vec3(0.9, 0.95, 1.0) * star * twinkle * 1.25 * uStarIntensity * smoothstep(0.0, 0.12, dir.y);
  }

  // 太阳盘 + 指数光晕（超亮喂 bloom）；落到地平线下时淡出
  vec3 sunDirN = normalize(uSunDir);
  float sunVis = smoothstep(-0.06, 0.02, uSunDir.y);
  float sd1 = dot(dir, sunDirN);
  float sunDisk = smoothstep(0.9995, 0.99985, sd1);
  float sunHalo = pow(max(sd1, 0.0), 128.0);
  // 宽幅大气散射:太阳高悬时俯视视角天空也有冷暖朝向(近太阳侧暖亮)
  float sunScatter = pow(max(sd1, 0.0), 6.0);
  sky += uSunColor * (sunDisk * 2.2 + sunHalo * 0.5) * uSunIntensity * sunVis;
  sky += uSunColor * sunScatter * 0.1 * uSunIntensity * sunVis;

  // 月亮盘 + 柔光晕
  vec3 moonDirN = normalize(uMoonDir);
  float moonVis = smoothstep(-0.06, 0.02, uMoonDir.y);
  float md = dot(dir, moonDirN);
  float moonDisk = smoothstep(0.99965, 0.99985, md);
  float moonHalo = pow(max(md, 0.0), 384.0);
  sky += vec3(0.86, 0.9, 1.0) * (moonDisk * 0.9 + moonHalo * 0.3) * uMoonIntensity * moonVis;

  // 程序化积云：方向投影到天顶平面，2 层 FBM，coverage 成形，随时间漂移
  if (uCloudCoverage > 0.001) {
    vec2 cuv = dir.xz / max(dir.y, 0.15);
    cuv = cuv * 1.4 + vec2(0.8, 0.35) * (uTime * uMotion) * 0.012;
    float cl = fbm(cuv);
    float cloud = smoothstep(1.0 - uCloudCoverage, 1.0 - uCloudCoverage + 0.15, cl);
    cloud *= smoothstep(0.02, 0.12, dir.y); // 地平线淡出(放低让高云在俯视视角可见)
    // 受光侧染色、背光侧压暗
    vec2 sunH = normalize(uSunDir.xz + vec2(0.0001));
    float lit = 0.5 + 0.5 * dot(normalize(dir.xz + vec2(0.0001)), sunH);
    vec3 cloudCol = uCloudTint * mix(0.8, 1.05, lit);
    sky = mix(sky, cloudCol, cloud * 0.85);
  }

  gl_FragColor = vec4(sky, 1.0);
}
`

type SkyUniforms = {
  uZenith: { value: THREE.Color }
  uHorizon: { value: THREE.Color }
  uFogColor: { value: THREE.Color }
  uSunDir: { value: THREE.Vector3 }
  uSunColor: { value: THREE.Color }
  uSunIntensity: { value: number }
  uMoonDir: { value: THREE.Vector3 }
  uMoonIntensity: { value: number }
  uStarIntensity: { value: number }
  uCloudCoverage: { value: number }
  uCloudTint: { value: THREE.Color }
  uTime: { value: number }
  uMotion: { value: number }
}

/**
 * 程序化天空穹顶：渐变 + 太阳/月亮 + 星空 + 积云。
 * 颜色全部来自 ResolvedPalette（与雾同源，地平线无断层）；无贴图零资产。
 */
export class SkyDome {
  readonly mesh: THREE.Mesh
  private material: THREE.ShaderMaterial
  private uniforms: SkyUniforms

  constructor() {
    this.uniforms = {
      uZenith: { value: new THREE.Color(0.25, 0.5, 0.9) },
      uHorizon: { value: new THREE.Color(0.62, 0.79, 0.92) },
      uFogColor: { value: new THREE.Color(0.62, 0.79, 0.92) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.8) },
      uSunIntensity: { value: 1 },
      uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
      uMoonIntensity: { value: 0 },
      uStarIntensity: { value: 0 },
      uCloudCoverage: { value: 0.3 },
      uCloudTint: { value: new THREE.Color(1, 0.98, 0.94) },
      uTime: { value: 0 },
      uMotion: { value: 1 },
    }
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms as unknown as Record<string, THREE.IUniform>,
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    })
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = -1000 // 先画穹顶，世界几何按深度覆盖
  }

  /** 控制外部天空穹顶；空间切换时可逆。 */
  setVisible(visible: boolean): void {
    this.mesh.visible = visible
  }

  get visible(): boolean {
    return this.mesh.visible
  }

  /** 每帧跟随相机位置，并把半径缩放到远裁剪面以内 */
  follow(camera: THREE.Camera): void {
    this.mesh.position.copy(camera.position)
    const far = camera instanceof THREE.PerspectiveCamera ? camera.far : 1000
    this.mesh.scale.setScalar(far * 0.45)
  }

  update(sky: ResolvedPalette['sky'], fogColor: ResolvedPalette['fog']['color'], uTime: number, motion: number): void {
    const u = this.uniforms
    u.uZenith.value.setRGB(...sky.zenith)
    u.uHorizon.value.setRGB(...sky.horizon)
    u.uFogColor.value.setRGB(...fogColor)
    u.uSunDir.value.set(sky.sunDir.x, sky.sunDir.y, sky.sunDir.z)
    u.uSunColor.value.setRGB(...sky.sunColor)
    u.uSunIntensity.value = sky.sunIntensity
    u.uMoonDir.value.set(sky.moonDir.x, sky.moonDir.y, sky.moonDir.z)
    u.uMoonIntensity.value = sky.moonIntensity
    u.uStarIntensity.value = sky.starIntensity
    u.uCloudCoverage.value = sky.cloudCoverage
    u.uCloudTint.value.setRGB(...sky.cloudTint)
    u.uTime.value = uTime
    u.uMotion.value = motion
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    this.material.dispose()
  }
}
