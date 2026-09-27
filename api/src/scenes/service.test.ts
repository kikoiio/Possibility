import { afterEach, describe, expect, it } from 'vitest'
import { contemporaryTheme } from '@possibility/scene-contract'
import type { SceneDocument } from '@possibility/scene-contract'
import { worldSceneRevisions } from '../db/schema'
import { createWorldFixture } from '../test/world-fixture'
import { readCurrentScene, readSceneVersion, SceneConflict } from './repository'
import { restoreSceneVersion, saveSceneRevision } from './service'

function emptyScene(): SceneDocument { return { schemaVersion: 1, themeId: contemporaryTheme.id, size: { columns: 12, rows: 10 }, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] } }
const bench = (x: number) => ({ id: 'bench-1', assetId: 'bench', position: { x, y: 1 }, binding: null, label: null, purpose: null })

describe('scene persistence and revision safety', () => {
  const fixtures: Awaited<ReturnType<typeof createWorldFixture>>[] = []
  afterEach(() => fixtures.splice(0).forEach(f => f.close()))
  it('creates versions, replays idempotently, and restores as a new version', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    const first = await saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'r1', operations: [{ type: 'add_object', object: bench(1) }], running: true })
    expect(first.version).toBe(1)
    const replay = await saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'r1', operations: [{ type: 'add_object', object: bench(1) }], running: true })
    expect(replay.version).toBe(1)
    const second = await saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'r2', operations: [{ type: 'move_object', objectId: 'bench-1', to: { x: 3, y: 2 } }], running: true })
    expect(second.document.objects[0]?.position).toEqual({ x: 3, y: 2 })
    const restored = await restoreSceneVersion(f.db, { worldId: 'home-world', expectedVersion: 2, targetVersion: 1, requestId: 'r3' })
    expect(restored.version).toBe(3); expect(restored.document.objects[0]?.position).toEqual({ x: 1, y: 1 })
    expect((await readSceneVersion(f.db, 'home-world', 2))?.document.objects[0]?.position).toEqual({ x: 3, y: 2 })
  })
  it('rejects stale versions, reused IDs with new payloads, and semantic edits after running', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    await saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'first', operations: [{ type: 'add_object', object: { ...bench(1), assetId: 'cafe-corner', binding: { kind: 'location', locationName: 'Cafe' } } }], running: false })
    await expect(saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'stale', operations: [], running: true })).rejects.toBeInstanceOf(SceneConflict)
    await expect(saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'first', operations: [], running: true })).rejects.toBeInstanceOf(SceneConflict)
    await expect(saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'semantic', operations: [{ type: 'remove_object', objectId: 'bench-1' }], running: true })).rejects.toThrow('不能删除模拟地点或居民')
    expect(await f.db.select().from(worldSceneRevisions).all()).toHaveLength(1)
  })
  it('returns missing as null until a first revision is committed', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    expect(await readCurrentScene(f.db, 'home-world')).toBeNull()
    const doc = emptyScene(); doc.objects.push(bench(1))
    // A first explicit save is allowed from a whole-document operation sequence.
    const first = await saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'first-scene', operations: [{ type: 'add_object', object: bench(1) }], running: true })
    expect(first.version).toBe(1)
  })
  it('allows visual replacement that preserves a running location identity', async () => {
    const f = await createWorldFixture(); fixtures.push(f)
    await saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 0, requestId: 'place', operations: [{ type: 'add_object', object: { ...bench(1), assetId: 'home-small', binding: { kind: 'location', locationName: 'Cafe' } } }], running: false })
    const replaced = await saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'appearance', operations: [{ type: 'replace_asset', objectId: 'bench-1', assetId: 'home-row' }], running: true })
    expect(replaced.document.objects[0]).toMatchObject({ assetId: 'home-row', binding: { kind: 'location', locationName: 'Cafe' } })
    await expect(saveSceneRevision(f.db, { worldId: 'home-world', expectedVersion: 2, requestId: 'wrong-category', operations: [{ type: 'replace_asset', objectId: 'bench-1', assetId: 'person-ada' }], running: true })).rejects.toThrow('兼容的外观')
  })
})
