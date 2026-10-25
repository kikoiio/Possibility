import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Draft, LlmCall, Memory, Revision, WorldLine, WorldState } from '@wispiva/contract';
import { openStore, type Store } from '../src/store/index.js';

const world: WorldState = { entities: { 阿苇: { kind: 'character' }, 书院: { kind: 'place' } } };
const origin: Revision = {
  id: 'rev-origin', parentId: null, worldTimeMinutes: 0,
  event: { id: 'evt-origin', kind: 'origin', text: '村庄醒来。', atMinutes: 0 }, world,
};

function line(overrides: Partial<WorldLine> = {}): WorldLine {
  return {
    id: 'line-a', name: 'α', parentLineId: null, forkRevisionId: null, forkTimeMinutes: null,
    headRevisionId: origin.id, worldTimeMinutes: 0, speed: 24, paused: false, plan: null,
    status: 'ready', error: null, retryAt: 0, ...overrides,
  };
}

function call(overrides: Partial<LlmCall> = {}): LlmCall {
  return {
    id: 'call-a', kind: 'beat', lineId: 'line-a', baseRevisionId: 'rev-origin', startMinutes: 0,
    status: 'pending', messages: [{ role: 'user', content: '推进故事' }], attempts: [], startedAt: 10,
    ...overrides,
  };
}

function memory(id: string, owner: string, text: string): Memory {
  return { id, owner, text, valence: 0.2, intensity: 0.4, importance: 4, about: ['书院'] };
}

describe('store', () => {
  let root: string;
  let dbPath: string;
  let store: Store;

  beforeEach(async () => {
    const tempRoot = resolve('.tmp/store-test');
    mkdirSync(tempRoot, { recursive: true });
    root = mkdtempSync(join(tempRoot, 'case-'));
    dbPath = join(root, 'store.sqlite');
    store = await openStore(dbPath);
  });

  afterEach(async () => {
    await store.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('commits and rolls back T1/T4 metadata and call changes atomically', async () => {
    await store.createLine(line());
    await store.createCall(call());
    await store.transaction(async (tx) => {
      await tx.updateLine('line-a', { status: 'generating', plan: { fromMinutes: 0, toMinutes: 30, events: [], callId: 'call-a' } });
      await tx.updateCall('call-a', { status: 'accepted' });
    });
    expect((await store.getLine('line-a'))?.status).toBe('generating');
    expect((await store.getCall('call-a'))?.status).toBe('accepted');
    await expect(store.transaction(async (tx) => {
      await tx.updateLine('line-a', { name: 'partial' });
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect((await store.getLine('line-a'))?.name).toBe('α');
    await expect(store.transaction((tx) => tx.transaction(async () => undefined))).rejects.toThrow('Nested transactions');
  });

  it('appends T2 revisions and line head atomically, and pages the parent chain backward', async () => {
    await store.createLine(line());
    await store.appendRevisions('line-a', [origin]);
    const rev1: Revision = {
      id: 'rev-1', parentId: 'rev-origin', worldTimeMinutes: 10,
      event: { id: 'evt-1', kind: 'story', text: '阿苇走进书院。', atMinutes: 10 }, world,
    };
    const rev2: Revision = {
      id: 'rev-2', parentId: 'rev-1', worldTimeMinutes: 20,
      event: { id: 'evt-2', kind: 'chat', text: '她问候了老舟。', atMinutes: 20 }, world,
    };
    await store.appendRevisions('line-a', [rev1, rev2]);
    expect(await store.getRevision('rev-2')).toEqual(rev2);
    expect(await store.getLine('line-a')).toMatchObject({ headRevisionId: 'rev-2', worldTimeMinutes: 20 });
    expect(await store.pageLog('line-a', { limit: 2 })).toMatchObject({
      entries: [{ id: 'rev-2' }, { id: 'rev-1' }], nextBeforeRevisionId: 'rev-1',
    });
    expect(await store.pageLog('line-a', { beforeRevisionId: 'rev-1', limit: 2 })).toMatchObject({
      entries: [{ id: 'rev-origin' }], nextBeforeRevisionId: null,
    });
    const invalid: Revision = { ...rev2, id: 'rev-broken', parentId: 'wrong-parent' };
    await expect(store.appendRevisions('line-a', [invalid])).rejects.toThrow('does not extend');
    expect((await store.getLine('line-a'))?.headRevisionId).toBe('rev-2');
  });

  it('persists T3 drafts and deletes them', async () => {
    const draft: Draft = {
      id: 'draft-a', lineId: 'line-a', baseRevisionId: 'rev-origin', worldTimeMinutes: 0,
      speed: 24, paused: false, world, createdAt: 123,
    };
    await store.createDraft(draft);
    expect(await store.getDraft('draft-a')).toEqual(draft);
    await store.deleteDraft('draft-a');
    expect(await store.getDraft('draft-a')).toBeNull();
  });

  it('isolates memories by line and owner, indexes Chinese text, and versions reflections', async () => {
    await store.createLine(line({ worldTimeMinutes: 525 }));
    await store.appendMemories('line-a', [memory('mem-wei', '阿苇', '阿苇记得在书院门口听见潮声。'), memory('mem-zhou', '老舟', '书院的钟声提醒老舟回家。')], 'evt-library');
    const results = await store.searchMemoryText('line-a', ['阿苇'], '阿苇', 10);
    expect(results.map((row) => row.id)).toEqual(['mem-wei']);
    expect(await store.searchMemoryText('line-a', ['阿苇'], '书院', 10)).toHaveLength(1);
    expect(await store.searchMemoryText('line-a', ['阿苇'], '书院门口', 10)).toHaveLength(1);
    expect(await store.searchMemoryText('line-a', ['老舟'], '阿苇', 10)).toHaveLength(0);
    expect((await store.getMemories('line-a', ['阿苇'], 10))[0]).toMatchObject({ sourceEventId: 'evt-library', atMinutes: 525 });
    await store.touchMemories(['mem-wei'], 530);
    expect((await store.getMemories('line-a', ['阿苇'], 10))[0].lastAccessedMinutes).toBe(530);

    const reflection = { lineId: 'line-a', owner: '阿苇', version: 99, text: '我记得书院。', fromMinutes: 0, toMinutes: 525, generatedAt: 600 };
    await store.saveReflection(reflection);
    await store.saveReflection({ ...reflection, version: 100, text: '潮声仍在耳边。', generatedAt: 700 });
    expect(await store.getReflection('line-a', '阿苇')).toMatchObject({ version: 2, text: '潮声仍在耳边。' });
  });

  it('marks pending calls failed and generating lines ready after reopen', async () => {
    await store.createLine(line({ status: 'generating' }));
    await store.createCall(call());
    await store.close();
    store = await openStore(dbPath);
    expect(await store.getCall('call-a')).toMatchObject({ status: 'failed', error: 'Process restarted while call was in flight.' });
    expect((await store.getLine('line-a'))?.status).toBe('ready');
  });
});
