import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import ForkCompareHint from './ForkCompareHint'

function renderHint() {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ForkCompareHint, {
    worldId: 'world-1', sourceId: 'timeline-main', newId: 'timeline-fork', onDismiss: () => {},
  })))
}

describe('ForkCompareHint（S2/F6 分叉成功横幅）', () => {
  it('渲染文案与两个操作', () => {
    const html = renderHint()
    expect(html).toContain('分叉成功')
    expect(html).toContain('并排看看')
    expect(html).toContain('data-testid="fork-compare-hint"')
    expect(html).toContain('data-testid="fork-compare-hint-dismiss"')
  })

  it('并排看看深链到分屏：左源右新', () => {
    const html = renderHint()
    expect(html).toContain('timeline=timeline-main')
    expect(html).toContain('mode=possibility')
    expect(html).toContain('right=timeline-fork')
  })

  it('窄屏隐藏（sm 以下 hidden）', () => {
    const html = renderHint()
    expect(html).toContain('hidden')
    expect(html).toContain('sm:flex')
  })
})

it('本次创建摘要包含名称和假设，刷新失败时保留摘要并提供重试', () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(ForkCompareHint, {
    worldId: 'world', sourceId: 'source', newId: 'new', name: '准时的信', whatIf: '如果信提前到达',
    actionSummary: '已向 Ada 传递消息', refreshError: '列表尚未更新', onRetry: () => {}, onCompare: () => {}, onDismiss: () => {},
  })))
  expect(html).toContain('准时的信')
  expect(html).toContain('假设：如果信提前到达')
  expect(html).toContain('已执行：已向 Ada 传递消息')
  expect(html).toContain('重试刷新时间线')
  expect(html).toContain('disabled=""')
  expect(html).not.toContain('Checkpoint')
})
