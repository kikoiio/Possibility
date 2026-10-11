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

const issueCases = [
  ['invalid-envelope', 'format', false], ['invalid-document', 'format', false], ['invalid-json', 'format', false],
  ['unsupported-format', 'format', false], ['unsupported-version', 'format', false], ['unsupported-size', 'format', false],
  ['unsupported-document-version', 'format', false], ['invalid-document-envelope', 'format', false], ['missing-spaces', 'format', false],
  ['missing-default-space', 'format', false], ['invalid-space-entry', 'format', false], ['unknown-default-space', 'format', false],
  ['scene-missing', 'structure', false], ['scene-corrupt', 'format', false], ['scene-invalid', 'structure', false],
  ['out-of-bounds', 'structure', false], ['unknown-block', 'structure', false], ['floating-object', 'structure', false],
  ['object-overlap', 'structure', false], ['locked-violation', 'binding', false], ['invalid-meta', 'structure', false],
  ['asset-collision', 'asset', false], ['asset-unsupported', 'asset', false], ['asset-overlap', 'asset', false], ['unknown-asset', 'asset', false],
  ['binding-mismatch', 'binding', false], ['missing-location', 'binding', false], ['missing-resident', 'binding', false],
  ['location-unbound', 'binding', false], ['connection-invalid', 'connection', false],
  ['walk-clearance', 'walkability', false], ['walk-connectivity', 'walkability', false], ['walk-lighting', 'walkability', false],
  ['walk-stairs', 'walkability', false], ['walk-gap', 'walkability', false],
  ['context-unavailable', 'structure', true], ['budget-exceeded', 'structure', true], ['deadline', 'structure', true], ['cancelled', 'structure', true],
] as const

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
    await sceneCompatibilityApi.readDraft('world-1', { timelineId: 'timeline-1', representation: 'voxel' }, 'draft-1', { page: { limit: 20, issuesOffset: 20, changesOffset: 0 } })
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/worlds/world-1/scene/compatibility/drafts/draft-1?timelineId=timeline-1&representation=voxel&limit=20&issuesOffset=20&changesOffset=0')
  })

  it.each(issueCases)('gives %s a readable impact, saved status, suggestion, and next step', (code, category, retryable) => {
    const current = continuation()
    const report = current.draft!.report!
    const visibleIssue = {
      ...issue(100), code, category, summary: '物体 123e4567-e89b-42d3-a456-426614174000 无法通过检查。', suggestion: '请调整后重新检查。',
      spaceId: '123e4567-e89b-42d3-a456-426614174001',
      id: 'internal-issue-id', objectId: 'PRIVATE-OBJECT-UUID', placementId: 'PRIVATE-ASSET-UUID',
      origin: 'existing' as const,
    }
    current.state = 'diagnosed'
    current.draft = null
    current.inspection = { report: { ...report, status: retryable ? 'incomplete' : 'invalid', issues: { items: [visibleIssue], offset: 0, limit: 1, total: 1, countIsExact: true, hasMore: false }, issueCount: 1 }, canCreateRepairDraft: true } as unknown as CompatibilityContinuation['inspection']
    const html = renderToStaticMarkup(createElement(SceneCompatibilityPanel, {
      continuation: current, canEdit: true, onBuild: () => {}, onRecheck: () => {}, onClose: () => {},
    }))
    expect(html).toContain(category === 'format' ? '场景资料暂时无法读取。' : category === 'structure' ? '场景结构需要调整。' : category === 'asset' ? '有些物件摆放需要调整。' : category === 'binding' ? '地点或居民与场景的对应关系需要调整。' : category === 'connection' ? '地点之间的连接需要调整。' : '居民通行路线需要调整。')
    expect(html).not.toContain('123e4567-e89b-42d3-a456-426614174000')
    expect(html).not.toContain('123e4567-e89b-42d3-a456-426614174001')
    expect(html).toContain('影响：')
    expect(html).toContain('请调整后重新检查。')
    expect(html).toContain('问题来自当前已保存版本')
    expect(html).toContain(retryable ? '重新检查' : '预览修复方案')
    expect(html).toContain(retryable ? '可以重试检查' : '此问题需先修复，不能通过重试检查消除')
    expect(html).not.toContain('PRIVATE-OBJECT-UUID')
    expect(html).not.toContain('PRIVATE-ASSET-UUID')
    expect(html).not.toContain('internal-issue-id')
  })

  it('offers a retry action for incomplete checks and marks candidate issues as not written', () => {
    const current = continuation()
    const report = current.draft!.report!
    current.draft!.report = { ...report, issues: { items: [{
      ...issue(101), code: 'deadline', category: 'structure', origin: 'repair',
      summary: '检查超时。', suggestion: '可以重新检查。',
    }], offset: 0, limit: 1, total: 1, countIsExact: true, hasMore: false }, issueCount: 1 }
    const html = renderToStaticMarkup(createElement(SceneCompatibilityPanel, {
      continuation: current, canEdit: true, onBuild: () => {}, onRecheck: () => {}, onClose: () => {},
    }))
    expect(html).toContain('本次修改尚未写入')
    expect(html).toContain('重新检查')
    expect(html).toContain('可以重试检查')
  })
})
