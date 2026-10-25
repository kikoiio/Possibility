import { useReducer } from 'react';
import type { ConfirmPayload, Draft, EditProposal } from '@wispiva/contract';
import { editorReducer, initialEditorState } from './state.js';

export type EditorPanelProps = {
  draft?: Draft | null;
  proposal?: EditProposal | null;
  onCreateDraft: () => Draft | Promise<Draft>;
  onProposeEdit: (input: { draftId: string; instruction: string }) => EditProposal | Promise<EditProposal>;
  onConfirm: (payload: ConfirmPayload) => void | Promise<void>;
};

export function EditorPanel({ draft: suppliedDraft, proposal: suppliedProposal, onCreateDraft, onProposeEdit, onConfirm }: EditorPanelProps) {
  const [state, dispatch] = useReducer(editorReducer, initialEditorState);
  const draft = suppliedDraft ?? state.draft;
  const proposal = suppliedProposal ?? state.proposal;

  async function createDraft() {
    dispatch({ type: 'draft-created', draft: await onCreateDraft() });
  }
  async function propose() {
    if (draft === null || draft === undefined || state.instruction.trim() === '') return;
    dispatch({ type: 'proposal-received', proposal: await onProposeEdit({ draftId: draft.id, instruction: state.instruction.trim() }) });
  }
  async function confirm() {
    if (draft === null || draft === undefined || proposal === null || proposal === undefined || state.ifText.trim() === '') return;
    await onConfirm({ draftId: draft.id, proposalId: proposal.proposalId, ifText: state.ifText.trim(), ...(state.lineName.trim() ? { name: state.lineName.trim() } : {}) });
    dispatch({ type: 'confirmed' });
  }

  return (
    <section aria-label="编辑器" className="editor-panel">
      <h2>编辑世界</h2>
      {draft === null || draft === undefined ? (
        <button type="button" onClick={() => void createDraft()}>创建草稿</button>
      ) : (
        <>
          <p>草稿基于 revision：{draft.baseRevisionId ?? '创世'}</p>
          <label>编辑指令<textarea value={state.instruction} onChange={(event) => dispatch({ type: 'instruction-changed', value: event.target.value })} /></label>
          <button type="button" disabled={!state.instruction.trim()} onClick={() => void propose()}>生成提议</button>
        </>
      )}
      {proposal && (
        <section aria-label="提议预览">
          <h3>修改提议</h3>
          <p>{proposal.summary}</p>
          <ul aria-label="变更路径">{proposal.changedPaths.map((path) => <li key={path} data-changed-path>{path}</li>)}</ul>
          <label>如果<textarea value={state.ifText} onChange={(event) => dispatch({ type: 'if-text-changed', value: event.target.value })} /></label>
          <label>新分支线名<input value={state.lineName} onChange={(event) => dispatch({ type: 'line-name-changed', value: event.target.value })} /></label>
          <button type="button" disabled={!state.ifText.trim()} onClick={() => void confirm()}>确认并分岔</button>
        </section>
      )}
      {state.stage === 'confirmed' && <p role="status">已确认分岔。</p>}
    </section>
  );
}
