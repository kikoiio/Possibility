import { describe, expect, it } from 'vitest'
import { createNative2dRepository } from './repository'
import type { Native2dLayout } from './schema'

const cells = Array.from({ length: 16 }, (_, index) => ({ x: index % 4, z: Math.floor(index / 4) }))

function layout(worldId = 'world-a', timelineId = 'timeline-a'): Native2dLayout {
  return {
    metadata: {
      schema: 'native2d-layout', schemaVersion: 1, layoutVersion: 1, sceneVersion: 3,
      worldId, timelineId, sceneId: 'manor',
      spaces: [{ spaceId: 'exterior', kind: 'exterior', width: 4, depth: 4, walkable: cells, connectivityRoot: { x: 0, z: 0 } }],
      buildings: [{ buildingId: 'house', spaceId: 'exterior', footprint: [{ x: 0, z: 0 }], entry: { x: -1, z: 0 }, locationKey: 'hall' }],
    },
    placements: [{ buildingId: 'house', spaceId: 'exterior', origin: { x: 2, z: 2 } }],
  }
}

function input(overrides: Partial<Parameters<ReturnType<typeof createNative2dRepository>['save']>[0]> = {}) {
  const value = layout()
  return { worldId: value.metadata.worldId, timelineId: value.metadata.timelineId, sceneId: value.metadata.sceneId, expectedVersion: 0, requestId: 'r1', layout: value, ...overrides }
}

describe('native2d repository', () => {
  it('saves a validated layout and advances head with CAS metadata', async () => {
    const repository = createNative2dRepository()
    const result = await repository.save(input({ now: '2026-10-06T00:00:00.000Z' }))
    expect(result).toMatchObject({ ok: true, kind: 'created', revision: { version: 1, parentVersion: null }, head: { currentVersion: 1 } })
  })

  it('replays an identical request and rejects a request id with new content', async () => {
    const repository = createNative2dRepository()
    const first = await repository.save(input())
    const replay = await repository.save(input())
    expect(replay).toMatchObject({ ok: true, kind: 'replayed', revision: { version: 1 } })
    const changed = layout()
    const changedLayout: Native2dLayout = { ...changed, placements: [{ ...changed.placements[0]!, origin: { x: 1, z: 2 } }] }
    const conflict = await repository.save(input({ layout: changedLayout }))
    expect(conflict).toMatchObject({ ok: false, kind: 'conflict', code: 'request_conflict' })
    expect(first).toMatchObject({ ok: true })
  })

  it('enforces expected-version CAS and keeps scopes isolated', async () => {
    const repository = createNative2dRepository()
    await repository.save(input())
    const stale = await repository.save(input({ expectedVersion: 0, requestId: 'r2' }))
    expect(stale).toMatchObject({ ok: false, code: 'version_conflict' })
    const other = layout('world-b', 'timeline-b')
    const saved = await repository.save({ ...input({ requestId: 'r3' }), worldId: 'world-b', timelineId: 'timeline-b', layout: other })
    expect(saved).toMatchObject({ ok: true, revision: { version: 1 } })
    expect(await repository.history({ worldId: 'world-a', timelineId: 'timeline-a', sceneId: 'manor' })).toHaveLength(1)
  })

  it('rejects invalid building and space bindings before persistence', async () => {
    const repository = createNative2dRepository()
    const invalid = layout()
    const invalidLayout: Native2dLayout = { ...invalid, metadata: { ...invalid.metadata, buildings: [{ ...invalid.metadata.buildings[0]!, spaceId: 'missing' }] } }
    const result = await repository.save(input({ layout: invalidLayout }))
    expect(result).toMatchObject({ ok: false, kind: 'invalid' })
    expect(await repository.head({ worldId: 'world-a', timelineId: 'timeline-a', sceneId: 'manor' })).toBeNull()
  })

  it('keeps the server head authoritative across an undo-style baseline save', async () => {
    const repository = createNative2dRepository()
    const initial = await repository.save(input())
    expect(initial).toMatchObject({ ok: true, head: { currentVersion: 1 } })
    const movedBase = layout()
    const moved: Native2dLayout = {
      ...movedBase,
      placements: [{ ...movedBase.placements[0]!, origin: { x: 1, z: 2 } }],
    }
    const movedResult = await repository.save(input({
      expectedVersion: 1,
      requestId: 'r2',
      layout: moved,
    }))
    expect(movedResult).toMatchObject({ ok: true, head: { currentVersion: 2 } })
    const resetResult = await repository.reset(input({
      expectedVersion: 2,
      requestId: 'r3',
      layout: layout(),
    }))
    expect(resetResult).toMatchObject({ ok: true, head: { currentVersion: 3 } })
    expect(await repository.head({ worldId: 'world-a', timelineId: 'timeline-a', sceneId: 'manor' })).toMatchObject({ currentVersion: 3 })
    expect((await repository.read({ worldId: 'world-a', timelineId: 'timeline-a', sceneId: 'manor' }))?.layout.placements[0]?.origin).toEqual({ x: 2, z: 2 })
    expect(await repository.history({ worldId: 'world-a', timelineId: 'timeline-a', sceneId: 'manor' })).toHaveLength(3)
  })

  it('does not mutate head when an invalid move is submitted', async () => {
    const repository = createNative2dRepository()
    await repository.save(input())
    const invalidBase = layout()
    const invalid: Native2dLayout = {
      ...invalidBase,
      placements: [{ ...invalidBase.placements[0]!, origin: { x: -1, z: -1 } }],
    }
    const result = await repository.save(input({ expectedVersion: 1, requestId: 'invalid-move', layout: invalid }))
    expect(result).toMatchObject({ ok: false, kind: 'invalid' })
    expect(await repository.head({ worldId: 'world-a', timelineId: 'timeline-a', sceneId: 'manor' })).toMatchObject({ currentVersion: 1 })
    expect(await repository.history({ worldId: 'world-a', timelineId: 'timeline-a', sceneId: 'manor' })).toHaveLength(1)
  })
})
