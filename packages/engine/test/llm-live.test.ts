import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Memory, PlannedEvent, WorldState } from '@wispiva/contract';
import { openSettingsStore } from '../src/llm/settings.js';
import { probeModels } from '../src/llm/probe.js';
import { runAbMemoryExperiment } from '../src/llm/abtest.js';
import type { LlmGateway } from '../src/llm/index.js';
import { Runtime } from '../src/runtime/index.js';
import { openStore } from '../src/store/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('LLM settings store', () => {
  it('persists settings with private permissions and rejects invalid model arrays', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wispiva-settings-'));
    tempDirs.push(directory);
    const path = join(directory, 'config.json');
    const store = await openSettingsStore({ path });
    const next = { ...store.settings, models: ['model-a', 'model-b'], apiKey: 'private-key' };
    await store.writeSettings(next);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ models: ['model-a', 'model-b'], apiKey: 'private-key' });
    const reopened = await openSettingsStore({ path });
    expect(reopened.settings.models).toEqual(['model-a', 'model-b']);
    expect(reopened.settings.apiKey).toBe('private-key');
    await expect(store.writeSettings({ ...next, models: [] })).rejects.toThrow('models');

    const runtimeStore = await openStore(join(directory, 'runtime.sqlite'));
    const gateway: LlmGateway = {
      beat: async () => { throw new Error('unused'); },
      edit: async () => { throw new Error('unused'); },
    };
    const runtime = new Runtime({
      store: runtimeStore,
      gateway,
      settings: store.settings,
      writeSettings: store.writeSettings,
      projectWorld: () => ({ view: {
        lineId: 'line', revisionId: 'revision', worldTimeMinutes: 0,
        places: [], characters: [], others: [], recentText: null,
      } }),
    });
    await runtime.updateSettings({ models: ['runtime-model'] });
    expect((await openSettingsStore({ path })).settings.models).toEqual(['runtime-model']);
    await runtimeStore.close();

    chmodSync(path, 0o644);
    await openSettingsStore({ path });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe('model connectivity probe', () => {
  it('returns working models in order and classifies HTTP, network, and auth failures', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 200 }))
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('', { status: 404 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockRejectedValueOnce(new Error('offline'));

    const result = await probeModels({
      models: ['ok', 'auth', 'missing', 'limited', 'down', 'other-http', 'offline'],
      baseUrl: 'https://llm.example/v1/',
      apiKey: 'secret',
      fetch: fetchMock,
    });

    expect(result).toEqual({
      available: ['ok'],
      failures: [
        { model: 'auth', code: 'unauthorized', status: 401 },
        { model: 'missing', code: 'not_found', status: 404 },
        { model: 'limited', code: 'rate_limited', status: 429 },
        { model: 'down', code: 'unavailable', status: 503 },
        { model: 'other-http', code: 'http_error', status: 500 },
        { model: 'offline', code: 'network_error', message: 'offline' },
      ],
    });
    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://llm.example/v1/chat/completions');
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ model: 'ok', max_tokens: 1 });
  });
});

describe('memory A/B experiment', () => {
  it('reports paired runs from the same world and collects events and strategy memories', async () => {
    const initialWorld: WorldState = { entities: { ada: { kind: 'character' }, well: { kind: 'place' } }, count: 0 };
    const memory: Memory = { id: 'm1', owner: 'ada', text: 'Bo hid the truth.', valence: -0.8, intensity: 0.9, importance: 8, about: ['well'] };
    const gateway: LlmGateway = {
      beat: vi.fn(async (input) => {
        const event: PlannedEvent = {
          id: `event-${input.lineId}-${input.worldTimeMinutes}`,
          atMinutes: input.worldTimeMinutes + 1,
          text: input.memoryRows.length ? `reacted-${input.memoryRows[0]?.valence}` : 'first-meeting',
          ops: [{ op: 'set', path: '/count', value: input.worldTimeMinutes + 1 }],
          memories: input.memoryRows.length ? [] : [memory],
        };
        return {
          callId: `call-${input.lineId}-${input.worldTimeMinutes}`,
          plan: { fromMinutes: input.worldTimeMinutes, toMinutes: event.atMinutes + 1, events: [event], callId: `call-${input.lineId}-${input.worldTimeMinutes}` },
        };
      }),
      edit: vi.fn(),
    };

    const report = await runAbMemoryExperiment({
      initialWorld,
      gateway,
      runsPerArm: 2,
      applyEvent(world, event) {
        const next = structuredClone(world);
        for (const operation of event.ops) {
          if (operation.op === 'set' && operation.path === '/count' && typeof operation.value === 'number') {
            next.count = operation.value;
          }
        }
        return next;
      },
    });

    expect(report).toMatchObject({ schemaVersion: 1, runsPerArm: 2, initialWorld });
    expect(report.arms.map((arm) => arm.strategy)).toEqual(['biased', 'neutral']);
    expect(report.arms.map((arm) => arm.events)).toEqual([
      [{ beat: 1, text: 'first-meeting' }, { beat: 2, text: 'reacted--0.8' }],
      [{ beat: 1, text: 'first-meeting' }, { beat: 2, text: 'reacted-0' }],
    ]);
    expect(report.arms[0].memories[0]).toMatchObject({ valence: -0.8, intensity: 0.9 });
    expect(report.arms[1].memories[0]).toMatchObject({ valence: 0, intensity: 0 });
    expect(report.arms.map((arm) => arm.finalWorld.count)).toEqual([2, 2]);
    expect(gateway.beat).toHaveBeenCalledTimes(4);
    await expect(runAbMemoryExperiment({
      initialWorld, gateway, runsPerArm: 0, applyEvent: (world) => world,
    })).rejects.toThrow('positive integer');
  });
});
