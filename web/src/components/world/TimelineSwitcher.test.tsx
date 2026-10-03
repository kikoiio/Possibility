import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { TimelineInfo } from '../../api/types'
import TimelineSwitcher from './TimelineSwitcher'

const timelines: TimelineInfo[] = [
  { id: 'timeline-main', parentTimelineId: null, status: 'active', simNow: '2026-09-19T12:00:00.000Z', createdAt: '2026-09-18T09:00:00.000Z', forkScenario: null },
] as TimelineInfo[]

function renderSwitcher() {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(TimelineSwitcher, {
    timelines,
    currentTimelineId: 'timeline-main',
    onSwitch: () => {},
    onFork: async () => true,
    onPreview: async () => { throw new Error('should not be called on initial render') },
    onArchive: () => {},
  })))
}

describe('TimelineSwitcher 分叉弹窗（S2/F1/F5）', () => {
  it('初始展示主宇宙切换按钮，弹窗未打开', () => {
    const html = renderSwitcher()
    expect(html).toContain('主宇宙')
    expect(html).not.toContain('role="dialog"')
  })
})

it('当前分支名称优先，旧分支以假设作为名称', () => {
  for (const [scenario, expected] of [[{ name: '可读名称', whatIf: '假设' }, '可读名称'], [{ whatIf: '旧分支假设' }, '旧分支假设']] as const) {
    const branch = { ...timelines[0], id: 'branch', parentTimelineId: 'timeline-main', forkScenario: scenario } as TimelineInfo
    const html = renderToStaticMarkup(createElement(TimelineSwitcher, { timelines: [...timelines, branch], currentTimelineId: 'branch', onSwitch: () => {}, onFork: async () => true, onPreview: async () => { throw new Error('unused') }, onArchive: () => {} }))
    expect(html).toContain(`${expected} ▾`)
    expect(html).not.toContain('branch ▾')
  }
})
