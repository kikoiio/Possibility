import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

/**
 * S2b 第一视角 + 可行走性 · T14 端到端走查(checklist AC1-AC4、AC9)。
 * 截图输出 docs/spec_docs/voxel-visual-upgrade/s02b-first-person-walkability/walkthrough/(gitignored)。
 * 软渲染(SwiftShader)下:pointer lock 失败时走降级视角路径(N5),截图前一律 waitFrames。
 */

const SHOTS = '../docs/spec_docs/voxel-visual-upgrade/s02b-first-person-walkability/walkthrough'
mkdirSync(SHOTS, { recursive: true })

interface WalkProbe {
  cameraMode: 'orbit' | 'walk'
  setCameraMode(m: 'orbit' | 'walk'): { ok: boolean; reason?: string }
  cameraRig: {
    camera: { position: { x: number; y: number; z: number } }
    state: { target: { x: number; y: number; z: number }; distance: number }
  }
  world: { getBlock(p: { x: number; y: number; z: number }): string } | null
  setTimeOfDay(t: number): void
}

declare global {
  interface Window {
    __voxelEngine?: WalkProbe
    __voxelInteractions?: Array<{ kind: string; detail: string }>
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

/** 等渲染循环真正走完两帧(SwiftShader 低帧率下固定延时可能截到旧帧) */
async function waitFrames(page: Page, n = 2) {
  await page.evaluate((count) => new Promise<void>((resolve) => {
    const step = (left: number) => { left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)) }
    step(count)
  }), n)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

const camPos = (page: Page) => page.evaluate(() => {
  const p = window.__voxelEngine!.cameraRig.camera.position
  return { x: p.x, y: p.y, z: p.z }
})

/** 把 orbit 注视点移到庭院空地(落点投影确定性),再切第一视角 */
async function enterWalkAtCourtyard(page: Page) {
  await page.evaluate(() => {
    const rig = window.__voxelEngine!.cameraRig as unknown as {
      orbit: { setTarget(t: { x: number; y: number; z: number }): void }
    }
    rig.orbit.setTarget({ x: 23, y: 1, z: 33 })
  })
  await page.getByTestId('voxel-mode-toggle').click()
  await waitFrames(page, 2)
}

/** 用编辑探针在 (27,z) 列搭两级台阶(供 AC2 楼梯行走;避开 x=22..24 的 y=1 石板路) */
async function buildStairs(page: Page) {
  await page.evaluate(() => {
    window.__voxelPerf!.timedEdit([
      { kind: 'set-block', at: { x: 27, y: 1, z: 37 }, block: 'stone' },
      { kind: 'set-block', at: { x: 27, y: 1, z: 38 }, block: 'stone' },
      { kind: 'set-block', at: { x: 27, y: 2, z: 38 }, block: 'stone' },
    ])
  })
  await waitFrames(page, 2)
}

test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.describe('S2b 第一视角走查', () => {
  test('AC1 切换:按钮进入第一视角,落在注视点附近地面', async ({ page }) => {
    const errors = await openWorld(page)
    await enterWalkAtCourtyard(page)
    await expect(page.getByTestId('voxel-crosshair')).toBeVisible()
    expect(await page.evaluate(() => window.__voxelEngine!.cameraMode)).toBe('walk')
    const cam = await camPos(page)
    // 落点在注视点 (23,1,33) 附近,眼位 = 地面 + 1.62
    expect(Math.abs(cam.x - 23.5)).toBeLessThanOrEqual(7)
    expect(Math.abs(cam.z - 33.5)).toBeLessThanOrEqual(7)
    expect(cam.y).toBeGreaterThan(1)
    expect(cam.y).toBeLessThan(6)
    await shot(page, 'ac1-walk-enter')
    expect(errors).toEqual([])
  })

  test('AC2 行走/跳跃/楼梯/边界', async ({ page }) => {
    const errors = await openWorld(page)
    await buildStairs(page)
    await enterWalkAtCourtyard(page)
    const start = await camPos(page)

    // W 前进(yaw=0 → -z 方向)
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(1200)
    await page.keyboard.up('KeyW')
    const moved = await camPos(page)
    expect(start.z - moved.z).toBeGreaterThan(2)

    // 传送到开阔空地(庭院东侧,无顶棚),面向 +z;等待物理落地后再测
    await page.evaluate(() => {
      const rig = window.__voxelEngine!.cameraRig as unknown as {
        active: { yaw: number; pitch: number; player: { state: { position: { x: number; y: number; z: number } } } }
      }
      rig.active.player.state.position.x = 27.5
      rig.active.player.state.position.z = 30.5
      rig.active.yaw = Math.PI // 面向 +z
      rig.active.pitch = 0
    })
    await page.waitForFunction(() => {
      const active = (window as any).__voxelEngine.cameraRig.active
      return active.player.state.onGround === true
    }, undefined, { timeout: 10000 })

    // 空格跳跃:开阔地跳起约 1.29 格。按住 Space 期间边跳边采样(落地即再跳的 bunny-hop,
    // 保证低帧率下采样窗口必命中腾空帧)
    const standY = (await camPos(page)).y
    await page.keyboard.down('Space')
    let peak = standY
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(80)
      peak = Math.max(peak, (await camPos(page)).y)
    }
    await page.keyboard.up('Space')
    expect(peak).toBeGreaterThan(standY + 0.5)

    // 走楼梯:W 上两级台阶(自动上台阶,无需跳),途中眼位峰值升高约 2 格
    await page.keyboard.down('KeyW')
    let climbPeak = standY
    for (let i = 0; i < 15; i++) {
      await page.waitForTimeout(100)
      climbPeak = Math.max(climbPeak, (await camPos(page)).y)
    }
    expect(climbPeak).toBeGreaterThan(standY + 1.5)
    await shot(page, 'ac2-stairs-top')
    // 继续向前:越过台阶走向世界边界,被钳制在界内(z ≤ 48-0.3)
    await page.waitForTimeout(4000)
    await page.keyboard.up('KeyW')
    const atEdge = await camPos(page)
    expect(atEdge.z).toBeLessThanOrEqual(47.7)
    expect(atEdge.z).toBeGreaterThan(45)
    expect(atEdge.y).toBeLessThan(4) // 已下台阶落回地面
    await shot(page, 'ac2-world-edge')
    expect(errors).toEqual([])
  })

  test('AC3 飞行:双击空格升空悬停,再双击落地', async ({ page }) => {
    const errors = await openWorld(page)
    await enterWalkAtCourtyard(page)
    const standY = (await camPos(page)).y
    // 双击空格 → 飞行
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
    await page.keyboard.press('Space')
    await waitFrames(page, 2)
    const flying = await page.evaluate(() => {
      const active = (window.__voxelEngine!.cameraRig as unknown as { active: { player: { state: { flying: boolean } } } }).active
      return active.player.state.flying
    })
    expect(flying).toBe(true)
    // 按住空格上升
    await page.keyboard.down('Space')
    await page.waitForTimeout(1200)
    await page.keyboard.up('Space')
    const highY = (await camPos(page)).y
    expect(highY).toBeGreaterThan(standY + 5)
    // 悬停:无输入 y 基本不变
    await page.waitForTimeout(400)
    expect((await camPos(page)).y).toBeCloseTo(highY, 1)
    await shot(page, 'ac3-fly-overview')
    // 再双击 → 恢复重力落地
    await page.keyboard.press('Space')
    await page.waitForTimeout(150)
    await page.keyboard.press('Space')
    await page.waitForTimeout(2500)
    expect((await camPos(page)).y).toBeCloseTo(standY, 0)
    await shot(page, 'ac3-landed')
    expect(errors).toEqual([])
  })

  test('AC4 只读:准星选中物体有反馈,编辑入口不可用', async ({ page }) => {
    const errors = await openWorld(page)
    await enterWalkAtCourtyard(page)
    // 编辑入口在第一视角不渲染
    await expect(page.getByTestId('voxel-editor')).toBeHidden()
    // 瞄准石灯笼 lantern-a (20,2,33):由眼位计算 yaw/pitch
    await page.evaluate(() => {
      const rig = window.__voxelEngine!.cameraRig as unknown as {
        active: { yaw: number; pitch: number; player: { state: { position: { x: number; y: number; z: number } } } }
      }
      const p = rig.active.player.state.position
      const eye = { x: p.x, y: p.y + 1.62, z: p.z }
      const target = { x: 20.5, y: 2.5, z: 33.5 }
      const dx = target.x - eye.x, dy = target.y - eye.y, dz = target.z - eye.z
      const len = Math.hypot(dx, dy, dz)
      rig.active.pitch = Math.asin(dy / len)
      rig.active.yaw = Math.atan2(-dx, -dz)
    })
    await waitFrames(page, 2)
    const canvas = page.getByTestId('voxel-canvas')
    const box = await canvas.boundingBox()
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2)
    await waitFrames(page, 2)
    const interactions = await page.evaluate(() => window.__voxelInteractions ?? [])
    // lantern-a 绑定地点「庭院」→ 命中走 onLocation 分支(detail 含 objectId)
    expect(interactions.some((i) => i.detail.includes('lantern-a'))).toBe(true)
    await shot(page, 'ac4-crosshair-select')
    expect(errors).toEqual([])
  })

  test('AC9 全程:游览→拨时间→V 切回→注视点跟随→世界不变', async ({ page }) => {
    const errors = await openWorld(page)
    await enterWalkAtCourtyard(page)
    // 游览:走动一段
    await page.keyboard.down('KeyW')
    await page.waitForTimeout(800)
    await page.keyboard.up('KeyW')
    // walk 中拨时间轴:帧循环照常(阴影/天色跟随玩家)
    await page.evaluate(() => window.__voxelEngine!.setTimeOfDay(0.7))
    await waitFrames(page, 3)
    await shot(page, 'ac9-walk-evening')
    const playerPos = await camPos(page)
    // V 键切回上帝视角
    await page.keyboard.press('KeyV')
    await waitFrames(page, 2)
    expect(await page.evaluate(() => window.__voxelEngine!.cameraMode)).toBe('orbit')
    await expect(page.getByTestId('voxel-crosshair')).toBeHidden()
    // 注视点跟随玩家位置
    const target = await page.evaluate(() => window.__voxelEngine!.cameraRig.state.target)
    expect(Math.abs(target.x - playerPos.x)).toBeLessThanOrEqual(1)
    expect(Math.abs(target.z - playerPos.z)).toBeLessThanOrEqual(1)
    // 世界内容未变(主楼角柱:fixture 实测 (21,1,19) = wood-log)
    expect(await page.evaluate(() => window.__voxelEngine!.world!.getBlock({ x: 21, y: 1, z: 19 }))).toBe('wood-log')
    // 编辑入口恢复
    await expect(page.getByTestId('voxel-editor')).toBeVisible()
    await shot(page, 'ac9-back-to-orbit')
    expect(errors).toEqual([])
  })
})
