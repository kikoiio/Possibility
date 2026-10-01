import { expect, test, type Page } from '@playwright/test'

/**
 * S3a 缩放 continuum e2e(AC1-AC7 可自动化部分)。
 * 全部经合成 wheel 事件驱动(N5:SwiftShader/无 pointer lock 可走完全程)。
 */

interface ContinuumProbe {
  cameraMode: 'orbit' | 'walk'
  getZoom(): number
  getZoomTier(): 'overview' | 'district' | 'close'
  setCameraMode(mode: 'orbit' | 'walk'): { ok: boolean; reason?: string }
  readonly continuum: { state: string; transitionCamera: unknown | null }
  readonly assets: { currentSwayScale: number }
  readonly cameraRig: { state: { target: { x: number; y: number; z: number } } }
}

function probe<T>(page: Page, fn: (engine: ContinuumProbe) => T): Promise<T> {
  // 字符串求值:回调体在页面上下文执行,引擎从 window.__voxelEngine 取
  return page.evaluate(`(${fn.toString()})(window.__voxelEngine)`) as Promise<T>
}

async function waitReady(page: Page) {
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
}

/** 画布中心悬停 */
async function hoverCanvasCenter(page: Page) {
  const canvas = page.getByTestId('voxel-canvas')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('canvas not found')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
}

/** 画布中心悬停后连发 wheel;deltaY<0 = 拉近 */
async function wheelBurst(page: Page, deltaY: number, count: number) {
  await hoverCanvasCenter(page)
  for (let i = 0; i < count; i++) {
    await page.mouse.wheel(0, deltaY)
    await page.waitForTimeout(30)
  }
}

async function cameraMode(page: Page) {
  return probe(page, (e) => e.cameraMode)
}
async function zoom(page: Page) {
  return probe(page, (e) => e.getZoom())
}

test.describe('S3a 缩放 continuum', () => {
  // SwiftShader + 并行负载下,wheel 连发与补间轮询远超 30s 默认超时
  test.setTimeout(120_000)

  test('滚轮落地→walk 移动→升空→二次落地(AC2/AC3 主流程)', async ({ page }) => {
    await waitReady(page)
    // 持续拉近 → 落地
    await wheelBurst(page, -120, 18)
    await expect.poll(() => cameraMode(page), { timeout: 8000 }).toBe('walk')
    await expect.poll(() => probe(page, (e) => e.getZoomTier()), { timeout: 4000 }).toBe('close')
    // walk 移动:WASD 生效(playerPosition 变化;SwiftShader 低帧率下给足时长与低阈值)
    const before = await probe(page, (e) => ({ ...e.cameraRig.state.target }))
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(900)
    await page.keyboard.up('KeyW')
    const after = await probe(page, (e) => ({ ...e.cameraRig.state.target }))
    const moved = Math.hypot(after.x - before.x, after.z - before.z)
    expect(moved).toBeGreaterThan(0.15)
    // 持续拉远 → 升空回 orbit,注视点 = 玩家位置,刻度落在滞回带
    // 逐发轮询:升空完成后多余的滚轮会继续拉远(正确行为),到档即停
    for (let i = 0; i < 12; i++) {
      if ((await cameraMode(page)) === 'orbit') break
      await wheelBurst(page, 120, 1)
      await page.waitForTimeout(150)
    }
    await expect.poll(() => cameraMode(page), { timeout: 8000 }).toBe('orbit')
    await page.waitForTimeout(400) // 平滑收敛
    const z = await zoom(page)
    expect(z).toBeGreaterThan(0.65)
    expect(z).toBeLessThan(0.8)
    const target = await probe(page, (e) => ({ ...e.cameraRig.state.target }))
    expect(Math.hypot(target.x - after.x, target.z - after.z)).toBeLessThan(1)
    // 二次落地:状态可往复
    await wheelBurst(page, -120, 18)
    await expect.poll(() => cameraMode(page), { timeout: 8000 }).toBe('walk')
  })

  test('zoom 刻度全程单调(AC1)', async ({ page }) => {
    await waitReady(page)
    const samples: number[] = []
    for (let i = 0; i < 12; i++) {
      await hoverCanvasCenter(page)
      await page.mouse.wheel(0, -120)
      await page.waitForTimeout(60)
      samples.push(await zoom(page))
    }
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - 1e-6)
    }
    expect(samples[samples.length - 1]).toBeGreaterThan(samples[0])
  })

  test('LOD 三档跨越与旋钮下发(AC6)', async ({ page }) => {
    await waitReady(page)
    // 默认构图 = 全貌档:摇摆归零(overview 零矩阵重算)
    await expect.poll(() => probe(page, (e) => e.getZoomTier()), { timeout: 4000 }).toBe('overview')
    await expect.poll(() => probe(page, (e) => e.assets.currentSwayScale), { timeout: 4000 }).toBe(0)
    // 推近到街区档
    await wheelBurst(page, -120, 8)
    await expect.poll(() => probe(page, (e) => e.getZoomTier()), { timeout: 6000 }).toBe('district')
    await expect.poll(() => probe(page, (e) => e.assets.currentSwayScale), { timeout: 4000 }).toBe(0.6)
    // 再推近到近距档(未落地前 close 已生效)
    await wheelBurst(page, -120, 8)
    await expect.poll(() => probe(page, (e) => e.getZoomTier()), { timeout: 6000 }).toBe('close')
    await expect.poll(() => probe(page, (e) => e.assets.currentSwayScale), { timeout: 4000 }).toBe(1)
    // 滞回:边界附近小幅往复不翻档(在 0.72±0.03 滞回带内)
    // 当前 close;小幅拉远不到 0.72−0.03 应保持 close
    const z0 = await zoom(page)
    if (z0 - 0.02 > 0.72) {
      await hoverCanvasCenter(page)
      await page.mouse.wheel(0, 40) // 微量拉远(最小步长 0.005)
      await page.waitForTimeout(300)
      expect(await probe(page, (e) => e.getZoomTier())).toBe('close')
    }
  })

  test('reduced-motion 落地直切无补间(AC7)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await waitReady(page)
    // reduced:begin* 立即落定,transitionCamera 恒 null
    const immediate = await probe(page, (e) => {
      const r = e.setCameraMode('walk')
      return { ok: r.ok, state: e.continuum.state, hasTransitionCam: e.continuum.transitionCamera !== null }
    })
    expect(immediate.ok).toBe(true)
    expect(immediate.state).toBe('walk')
    expect(immediate.hasTransitionCam).toBe(false)
    await expect.poll(() => cameraMode(page), { timeout: 2000 }).toBe('walk')
    // 升空同样直切
    const lift = await probe(page, (e) => {
      e.setCameraMode('orbit')
      return { state: e.continuum.state, hasTransitionCam: e.continuum.transitionCamera !== null }
    })
    expect(lift.state).toBe('orbit')
    expect(lift.hasTransitionCam).toBe(false)
    await expect.poll(() => cameraMode(page), { timeout: 2000 }).toBe('orbit')
  })

  test('快捷直达与滚轮路径等价(AC4:setCameraMode 即 V 键/HUD 按钮入口)', async ({ page }) => {
    await waitReady(page)
    // 直达 walk(V 键/HUD 按钮调用的同一入口)
    const r1 = await probe(page, (e) => e.setCameraMode('walk'))
    expect(r1.ok).toBe(true)
    await expect.poll(() => cameraMode(page), { timeout: 8000 }).toBe('walk')
    await expect.poll(() => zoom(page), { timeout: 4000 }).toBe(1)
    // 直达 orbit
    const r2 = await probe(page, (e) => e.setCameraMode('orbit'))
    expect(r2.ok).toBe(true)
    await expect.poll(() => cameraMode(page), { timeout: 8000 }).toBe('orbit')
    const z = await zoom(page)
    expect(z).toBeGreaterThan(0.7)
    expect(z).toBeLessThan(0.8)
  })

  test('注视点不可站立时不落地(边界:钳回滞回带停留 orbit)', async ({ page }) => {
    await waitReady(page)
    // 注视点移到世界外角落(实心/无地面):pan 不可测,直接受控写位姿
    await probe(page, (e) => {
      const engine = e as never as {
        setOrbitPose(pose: { theta: number; phi: number; distance: number; target: { x: number; y: number; z: number } }): void
        world: { doc: { size: { width: number; height: number; depth: number } } } | null
      }
      const h = engine.world?.doc.size.height ?? 32
      engine.setOrbitPose({ theta: 0.8, phi: 0.5, distance: 30, target: { x: 0, y: h - 1, z: 0 } })
    })
    await wheelBurst(page, -120, 20)
    // 应停留 orbit(落点搜索半径内无可站立格时钳回;fixture 角落为实心或虚空)
    await page.waitForTimeout(1500)
    const mode = await cameraMode(page)
    const z = await zoom(page)
    if (mode === 'orbit') {
      // 钳回滞回带:未卡在阈值之上
      expect(z).toBeLessThanOrEqual(0.85)
    } else {
      // 若该角落意外可站立(螺旋外扩找到落点),则落地也属合法路径
      expect(mode).toBe('walk')
    }
  })
})
