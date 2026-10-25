import type { Draft, EditProposal } from '@wispiva/contract';

export type EditorState = {
  stage: 'empty' | 'draft' | 'proposal' | 'confirmed';
  draft: Draft | null;
  proposal: EditProposal | null;
  instruction: string;
  ifText: string;
  lineName: string;
};

export type EditorAction =
  | { type: 'draft-created'; draft: Draft }
  | { type: 'instruction-changed'; value: string }
  | { type: 'proposal-received'; proposal: EditProposal }
  | { type: 'if-text-changed'; value: string }
  | { type: 'line-name-changed'; value: string }
  | { type: 'confirmed' };

export const initialEditorState: EditorState = {
  stage: 'empty', draft: null, proposal: null, instruction: '', ifText: '', lineName: '',
};

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'draft-created': return { ...state, stage: 'draft', draft: action.draft, proposal: null };
    case 'instruction-changed': return { ...state, instruction: action.value };
    case 'proposal-received': return { ...state, stage: 'proposal', proposal: action.proposal };
    case 'if-text-changed': return { ...state, ifText: action.value };
    case 'line-name-changed': return { ...state, lineName: action.value };
    case 'confirmed': return { ...state, stage: 'confirmed' };
  }
}
