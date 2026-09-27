import type { SceneDocument, SceneMode, SceneOperation, ScenePreviewResult, SceneThemeManifest, SceneViewport } from '@possibility/scene-contract'
import { applySceneOperations } from '@possibility/scene-contract'

export interface SceneEditorState {
  committed: SceneDocument
  preview: { result: ScenePreviewResult; operations: SceneOperation[] } | null
  pendingOperations: SceneOperation[]
  selectedObjectId: string | null
  mode: SceneMode
  saveStatus: 'clean' | 'dirty' | 'saving' | 'conflict' | 'error'
  viewport: SceneViewport
  history: SceneDocument[]
  future: SceneDocument[]
}
export type SceneEditorAction =
  | { type: 'operation'; operation: SceneOperation; catalog: SceneThemeManifest }
  | { type: 'preview'; result: ScenePreviewResult; operations: SceneOperation[] }
  | { type: 'cancel_preview' }
  | { type: 'apply_preview'; catalog: SceneThemeManifest }
  | { type: 'select'; id: string | null }
  | { type: 'mode'; mode: SceneMode }
  | { type: 'viewport'; viewport: SceneViewport }
  | { type: 'save_status'; status: SceneEditorState['saveStatus'] }
  | { type: 'saved'; document: SceneDocument }
  | { type: 'undo' }
  | { type: 'redo' }

export function createSceneEditorState(document: SceneDocument): SceneEditorState {
  return { committed: document, preview: null, pendingOperations: [], selectedObjectId: null, mode: 'create', saveStatus: 'clean', viewport: { center: { x: 0, y: 0 }, zoom: 1 }, history: [], future: [] }
}
export function sceneEditorReducer(state: SceneEditorState, action: SceneEditorAction): SceneEditorState {
  if (action.type === 'select') return { ...state, selectedObjectId: action.id }
  if (action.type === 'mode') return { ...state, mode: action.mode, preview: action.mode === 'create' ? state.preview : null }
  if (action.type === 'viewport') return { ...state, viewport: action.viewport }
  if (action.type === 'save_status') return { ...state, saveStatus: action.status }
  if (action.type === 'preview') return { ...state, preview: { result: action.result, operations: action.operations } }
  if (action.type === 'cancel_preview') return { ...state, preview: null }
  if (action.type === 'operation') {
    const result = applySceneOperations(state.committed, [action.operation], action.catalog)
    return { ...state, committed: result.document, history: [...state.history, state.committed], future: [], pendingOperations: [...state.pendingOperations, action.operation], saveStatus: 'dirty' }
  }
  if (action.type === 'apply_preview') {
    if (!state.preview) return state
    const result = applySceneOperations(state.committed, state.preview.operations, action.catalog)
    return { ...state, committed: result.document, preview: null, history: [...state.history, state.committed], future: [], pendingOperations: [...state.pendingOperations, ...state.preview.operations], saveStatus: 'dirty' }
  }
  if (action.type === 'saved') return { ...state, committed: action.document, pendingOperations: [], saveStatus: 'clean' }
  if (action.type === 'undo') {
    const previous = state.history.at(-1); if (!previous) return state
    return { ...state, committed: previous, history: state.history.slice(0, -1), future: [state.committed, ...state.future], pendingOperations: [], saveStatus: 'dirty' }
  }
  if (action.type === 'redo') {
    const next = state.future[0]; if (!next) return state
    return { ...state, committed: next, history: [...state.history, state.committed], future: state.future.slice(1), pendingOperations: [], saveStatus: 'dirty' }
  }
  return state
}
