import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { validateAssetManifest } from '@possibility/voxel-contract'

declare global {
  interface Window { __assetShotReady?: boolean | 'error' }
}

const SIZE = 512
const BACKGROUND = 0xb8c4d0 // 统一纯色背景(缩略图可比性)

/**
 * /dev/asset-shot 资产快照页(S2a 模块 E):
 * 单资产固定等轴机位渲染,供缩略图子流程截图与人工目检。
 * 两种寻址:?asset=<id> 查统一清单;?glb=<url> 直读 GLB(入库缩略图发生在登记前)。
 * 就绪信号 window.__assetShotReady:true / 'error'。
 */
export default function AssetShot() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const params = new URLSearchParams(window.location.search)
    const assetId = params.get('asset')
    const glbUrl = params.get('glb')
    let disposed = false
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true })

    const fail = (message: string) => {
      if (disposed) return
      setError(message)
      window.__assetShotReady = 'error'
    }

    void (async () => {
      try {
        let url = glbUrl
        if (!url) {
          if (!assetId) throw new Error('缺少 ?asset=<id> 或 ?glb=<url> 参数')
          const res = await fetch('/voxel-assets/library/manifest.json')
          if (!res.ok) throw new Error(`资产清单加载失败(${res.status})`)
          const parsed = validateAssetManifest(await res.json())
          if (!parsed.ok) throw new Error(`资产清单非法:${parsed.issues[0]?.message ?? '未知'}`)
          const entry = parsed.manifest.assets[assetId]
          if (!entry) throw new Error(`未知资产 id:${assetId}`)
          url = entry.url
        }
        const gltf = await new GLTFLoader().loadAsync(url)
        if (disposed) return

        renderer.setSize(SIZE, SIZE, false)
        renderer.setPixelRatio(1)
        const scene = new THREE.Scene()
        scene.background = new THREE.Color(BACKGROUND)
        scene.add(new THREE.HemisphereLight(0xdfeaf5, 0x8a7f6a, 1.1))
        const sun = new THREE.DirectionalLight(0xfff2dd, 1.6)
        sun.position.set(3, 5, 2)
        scene.add(sun)
        scene.add(gltf.scene)

        // 等轴机位 + 包围盒自动取景:从 (1,0.85,1) 方向回看包围盒中心
        const box = new THREE.Box3().setFromObject(gltf.scene)
        const center = box.getCenter(new THREE.Vector3())
        const sphere = box.getBoundingSphere(new THREE.Sphere())
        const radius = Math.max(sphere.radius, 0.001)
        const camera = new THREE.PerspectiveCamera(35, 1, 0.01, radius * 20)
        const dir = new THREE.Vector3(1, 0.85, 1).normalize()
        camera.position.copy(center).addScaledVector(dir, radius / Math.sin((35 * Math.PI) / 360) * 1.15)
        camera.lookAt(center)

        renderer.render(scene, camera)
        window.__assetShotReady = true
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err))
      }
    })()

    return () => {
      disposed = true
      window.__assetShotReady = undefined
      renderer.dispose()
    }
  }, [])

  return (
    <div className="grid h-screen place-items-center bg-zinc-900" data-testid="asset-shot">
      <canvas ref={canvasRef} width={SIZE} height={SIZE} data-testid="asset-shot-canvas" />
      {error && (
        <div className="absolute bottom-3 rounded bg-red-900/80 px-3 py-1 text-xs text-red-100" data-testid="asset-shot-error">
          {error}
        </div>
      )}
    </div>
  )
}
