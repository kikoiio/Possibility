import { afterEach, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { timelineAnchors, timelines } from '../db/schema'
import { createWorldFixture, WORLD_TIME } from '../test/world-fixture'
import { runTick } from './tick'

// 捕获失败语义的可控开关:fail=true 时 captureDailyAnchor 抛错
const captureControl = { fail: false }
vi.mock('../world-state/anchors', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../world-state/anchors')>()
  return {
    ...mod,
    captureDailyAnchor: (...args: Parameters<typeof mod.captureDailyAnchor>) =>
      captureControl.fail ? Promise.reject(new Error('injected capture failure')) : mod.captureDailyAnchor(...args),
  }
})

let fixture: Awaited<ReturnType<typeof createWorldFixture>> | null = null
afterEach(() => {
  vi.useRealTimers()
  captureControl.fail = false
  fixture?.close()
  fixture = null
})

// 单拍最多推进 150 真实秒且单拍 clock_advance 上限 24 模拟小时;
// WORLD_SPEED=500 → 单拍 20.8 模拟小时,从 08:00 跨日界且不触限
async function tickAcrossDay() {
  fixture = await createWorldFixture()
  const realAnchor = new Date()
  vi.useFakeTimers()
  vi.setSystemTime(new Date(realAnchor.getTime() + 200_000))
  await fixture.db.update(timelines).set({ lastRealTickAt: realAnchor.toISOString() }).where(eq(timelines.id, 'home-main'))
  const env = { ...fixture.env, WORLD_SPEED: '500', DIRECTOR_LLM: '0' }
  return runTick(env, fixture.db)
}

it('跨日界 tick 捕获日界锚点且幂等', async () => {
  await tickAcrossDay()
  const timeline = (await fixture!.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
  const anchors = await fixture!.db.select().from(timelineAnchors).where(eq(timelineAnchors.timelineId, 'home-main'))
  expect(anchors).toHaveLength(1)
  expect(anchors[0].simDay).toBe(timeline.simNow.slice(0, 10))
  expect(anchors[0].simTime).toBe(timeline.simNow)
  expect(anchors[0].payloadJson.length).toBeGreaterThan(2)

  // 同拍再次运行(同一世界日内推进)不产生新锚点
  vi.setSystemTime(new Date(Date.now() + 10_000))
  await runTick({ ...fixture!.env, WORLD_SPEED: '500', DIRECTOR_LLM: '0' }, fixture!.db)
  const after = await fixture!.db.select().from(timelineAnchors).where(eq(timelineAnchors.timelineId, 'home-main'))
  expect(after.length).toBeGreaterThanOrEqual(1)
  expect(new Set(after.map((a) => a.simDay)).size).toBe(after.length)
})

it('锚点捕获失败不中断 tick', async () => {
  captureControl.fail = true
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const result = await tickAcrossDay()
  expect(warn).toHaveBeenCalled()
  // tick 正常完成:时钟已推进,锚点缺失
  const timeline = (await fixture!.db.select().from(timelines).where(eq(timelines.id, 'home-main')).get())!
  expect(timeline.simNow > WORLD_TIME).toBe(true)
  expect(result?.worlds.length).toBeGreaterThan(0)
  expect(await fixture!.db.select().from(timelineAnchors).all()).toEqual([])
  warn.mockRestore()
})
