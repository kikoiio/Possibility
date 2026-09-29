import { expect, test, type Page } from '@playwright/test'
import { mkdirSync } from 'node:fs'

/**
 * S1 渲染基底 · T13 视觉验收走查（checklist AC1–AC7 / 端到端场景 1–3）。
 * 截图输出到 docs/spec_docs/voxel-visual-upgrade/s01-render-foundation/walkthrough/。
 * 该目录被 .gitignore 忽略，仅作本地验收证据。
 */

const SHOTS = '../docs/spec_docs/voxel-visual-upgrade/s01-render-foundation/walkthrough'
mkdirSync(SHOTS, { recursive: true })

/** 页面内引擎探针的最小类型（window.__voxelEngine 是完整 VoxelEngine） */
interface EngineProbe {
  setTimeOfDay(t: number): void
  setWeather(state: Record<string, number>): void
  world: {
    getBlock(p: { x: number; y: number; z: number }): string
    doc: { size: { width: number; height: number; depth: number } }
  } | null
  palette: { keyframes: Array<Record<string, number>> } | null
  renderer: {
    post: { enabled: boolean } | null
    shaderUniforms: { uMotion: { value: number } }
  }
}

declare global {
  interface Window { __voxelEngine?: EngineProbe }
}

async function openWorld(page: Page) {
  const errors: string[] = []
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()) })
  page.on('pageerror', (err) => errors.push(String(err)))
  await page.goto('/dev/voxel')
  await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
  await page.waitForTimeout(600) // 等几帧渲染稳定
  return errors
}

async function setTime(page: Page, t: number) {
  await page.evaluate((v) => window.__voxelEngine!.setTimeOfDay(v), t)
  await page.waitForTimeout(350)
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: `${SHOTS}/${name}.png` })
}

/** 拖动旋转相机：dx>0 → theta 减小；dy<0 → 抬平视线（phi 增大，看到更多地平线天空） */
async function dragCamera(page: Page, dx: number, dy: number) {
  const canvas = page.getByTestId('voxel-canvas')
  const box = (await canvas.boundingBox())!
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + dx, cy + dy, { steps: 12 })
  await page.mouse.up()
  await page.waitForTimeout(250)
}

/** 滚轮拉近（每格 ×0.9） */
async function zoomIn(page: Page, ticks: number) {
  const canvas = page.getByTestId('voxel-canvas')
  const box = (await canvas.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, -400)
    await page.waitForTimeout(80)
  }
  await page.waitForTimeout(250)
}

// AC1 测试会改写调色源文件触发 vite 热更新，必须串行避免干扰其他用例
test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.describe('S1 T13 视觉走查', () => {
  test('场景1「一天」: 正午/黄昏/午夜天空全程连续，无渲染报错（AC4）', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    await shot(page, 'day-noon')
    await setTime(page, 0.74)
    await shot(page, 'day-dusk')
    await setTime(page, 0.0)
    await shot(page, 'day-midnight')
    await setTime(page, 0.5)
    expect(errors).toEqual([])
  })

  test('AC2 后处理：夜晚泛光开/关对比，关闭后无报错', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0)
    await shot(page, 'post-on-midnight')
    await page.evaluate(() => { window.__voxelEngine!.renderer.post!.enabled = false })
    await page.waitForTimeout(350)
    await shot(page, 'post-off-midnight')
    await page.evaluate(() => { window.__voxelEngine!.renderer.post!.enabled = true })
    expect(errors).toEqual([])
  })

  test('场景2「编辑即时性」: 挖墙 → AO/光照立即更新 → 补回（AC3/AC6）', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    // 找离世界中心最近、南侧暴露的实心墙块（镜头对准中心，保证入画）
    const target = await page.evaluate(() => {
      const engine = window.__voxelEngine!
      if (!engine.world) return null
      const { width, height, depth } = engine.world.doc.size
      let best: { x: number; y: number; z: number; id: string } | null = null
      let bestScore = Infinity
      for (let y = 1; y < Math.min(height, 8); y++)
        for (let x = 2; x < width - 2; x++)
          for (let z = 2; z < depth - 2; z++) {
            const id = engine.world!.getBlock({ x, y, z })
            if (id === 'air' || id === 'water') continue
            if (engine.world!.getBlock({ x, y, z: z + 1 }) !== 'air') continue
            const score = Math.abs(x - width / 2) + Math.abs(z - depth / 2) + y
            if (score < bestScore) { bestScore = score; best = { x, y, z, id } }
          }
      return best
    })
    expect(target).not.toBeNull()
    await zoomIn(page, 6) // 拉近看 AO 与挖掘更新
    await shot(page, 'edit-before')
    await page.evaluate((p) => {
      window.__voxelPerf!.timedEdit([
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z }, block: 'air' },
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z + 1 }, block: p.id },
      ])
    }, target!)
    await page.waitForTimeout(350)
    await shot(page, 'edit-after-dig')
    await page.evaluate((p) => {
      window.__voxelPerf!.timedEdit([
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z }, block: p.id },
        { kind: 'set-block', at: { x: p.x, y: p.y, z: p.z + 1 }, block: 'air' },
      ])
    }, target!)
    await page.waitForTimeout(350)
    await shot(page, 'edit-after-restore')
    expect(errors).toEqual([])
  })

  test('场景3「雨天黄昏」+ AC5 雪天：氛围在新管线下正常', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.72)
    await page.evaluate(() => window.__voxelEngine!.setWeather({ rain: 1 }))
    await page.waitForTimeout(1500) // 天气强度 lerp 爬升
    await shot(page, 'weather-rain-dusk')
    await page.evaluate(() => window.__voxelEngine!.setWeather({ rain: 0, snow: 1 }))
    await page.waitForTimeout(1500)
    await shot(page, 'weather-snow-dusk')
    await page.evaluate(() => window.__voxelEngine!.setWeather({ snow: 0 }))
    expect(errors).toEqual([])
  })

  test('AC4 天体：清晨东方见太阳盘、黄昏后东方见月亮盘、午夜星空（抬平视线）', async ({ page }) => {
    const errors = await openWorld(page)
    // 抬平视线（phi → 上限）并转向东方（太阳/月亮升起方向）
    await dragCamera(page, 294, -82)
    await setTime(page, 0.28) // 清晨，太阳低垂于东方
    await shot(page, 'sun-disk-morning')
    await setTime(page, 0.78) // 黄昏后，月亮低垂于东方
    await shot(page, 'moon-disk-evening')
    await setTime(page, 0.0) // 午夜星空
    await shot(page, 'midnight-stars-low')
    expect(errors).toEqual([])
  })

  test('AC1 色彩单一数据源：改调色数据正午天色 → 天色/雾色同步变化', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    await shot(page, 'ac1-noon-baseline')
    const palettePath = `${process.cwd()}/src/voxel/engine/palettes/mist-manor.ts`
    const fs = await import('node:fs')
    const original = fs.readFileSync(palettePath, 'utf-8')
    // 正午档 skyZenith/skyHorizon/fogColor → 醒目异色（品红）
    // （S2a 起关键帧在 elevation 与 skyZenith 之间插入了直射光字段，正则容许中间行）
    const modified = original.replace(
      /(elevation: 1,(?:\n\s+\w+:[^\n]*)*\n\s+skyZenith: )\[[^\]]+\](,\n\s+skyHorizon: )\[[^\]]+\](,\n\s+fogColor: )\[[^\]]+\]/,
      '$1[0.9, 0.1, 0.8]$2[0.95, 0.3, 0.85]$3[0.95, 0.3, 0.85]',
    )
    expect(modified).not.toBe(original)
    try {
      fs.writeFileSync(palettePath, modified)
      await page.waitForTimeout(1200) // vite 热更新
      await page.goto('/dev/voxel')
      await expect(page.getByTestId('voxel-loading')).toBeHidden({ timeout: 15000 })
      await page.evaluate(() => window.__voxelEngine!.setTimeOfDay(0.5))
      await page.waitForTimeout(500)
      await shot(page, 'ac1-noon-magenta')
      // 探针确认：雾色同步变为品红（天色与雾色同源）
      const fogHex = await page.evaluate(() => {
        const scene = (window.__voxelEngine as unknown as { renderer: { scene: { fog: { color: { getHexString(): string } } } } }).renderer.scene
        return scene.fog.color.getHexString()
      })
      const r = parseInt(fogHex.slice(0, 2), 16), b = parseInt(fogHex.slice(4, 6), 16)
      expect(r).toBeGreaterThan(150)
      expect(b).toBeGreaterThan(120)
    } finally {
      fs.writeFileSync(palettePath, original)
    }
    expect(errors).toEqual([])
  })

  test('AC7 reduced-motion：uMotion=0，云漂移与颗粒静止', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const errors = await openWorld(page)
    await setTime(page, 0.5)
    const motion = await page.evaluate(() => window.__voxelEngine!.renderer.shaderUniforms.uMotion.value)
    expect(motion).toBe(0)
    await shot(page, 'reduced-motion-noon')
    expect(errors).toEqual([])
  })

  test('N3 可调优：调色数据单项归零，对应效果单独消失', async ({ page }) => {
    const errors = await openWorld(page)
    await setTime(page, 0)
    // 直接改运行时调色数据（applyPalette 每帧采样，等价于改数据文件后刷新）
    const zeroField = async (field: string, name: string) => {
      const originals = await page.evaluate((f) => {
        const kfs = window.__voxelEngine!.palette!.keyframes
        const saved = kfs.map((kf) => kf[f])
        for (const kf of kfs) kf[f] = 0
        return saved
      }, field)
      await page.waitForTimeout(250)
      await shot(page, name)
      await page.evaluate(([f, saved]) => {
        const kfs = window.__voxelEngine!.palette!.keyframes
        kfs.forEach((kf, i) => { kf[f] = saved[i] })
      }, [field, originals] as [string, number[]])
    }
    await zeroField('bloomStrength', 'n3-bloom-off')
    await zeroField('vignette', 'n3-vignette-off')
    await zeroField('grain', 'n3-grain-off')
    expect(errors).toEqual([])
  })
})
