import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompatibilityContinuation } from '../../scene/compatibility-store'
import { sceneCompatibilityApi } from '../../api/client'
import { Pager, SceneCompatibilityPanel } from './SceneCompatibilityPanel'

const issue = (index: number) => ({
  id: `issue-${index}`, code: 'scene-invalid', origin: 'existing' as const, category: 'structure' as const,
  spaceId: 'main', summary: `问题 ${index}`, suggestion: '查看结构', blocking: true as const,
})

const change = (index: number) => ({
  id: `change-${index}`, issueIds: [`issue-${index}`], kind: 'set-block' as const, spaceId: 'main', at: { x: index, y: 1, z: 2 },
  fromBlock: 'stone', toBlock: 'air', summary: `变化 ${index}`,
})

function continuation(): CompatibilityContinuation {
  const issues = Array.from({ length: 20 }, (_, index) => issue(index))
  const changes = Array.from({ length: 20 }, (_, index) => change(index))
  return {
    version: 1,
    scope: { actorKey: 'owner', worldId: 'world-1' },
    state: 'preview', requestId: 'request-1', draftId: 'draft-1', purpose: 'restore-history',
    target: { kind: 'history', version: 2 }, expectedCurrentVersion: 3, nextAttempt: null,
    source: { worldId: 'world-1', version: 2, contentHash: 'hash' },
    basis: null,
    inspection: null,
    draft: {
      id: 'draft-1', worldId: 'world-1', purpose: 'restore-history', target: { kind: 'history', version: 2 },
      status: 'ready', previewSpaces: [{ spaceId: 'main', name: '主空间' }], canConfirm: true,
      changes: { items: changes, offset: 0, limit: 20, total: 25, hasMore: true },
      report: {
        status: 'invalid', issueCount: 27, countIsExact: true, stopReason: null, checkedSpaceIds: ['main'],
        pendingSpaceIds: [], workUnitsUsed: 10, elapsedMs: 2,
        issues: { items: issues, offset: 0, limit: 20, total: 27, countIsExact: true, hasMore: true },
        ruleNotes: {
          items: Array.from({ length: 64 }, (_, index) => ({ code: 'furniture-cavity' as const, spaceId: 'main', objectId: `item-${index}`, at: { x: index, y: 1, z: 1 }, message: `规则 ${index}` })),
          total: 70, hasMore: true,
        },
      },
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    failure: null, receipt: null, message: null, updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as CompatibilityContinuation
}

afterEach(() => vi.unstubAllGlobals())

describe('SceneCompatibilityPanel server paging', () => {
  it('renders the default first 20 items and the 64-note truncation disclosure', () => {
    const html = renderToStaticMarkup(createElement(SceneCompatibilityPanel, {
      continuation: continuation(), canEdit: true, onClose: () => {},
    }))
    expect(html).toContain('问题 0')
    expect(html).toContain('问题 19')
    expect(html).not.toContain('问题 20')
    expect(html).toContain('本次修复变化（25 项）')
    expect(html).toContain('规则说明仅显示前 64 条，共 70 条')
    expect(html).toContain('场景几何属于世界共享；恢复不会切换各时间线的生活记录或时间')
  })

  it('requests the next page offset from the independent pager control', () => {
    let requestedOffset = -1
    const tree = Pager({ offset: 0, limit: 20, total: 27, hasMore: true, onPage: offset => { requestedOffset = offset } }) as ReactElement<{
      children: ReactElement<{ onClick: () => void }>[]
    }>
    tree.props.children[2].props.onClick()
    expect(requestedOffset).toBe(20)

    const lastPage = renderToStaticMarkup(createElement(Pager, { offset: 20, limit: 20, total: 27, hasMore: false, onPage: () => {} }))
    expect(lastPage).toContain('2 / 2')
    expect(lastPage).toContain('disabled=""')
  })

  it('does not expose confirmation for an incomplete report with a truncated issue count', () => {
    const pending = continuation()
    const previousDraft = pending.draft!
    const previousReport = previousDraft.report!
    pending.state = 'diagnosed'
    pending.draft = {
      ...previousDraft,
      status: 'blocked',
      canConfirm: false,
      report: {
        ...previousReport,
        status: 'incomplete',
        issueCount: 256,
        countIsExact: false,
        stopReason: 'issue-limit',
        issues: { ...previousReport.issues, total: 256, countIsExact: false, hasMore: false },
      },
    }
    const html = renderToStaticMarkup(createElement(SceneCompatibilityPanel, {
      continuation: pending, canEdit: true, onClose: () => {},
    }))
    expect(html).toContain('检查未完成，不能确认保存')
    expect(html).not.toContain('确认保存为新版本')
  })

  it('keeps a complete report with hidden blocking issues blocked after the visible page', () => {
    const pending = continuation()
    const previousDraft = pending.draft!
    const previousReport = previousDraft.report!
    pending.state = 'diagnosed'
    pending.draft = {
      ...previousDraft,
      status: 'blocked',
      canConfirm: false,
      report: {
        ...previousReport,
        status: 'invalid',
        issueCount: 65,
        countIsExact: true,
        stopReason: null,
        issues: { ...previousReport.issues, total: 65, countIsExact: true, hasMore: true },
      },
    }
    const html = renderToStaticMarkup(createElement(SceneCompatibilityPanel, {
      continuation: pending, canEdit: true, onClose: () => {},
    }))
    expect(html).toContain('发现阻断问题')
    expect(html).toContain('问题 19')
    expect(html).not.toContain('问题 20')
    expect(html).not.toContain('确认保存为新版本')
  })

  it('serializes independent issue and change offsets to the real GET endpoint', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('localStorage', { getItem: () => null, removeItem: () => {} })
    vi.stubGlobal('fetch', fetchMock)
    await sceneCompatibilityApi.readDraft('world-1', 'draft-1', { page: { limit: 20, issuesOffset: 20, changesOffset: 0 } })
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/worlds/world-1/scene/compatibility/drafts/draft-1?limit=20&issuesOffset=20&changesOffset=0')
  })
})
