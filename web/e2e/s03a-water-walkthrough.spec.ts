import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

/**
 * S3a 风格化水面 · AC10 端到端走查 + 探针断言(N4:探针为主力,截图目检收尾)。
 * 截图输出 docs/spec_docs/voxel-visual-upgrade/s03a-stylized-water/walkthrough/(gitignored)。
 * fixture 水池:fill (32,1,30)→(38,1,36)。截图前一律 waitFrames(SwiftShader 低帧率)。
 */

const SHOTS = '../docs/spec_docs/voxel-visual-upgrade/s03a-stylized-water/walkthrough'
mkdirSync(SHOTS, { recursive: true })

/** 水池范围(与 fixture.ts 一致) */
const POOL = { x0: 32, x1: 38, z0: 30, z1: 36, y: 1 }
const POOL_CENTER = { x: 35, y: 1, z: 33 }

interface WaterProbe {
  setTimeOfDay(t: number): void
  setWeather(state: Record<string, number>): void
  setCameraMode(m: 'orbit' | 'walk'): { ok: boolean; reason?: string }
  underwaterStrength: number
  palette: { keyframes: Array<Record<string, unknown>> } | null
  registry: { get(id: string): { category?: string } | undefined } | null
  renderer: {
    shaderUniforms: {
      uMotion: { value: number }
      uWaterShallow: { value: { r: number; g: number; b: number } }
      uSkyReflect: { value: { r: number; g: number; b: number } }
    }
  } & Record<string, unknown>
  world: {
    getBlock(p: { x: number; y: number; z: number }): string
    doc: { size: { width: number; height: number; depth: number } }
  } | null
  cameraRig: {
    camera: { position: { x: number; y: number; z: number } }
  }
}

declare global {
  interface Window {
    __voxelEngine?: WaterProbe
    __voxelPerf?: { timedEdit(ops: unknown[]): number }
  }
}

async function openWorld(page: Page) {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
  await page.waitForTimeout(600)
  return errors
}

/** 等渲染循环真正走完 n 帧(SwiftShader 低帧率下固定延时可能截到旧帧) */
async function waitFrames(page: Page, n = 2) {
  await page.evaluate((count) => new Promise<void>((resolve) => {
    const step = (left: number) => { left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)) }
    step(count)
  }), n)
}

async function setTime(page: Page, t: number) {
  await page.evaluate((v) => window.__voxelEngine!.setTimeOfDay(v), t)
  await waitFrames(page, 2)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** 把 orbit 相机对准水池(theta/phi/distance 为调试直写,绕开输入 clamp) */
async function aimAtPool(page: Page, opts: { theta: number; phi: number; distance: number }) {
  await page.evaluate((o) => {
    const orbit = (window.__voxelEngine!.cameraRig as unknown as {
      orbit: { setTarget(t: { x: number; y: number; z: number }): void; theta: number; phi: number; distance: number }
    }).orbit
    orbit.setTarget(o.target)
    orbit.theta = o.theta
    orbit.phi = o.phi
    orbit.distance = o.distance
  }, { ...opts, target: POOL_CENTER })
  await waitFrames(page, 2)
}

test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.describe('S3a 风格化水面走查', () => {
  test('AC4 白沫探针:aFoam 只出现在邻岸格(逐面与世界状态比对)', async ({ page }) => {
    const errors = await openWorld(page)
    const probe = await page.evaluate(() => {
      const engine = window.__voxelEngine!
      const meshes = (engine.renderer as unknown as {
        sectionMeshes: Map<string, { opaque: unknown; translucent: { geometry: {
          getAttribute(name: string): { count: number; getX(i: number): number; getY(i: number): number }
        } } | null }>
      }).sectionMeshes
      const world = engine.world!
      const registry = engine.registry!
      let checked = 0
      let mismatchCount = 0
      const mismatches: string[] = []
      for (const { translucent } of meshes.values()) {
        if (!translucent) continue
        const geo = translucent.geometry
        const pos = geo.getAttribute('position') as unknown as { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number }
        const nor = geo.getAttribute('normal')
        const water = geo.getAttribute('aWater')
        const foam = geo.getAttribute('aFoam')
        for (let f = 0; f < pos.count; f += 4) {
          if (water.getX(f) < 0.5 || nor.getY(f) !== 1) continue // 只看水面顶面
          let minX = Infinity, minY = Infinity, minZ = Infinity
          for (let v = f; v < f + 4; v++) {
            minX = Math.min(minX, pos.getX(v))
            minY = Math.min(minY, pos.getY(v))
            minZ = Math.min(minZ, pos.getZ(v))
          }
          const cx = Math.floor(minX), cy = Math.round(minY - 0.875), cz = Math.floor(minZ)
          let expected = 0
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const t = registry.get(world.getBlock({ x: cx + dx, y: cy, z: cz + dz }))
            if (!t || t.category !== 'fluid') { expected = 1; break }
          }
          for (let v = f; v < f + 4; v++) {
            checked++
            if (foam.getX(v) !== expected) {
              mismatchCount++
              if (mismatches.length < 5) mismatches.push(`${cx},${cy},${cz} expected=${expected} got=${foam.getX(v)}`)
            }
          }
        }
      }
      return { checked, mismatchCount, mismatches }
    })
    expect(probe.checked).toBeGreaterThan(0)
    expect(probe.mismatchCount, probe.mismatches.join('; ')).toBe(0)
    expect(errors).toEqual([])
  })

  test('AC3 反射随昼夜天气:四时刻截图 + uSkyReflect/uWaterShallow 探针', async ({ page }) => {
    const errors = await openWorld(page)
    await aimAtPool(page, { theta: Math.PI * 0.3, phi: 0.9, distance: 16 })

    await setTime(page, 0.5)
    await shot(page, 'water-noon')
    const noonReflect = await page.evaluate(() => ({ ...window.__voxelEngine!.renderer.shaderUniforms.uSkyReflect.value }))

    await setTime(page, 0.72)
    await shot(page, 'water-dusk')
    const duskReflect = await page.evaluate(() => ({ ...window.__voxelEngine!.renderer.shaderUniforms.uSkyReflect.value }))

    await setTime(page, 0)
    await shot(page, 'water-midnight')
    const midnightReflect = await page.evaluate(() => ({ ...window.__voxelEngine!.renderer.shaderUniforms.uSkyReflect.value }))

    // 反射色随昼夜变化(正午亮 vs 午夜暗;黄昏偏暖 → r 占比上升)
    const lum = (c: { r: number; g: number; b: number }) => 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
    expect(lum(noonReflect)).toBeGreaterThan(lum(midnightReflect) * 2)
    expect(duskReflect.r / Math.max(1e-6, lum(duskReflect))).toBeGreaterThan(noonReflect.r / Math.max(1e-6, lum(noonReflect)))

    // 雨天反射转灰:压暗且饱和度下降
    await setTime(page, 0.5)
    await page.evaluate(() => window.__voxelEngine!.setWeather({ rain: 1 }))
    await page.waitForTimeout(1500)
    await waitFrames(page, 2)
    await shot(page, 'water-rain')
    const rainReflect = await page.evaluate(() => ({ ...window.__voxelEngine!.renderer.shaderUniforms.uSkyReflect.value }))
    expect(lum(rainReflect)).toBeLessThan(lum(noonReflect))
    expect(errors).toEqual([])
  })

  test('AC7 数据驱动:改 palette.keyframes 水色 → uniform 同步(s02a 先例)', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    const before = await page.evaluate(() => ({ ...window.__voxelEngine!.renderer.shaderUniforms.uWaterShallow.value }))
    await page.evaluate(() => {
      for (const kf of window.__voxelEngine!.palette!.keyframes) kf.waterShallow = [0.9, 0.1, 0.1]
    })
    await waitFrames(page, 2)
    const after = await page.evaluate(() => ({ ...window.__voxelEngine!.renderer.shaderUniforms.uWaterShallow.value }))
    expect(after.r).toBeGreaterThan(before.r + 0.3)
    expect(after.r).toBeCloseTo(0.9, 1)
    expect(errors).toEqual([])
  })

  test('AC6 编辑联动:挖岸边水 → 网格/白沫即时更新 → 放回', async ({ page }) => {
    const errors = await openWorld(page)
    await aimAtPool(page, { theta: Math.PI * 0.75, phi: 0.8, distance: 14 })
    await setTime(page, 0.5)
    await shot(page, 'edit-water-before')

    // 挖掉池角一格水 (32,1,30)
    await page.evaluate((p) => {
      window.__voxelPerf!.timedEdit([{ kind: 'set-block', at: { x: p.x0, y: p.y, z: p.z0 }, block: 'air' }])
    }, POOL)
    await waitFrames(page, 2)
    const dug = await page.evaluate((p) => {
      const engine = window.__voxelEngine!
      const trace = (engine as unknown as { lastEditTrace: { sections: number } | null }).lastEditTrace
      return { block: engine.world!.getBlock({ x: p.x0, y: p.y, z: p.z0 }), sections: trace?.sections ?? 0 }
    }, POOL)
    expect(dug.block).toBe('air')
    expect(dug.sections).toBeGreaterThan(0) // 走了增量重建管线
    await shot(page, 'edit-water-after-dig')

    // 放回原格 → 水面与白沫恢复(探针复查该格顶面 foam=1:池角邻非流体)
    await page.evaluate((p) => {
      window.__voxelPerf!.timedEdit([{ kind: 'set-block', at: { x: p.x0, y: p.y, z: p.z0 }, block: 'water' }])
    }, POOL)
    await waitFrames(page, 2)
    const restored = await page.evaluate((p) => {
      const engine = window.__voxelEngine!
      const meshes = (engine.renderer as unknown as {
        sectionMeshes: Map<string, { translucent: { geometry: { getAttribute(n: string): { count: number; getX(i: number): number; getY(i: number): number; getZ(i: number): number } } } | null }>
      }).sectionMeshes
      for (const { translucent } of meshes.values()) {
        if (!translucent) continue
        const pos = translucent.geometry.getAttribute('position')
        const nor = translucent.geometry.getAttribute('normal')
        const foam = translucent.geometry.getAttribute('aFoam')
        for (let v = 0; v < pos.count; v++) {
          if (Math.abs(pos.getX(v) - p.x0) < 1e-6 && Math.abs(pos.getY(v) - (p.y + 0.875)) < 1e-6 &&
              Math.abs(pos.getZ(v) - p.z0) < 1e-6 && nor.getY(v) === 1) {
            return { block: engine.world!.getBlock({ x: p.x0, y: p.y, z: p.z0 }), foam: foam.getX(v) }
          }
        }
      }
      return { block: engine.world!.getBlock({ x: p.x0, y: p.y, z: p.z0 }), foam: -1 }
    }, POOL)
    expect(restored.block).toBe('water')
    expect(restored.foam).toBe(1)
    await shot(page, 'edit-water-after-restore')
    expect(errors).toEqual([])
  })

  test('AC5 水下雾效(orbit):相机没入 → 雾+pass 生效,浮出恢复', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    // 相机探入池内:target 池心、近距离低仰角 → 眼位低于下沉水面 1.875
    await aimAtPool(page, { theta: Math.PI * 0.25, phi: 1.4, distance: 2 })
    const cam = await page.evaluate(() => ({ ...window.__voxelEngine!.cameraRig.camera.position }))
    const camCell = await page.evaluate((c) => window.__voxelEngine!.world!.getBlock({ x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) }), cam)
    expect(camCell).toBe('water')
    expect(cam.y).toBeLessThan(POOL.y + 0.875)

    await page.waitForTimeout(500) // 平滑收敛(~150ms 时间常数,SwiftShader 补余量)
    await waitFrames(page, 3)
    const under = await page.evaluate(() => ({
      strength: window.__voxelEngine!.underwaterStrength,
      passEnabled: (window.__voxelEngine!.renderer as unknown as { post: { underwater: { enabled: boolean } } }).post.underwater.enabled,
    }))
    expect(under.strength).toBeGreaterThan(0.9)
    expect(under.passEnabled).toBe(true)
    await shot(page, 'orbit-underwater')

    // 拉出水面 → 强度回落、pass 关闭(零开销)
    await aimAtPool(page, { theta: Math.PI * 0.25, phi: 0.9, distance: 16 })
    await page.waitForTimeout(500)
    await waitFrames(page, 3)
    const surfaced = await page.evaluate(() => ({
      strength: window.__voxelEngine!.underwaterStrength,
      passEnabled: (window.__voxelEngine!.renderer as unknown as { post: { underwater: { enabled: boolean } } }).post.underwater.enabled,
    }))
    expect(surfaced.strength).toBeLessThan(0.05)
    expect(surfaced.passEnabled).toBe(false)
    await shot(page, 'orbit-surface')
    expect(errors).toEqual([])
  })

  test('AC5 水下雾效(walk):深挖池角走入,眼位没入/走出恢复', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    // 池角加高一格水 → 局部 2 格深(水面 2.875),走入后眼位 2.62 没入
    await page.evaluate(() => {
      window.__voxelPerf!.timedEdit([
        { kind: 'set-block', at: { x: 36, y: 2, z: 33 }, block: 'water' },
        { kind: 'set-block', at: { x: 37, y: 2, z: 33 }, block: 'water' },
        { kind: 'set-block', at: { x: 36, y: 2, z: 34 }, block: 'water' },
        { kind: 'set-block', at: { x: 37, y: 2, z: 34 }, block: 'water' },
      ])
    })
    // 注视点移到池边 → 切第一视角
    await page.evaluate(() => {
      (window.__voxelEngine!.cameraRig as unknown as { orbit: { setTarget(t: { x: number; y: number; z: number }): void } })
        .orbit.setTarget({ x: 34, y: 1, z: 33 })
    })
    await page.getByTestId('voxel-mode-toggle').click()
    await waitFrames(page, 2)
    expect(await page.evaluate(() => (window.__voxelEngine as unknown as { cameraMode: string }).cameraMode)).toBe('walk')

    // 传送进深水角,等物理落地
    await page.evaluate(() => {
      const rig = window.__voxelEngine!.cameraRig as unknown as {
        active: { player: { state: { position: { x: number; y: number; z: number } } } }
      }
      rig.active.player.state.position.x = 36.5
      rig.active.player.state.position.z = 33.5
      rig.active.player.state.position.y = 3.2
    })
    await page.waitForTimeout(800)
    await waitFrames(page, 3)
    const under = await page.evaluate(() => ({
      strength: window.__voxelEngine!.underwaterStrength,
      cam: { ...window.__voxelEngine!.cameraRig.camera.position },
    }))
    expect(under.cam.y).toBeLessThan(2 + 0.875) // 眼位低于深水水面
    expect(under.strength).toBeGreaterThan(0.9)
    await shot(page, 'walk-underwater')

    // 走出水池(传送回池边空地) → 恢复
    await page.evaluate(() => {
      const rig = window.__voxelEngine!.cameraRig as unknown as {
        active: { player: { state: { position: { x: number; y: number; z: number } } } }
      }
      rig.active.player.state.position.x = 30.5
      rig.active.player.state.position.z = 33.5
      rig.active.player.state.position.y = 2.5
    })
    await page.waitForTimeout(800)
    await waitFrames(page, 3)
    const surfaced = await page.evaluate(() => window.__voxelEngine!.underwaterStrength)
    expect(surfaced).toBeLessThan(0.05)
    await shot(page, 'walk-surface')
    expect(errors).toEqual([])
  })

  test('AC2/N3 reduced-motion:uMotion=0,动画静止,画面正常', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = await openWorld(page)
    await aimAtPool(page, { theta: Math.PI * 0.3, phi: 0.9, distance: 16 })
    await setTime(page, 0.5)
    const motion = await page.evaluate(() => window.__voxelEngine!.renderer.shaderUniforms.uMotion.value)
    expect(motion).toBe(0)
    await shot(page, 'reduced-motion-water')
    expect(errors).toEqual([])
  })
})
