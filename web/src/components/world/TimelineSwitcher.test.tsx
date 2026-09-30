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
