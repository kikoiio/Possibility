import { describe, expect, it } from 'vitest'
import { contemporaryTheme } from '@possibility/scene-contract'
import type { SceneDocument } from '@possibility/scene-contract'
import { createSceneEditorState, sceneEditorReducer } from './editorState'
const doc: SceneDocument = { schemaVersion: 1, themeId: contemporaryTheme.id, size: { columns: 10, rows: 10 }, version: 0, terrain: [], paths: [], objects: [], lockedObjectIds: [], lockedAreas: [] }
const add = { type: 'add_object' as const, object: { id: 'a', assetId: 'bench', position: { x: 1, y: 1 }, binding: null, label: null, purpose: null } }
describe('scene editor state', () => {
  it('keeps committed data immutable and supports undo/redo', () => {
    const initial = createSceneEditorState(doc); const edited = sceneEditorReducer(initial, { type: 'operation', operation: add, catalog: contemporaryTheme })
    expect(initial.committed.objects).toHaveLength(0); expect(edited.committed.objects).toHaveLength(1)
    const undone = sceneEditorReducer(edited, { type: 'undo' }); expect(undone.committed.objects).toHaveLength(0)
    expect(sceneEditorReducer(undone, { type: 'redo' }).committed.objects).toHaveLength(1)
  })
  it('drops unconfirmed previews outside creation mode and after cancel', () => {
    const preview = sceneEditorReducer(createSceneEditorState(doc), { type: 'preview', result: { document: doc, changes: { added: [], moved: [], updated: [], removed: [] } }, operations: [add] })
    expect(preview.committed.objects).toHaveLength(0)
    expect(sceneEditorReducer(preview, { type: 'cancel_preview' }).committed.objects).toHaveLength(0)
    expect(sceneEditorReducer(preview, { type: 'mode', mode: 'life' }).preview).toBeNull()
  })
})
