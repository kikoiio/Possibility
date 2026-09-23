import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import type { PersonFocus } from '../../api/types'
import PersonDrawer from './PersonDrawer'

const memory: PersonFocus['memories'][number] = {
  id: 'memory-1', type: 'relationship', content: 'We met at the harbor.', simTime: '2026-09-23T09:00:00.000Z',
  createdAt: '2026-09-23T09:00:00.000Z', importance: 5, summarized: false,
}

function renderDrawer(canEditMemories: boolean, memories = [memory], canChat = true) {
  const focus: PersonFocus = {
    person: { id: 'resident-1', name: 'Resident' }, state: null, thoughts: [], schedule: null, memories,
  }
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PersonDrawer, {
    focus, loading: false, liveState: null, fallbackName: 'Resident', personId: 'resident-1', canChat, canEditMemories,
    timelineId: 'timeline-1', expectedVersion: 0, defaultTab: 'memories', onClose: () => {},
  })))
}

describe('PersonDrawer memory controls', () => {
  it('renders memories read-only outside construct mode', () => {
    const html = renderDrawer(false)
    expect(html).toContain('We met at the harbor.')
    expect(html).toContain('观察与在场模式下只能查看')
    expect(html).not.toContain('校正这条记忆')
    expect(html).not.toContain('删除这条记忆')
  })

  it('offers correction and forgetting only for editable, non-summary memories', () => {
    const html = renderDrawer(true)
    expect(html).toContain('这是 TA 真正记住的事')
    expect(html).toContain('校正这条记忆')
    expect(html).toContain('删除这条记忆')

    const summaryHtml = renderDrawer(true, [{ ...memory, id: 'summary-1', type: 'summary', summarized: true }])
    expect(summaryHtml).not.toContain('校正这条记忆')
    expect(summaryHtml).not.toContain('删除这条记忆')
  })

  it('shows a normal chat entry only when the world view allows interaction', () => {
    const interactive = renderDrawer(false)
    expect(interactive).toContain('普通聊天')
    expect(interactive).toContain('href="/people/resident-1?timeline=timeline-1"')
    expect(renderDrawer(false, [memory], false)).not.toContain('普通聊天')
  })
})
