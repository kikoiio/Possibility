import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { TimelineInfo } from '../../api/types'
import ComparePanel from './ComparePanel'

const timelines = [
  { id: 'other', parentTimelineId: 'main', simNow: '2026-10-01T00:00:00Z', forkScenario: { whatIf: '旧假设' } },
  { id: 'new', parentTimelineId: 'main', simNow: '2026-10-01T00:00:00Z', forkScenario: { name: '新分支', whatIf: '新的假设' } },
  { id: 'main', parentTimelineId: null, simNow: '2026-10-01T00:00:00Z', forkScenario: null },
] as TimelineInfo[]

describe('ComparePanel 指定本次创建比较对象', () => {
  it('显式来源/新线优先于 current、parent 和列表首项，展示新旧可读标签', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ComparePanel, { worldId: 'world', currentTimelineId: 'other', timelines, initialLeftTimelineId: 'main', initialRightTimelineId: 'new', onClose: () => {} })))
    const selects = [...html.matchAll(/<select[^>]*>(.*?)<\/select>/g)]
    expect(selects[0][1]).toContain('value="main" selected=""')
    expect(selects[1][1]).toContain('value="new" selected=""')
    expect(html).toContain('新分支 · 新的假设')
    expect(html).toContain('旧假设')
  })
  it('普通手动入口保持 current/parent 默认比较', () => {
    const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ComparePanel, { worldId: 'world', currentTimelineId: 'other', timelines, onClose: () => {} })))
    const selects = [...html.matchAll(/<select[^>]*>(.*?)<\/select>/g)]
    expect(selects[0][1]).toContain('value="other" selected=""')
    expect(selects[1][1]).toContain('value="main" selected=""')
  })
})
