import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmCall, Plan, Revision, WorldLine, WorldState } from '@wispiva/contract';
import { createHttpApp } from '../src/http/index.js';
import { Runtime, startRuntime } from '../src/runtime/index.js';
import { openStore, type Store } from '../src/store/index.js';
import type { LlmGateway, LlmSettings } from '../src/llm/index.js';

const settings: LlmSettings = {
  models: ['test'], baseUrl: 'http://localhost', apiKey: '', segmentWorldMinutes: 60,
  minIntervalSeconds: 0, hourlyLimit: 40, dailyLimit: 200, concurrency: 2,
};
const world: WorldState = { entities: { person: { kind: 'character', name: 'Person' }, place: { kind: 'place', name: 'Place' } }, marker: 0 };
const projects = (state: WorldState, minutes: number, revisionId: string, recentText: string | null) => ({
  view: { lineId: 'line', revisionId, worldTimeMinutes: minutes, places: [], characters: [], others: [], recentText },
});

const tempDirs: string[] = [];
const openTestStore = async (): Promise<{ store: Store; path: string }> => {
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  const directory = await mkdtemp(join(process.cwd(), '.tmp/runtime-'));
  tempDirs.push(directory);
  const path = join(directory, 'runtime.sqlite');
  return { store: await openStore(path), path };
};

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function seedLine(store: Store, plan: Plan | null, options: Partial<WorldLine> = {}) {
  const revision: Revision = {
    id: 'rev_origin', parentId: null, worldTimeMinutes: 0,
    event: { id: 'evt_origin', kind: 'origin', text: 'Origin', atMinutes: 0 }, world,
  };
  const line: WorldLine = {
    id: 'line', name: 'α', parentLineId: null, forkRevisionId: null, forkTimeMinutes: null,
    headRevisionId: revision.id, worldTimeMinutes: 0, speed: 24, paused: false, plan,
    status: 'ready', error: null, retryAt: 0, ...options,
  };
  await store.createLine(line);
  await store.appendRevisions(line.id, [revision]);
  return line;
}

function gateway(store: Store, beat: LlmGateway['beat'] = async (input) => ({
  callId: 'call_beat',
  plan: { fromMinutes: input.worldTimeMinutes, toMinutes: input.worldTimeMinutes + 60, events: [], callId: 'call_beat' },
})): LlmGateway {
  return {
    beat: async (input) => {
      await store.createCall({
        id: 'call_beat', kind: 'beat', lineId: input.lineId, baseRevisionId: input.baseRevisionId,
        startMinutes: input.worldTimeMinutes, status: 'pending', messages: [], attempts: [], startedAt: Date.now(),
      });
      const result = await beat(input);
      await store.updateCall('call_beat', { status: 'accepted', finishedAt: Date.now() });
      return result;
    },
    edit: async (input) => ({
      schemaVersion: 1, proposalId: 'call_edit', draftId: input.draftId, baseRevisionId: input.baseRevisionId,
      ops: [{ op: 'set', path: '/marker', value: 1 }], summary: 'Edit', changedPaths: [], memories: [],
    }),
  };
}

describe('runtime orchestration', () => {
  it('commits due events in order at 24x time', async () => {
    const { store } = await openTestStore();
    const plan: Plan = {
      fromMinutes: 0, toMinutes: 100, callId: 'call_existing', events: [
        { id: 'evt_first', atMinutes: 1, text: 'first', ops: [{ op: 'set', path: '/marker', value: 1 }], memories: [] },
        { id: 'evt_second', atMinutes: 2, text: 'second', ops: [{ op: 'set', path: '/marker', value: 2 }], memories: [] },
        { id: 'evt_future', atMinutes: 100, text: 'future', ops: [], memories: [] },
      ],
    };
    await seedLine(store, plan);
    let now = 10_000;
    const runtime = new Runtime({ store, gateway: gateway(store), settings, projectWorld: projects, now: () => now });
    await runtime.tick();
    now += 5_000;
    await runtime.tick();
    const line = await store.getLine('line');
    const log = await store.pageLog('line', { limit: 3 });
    expect(line?.worldTimeMinutes).toBe(2);
    expect(log.entries.map((entry) => entry.event.id)).toEqual(['evt_second', 'evt_first', 'evt_origin']);
    expect((await store.getRevision(line!.headRevisionId))?.world.marker).toBe(2);
    await store.close();
  });

  it('discards a beat that returns after the line is paused', async () => {
    const { store } = await openTestStore();
    await seedLine(store, null);
    let resolveBeat!: (value: { plan: Plan; callId: string }) => void;
    const delayed = new Promise<{ plan: Plan; callId: string }>((resolve) => { resolveBeat = resolve; });
    const runtime = new Runtime({
      store, gateway: gateway(store, () => delayed), settings, projectWorld: projects, now: () => 10_000,
    });
    await runtime.tick();
    await runtime.control({ lineId: 'line', paused: true });
    resolveBeat({ plan: { fromMinutes: 0, toMinutes: 20, events: [], callId: 'call_beat' }, callId: 'call_beat' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await store.getLine('line'))?.plan).toBeNull();
    expect((await store.getCall('call_beat'))?.status).toBe('discarded');
    await store.close();
  });

  it('confirms a fork without inheriting the parent plan', async () => {
    const { store } = await openTestStore();
    const parentPlan: Plan = { fromMinutes: 0, toMinutes: 90, callId: 'old', events: [{ id: 'later', atMinutes: 60, text: 'later', ops: [], memories: [] }] };
    await seedLine(store, parentPlan);
    const runtime = new Runtime({ store, gateway: gateway(store), settings, projectWorld: projects, now: () => 50_000, createId: (prefix) => `${prefix}_${prefix === 'line' ? 'fork' : 'new'}` });
    const draft = await runtime.createDraft('line');
    const proposal = await runtime.editDraft(draft.id, 'change');
    const fork = await runtime.confirm({ draftId: draft.id, proposalId: proposal.proposalId, ifText: 'If changed.' });
    expect(fork.plan).toBeNull();
    expect(fork.parentLineId).toBe('line');
    expect((await store.getRevision(fork.headRevisionId))?.world.marker).toBe(1);
    expect((await store.getLine('line'))?.plan).toEqual(parentPlan);
    await store.close();
  });

  it('recovers in-flight work on restart without creating revisions or time', async () => {
    const { store, path } = await openTestStore();
    await seedLine(store, null, { status: 'generating', worldTimeMinutes: 12 });
    await store.updateLine('line', { worldTimeMinutes: 12 });
    await store.createCall({ id: 'call_pending', kind: 'beat', lineId: 'line', baseRevisionId: 'rev_origin', startMinutes: 12, status: 'pending', messages: [], attempts: [], startedAt: 1 });
    await store.close();
    const runtime = await startRuntime({ storePath: path, gateway: gateway({} as Store), settings, projectWorld: projects, now: () => 99_000 });
    expect((await runtime.store.getLine('line'))?.status).toBe('ready');
    expect((await runtime.store.getLine('line'))?.worldTimeMinutes).toBe(12);
    expect((await runtime.store.getCall('call_pending'))?.status).toBe('failed');
    expect((await runtime.store.pageLog('line', { limit: 10 })).entries).toHaveLength(1);
    await runtime.store.close();
  });

  it('sends the SSE snapshot before later incremental events', async () => {
    const { store } = await openTestStore();
    await seedLine(store, null);
    const runtime = new Runtime({ store, gateway: gateway(store), settings, projectWorld: projects, now: () => 10_000 });
    const response = await createHttpApp(runtime).request('/api/events');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('"type":"snapshot"');
    await runtime.control({ lineId: 'line', paused: true });
    const second = decoder.decode((await reader.read()).value);
    expect(second).toContain('"type":"line"');
    const ordered = first + second;
    expect(ordered.indexOf('"type":"snapshot"')).toBeLessThan(ordered.indexOf('"type":"line"'));
    await reader.cancel();
    await store.close();
  });
});
