import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Draft, EditProposal } from '@wispiva/contract';
import { EditorPanel } from '../src/editor/EditorPanel.js';
import { editorReducer, initialEditorState } from '../src/editor/state.js';

const draft: Draft = { id: 'draft_1', lineId: null, baseRevisionId: null, worldTimeMinutes: 0, speed: 24, paused: false, world: { entities: {} }, createdAt: 1 };
const proposal: EditProposal = { schemaVersion: 1, proposalId: 'proposal_1', draftId: 'draft_1', baseRevisionId: 'rev_1', ops: [], summary: '让书院在午后开放。', changedPaths: ['/entities/书院/open'], memories: [] };

describe('editor panel', () => {
  it('renders draft controls and the proposal diff preview', () => {
    const html = renderToString(React.createElement(EditorPanel, {
      draft, proposal,
      onCreateDraft: () => draft,
      onProposeEdit: vi.fn(),
      onConfirm: vi.fn(),
    }));
    expect(html).toContain('编辑指令');
    expect(html).toContain('让书院在午后开放。');
    expect(html).toContain('/entities/书院/open');
    expect(html).toContain('确认并分岔');
  });

  it('tracks draft → proposal → confirmed flow and keeps branch inputs', () => {
    const afterDraft = editorReducer(initialEditorState, { type: 'draft-created', draft });
    const afterProposal = editorReducer(afterDraft, { type: 'proposal-received', proposal });
    const withInputs = editorReducer(editorReducer(afterProposal, { type: 'if-text-changed', value: '如果书院提早开放' }), { type: 'line-name-changed', value: '午后开放' });
    const confirmed = editorReducer(withInputs, { type: 'confirmed' });
    expect(confirmed.stage).toBe('confirmed');
    expect(confirmed.proposal?.changedPaths).toEqual(['/entities/书院/open']);
    expect(confirmed.ifText).toBe('如果书院提早开放');
    expect(confirmed.lineName).toBe('午后开放');
  });
});
