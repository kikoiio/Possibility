import { describe, expect, it } from 'vitest'
import { canonicalScene, hashScene } from '../src/hashing'
import type { SceneDocument } from '../src/types'
const base: SceneDocument = { schemaVersion: 1, themeId: 'test', size: { columns: 2, rows: 2 }, version: 1, terrain: [{ x: 1, y: 0, assetId: 'a' }, { x: 0, y: 0, assetId: 'b' }], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] }
describe('scene hashing', () => {
  it('ignores semantically irrelevant array ordering', async () => { const other = structuredClone(base); other.terrain.reverse(); expect(canonicalScene(base)).toBe(canonicalScene(other)); expect(await hashScene(base)).toBe(await hashScene(other)) })
  it('changes when content including Unicode changes', async () => { const other = structuredClone(base); other.objects.push({ id: '人', assetId: 'person', position: { x: 0, y: 0 }, binding: null, label: '茶馆', purpose: null }); expect(await hashScene(base)).not.toBe(await hashScene(other)) })
})
