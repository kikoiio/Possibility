import { describe, expect, it, vi } from 'vitest';
import type { LlmCall, LogEntry, WorldState } from '@wispiva/contract';
import { assembleBeatMessages, ContextBudgetError, scoreMemoryRows } from '../src/llm/assemble.js';
import { BudgetExhaustedError, OpenAiLlmGateway } from '../src/llm/client.js';
import type { MemoryRow, ReflectionRow } from '../src/llm/types.js';

const world: WorldState = {
  currentLocation: 'inn',
  entities: {
    inn: { kind: 'place', name: 'Inn' },
    ada: { kind: 'character', location: 'inn', name: 'Ada' },
    bo: { kind: 'character', location: 'inn', name: 'Bo' },
    bridge: { kind: 'place', name: 'Bridge' },
    ring: { kind: 'item', name: 'Ring' },
  },
};

function memory(
  id: string,
  overrides: Partial<MemoryRow> = {},
): MemoryRow {
  return {
    id, owner: 'ada', text: `memory-${id}`, valence: 0.8, intensity: 0.5,
    importance: 5, about: ['bridge'], lineId: 'line', atMinutes: 0, ...overrides,
  };
}

const input = {
  lineId: 'line', baseRevisionId: 'rev0', world,
  recentEvents: [{ id: 'rev0', parentId: null, worldTimeMinutes: 0, event: { id: 'evt0', kind: 'origin', text: 'exact event', atMinutes: 0 } }] as LogEntry[],
  memoryRows: [memory('m1'), memory('m2', { about: ['inn'], importance: 2 })],
  reflections: [{ lineId: 'line', owner: 'ada', version: 1, text: 'reflection', fromMinutes: 0, toMinutes: 10, generatedAt: 1 }] as ReflectionRow[],
  worldTimeMinutes: 120,
};

function auditStore() {
  const calls = new Map<string, LlmCall>();
  return {
    calls,
    createCall: vi.fn(async (call: LlmCall) => { calls.set(call.id, structuredClone(call)); }),
    updateCall: vi.fn(async (id: string, patch: Partial<LlmCall>) => {
      const call = calls.get(id);
      if (call) calls.set(id, { ...call, ...structuredClone(patch) });
    }),
  };
}

function settings(overrides: Partial<ConstructorParameters<typeof OpenAiLlmGateway>[0]> = {}) {
  return {
    models: ['first', 'second'], baseUrl: 'https://example.test/v1', apiKey: 'secret',
    segmentWorldMinutes: 60, minIntervalSeconds: 0, hourlyLimit: 20, dailyLimit: 20, concurrency: 2,
    ...overrides,
  };
}

function response(status: number, payload: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(payload), { status, ...(headers ? { headers } : {}) });
}

describe('llm gateway', () => {
  it('falls back only on eligible statuses and audits every request', async () => {
    const store = auditStore();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(429, { error: 'slow down' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(200, { choices: [{ message: { content: '{"fromMinutes":0,"toMinutes":1,"events":[],"callId":"x"}' } }], usage: { total_tokens: 3 } }));
    const gateway = new OpenAiLlmGateway(settings(), store, {
      fetch: fetchMock,
      now: () => Date.now(),
      sleep: async () => {},
      createId: () => 'call-test',
    });

    const result = await gateway.beat(input);

    expect(result.plan.callId).toBe('call-test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string).model).toBe('first');
    expect(JSON.parse(fetchMock.mock.calls[1]?.[1]?.body as string).model).toBe('second');
    const audit = store.calls.get('call-test');
    expect(audit?.status).toBe('accepted');
    expect(audit?.attempts.map((attempt) => attempt.status)).toEqual([429, 200]);
    expect(audit?.usage?.totalTokens).toBe(3);
  });

  it('enforces the global hourly budget and records failed calls', async () => {
    const store = auditStore();
    const fetchMock = vi.fn().mockResolvedValue(response(200, { choices: [{ message: { content: '{}' } }] }));
    const gateway = new OpenAiLlmGateway(settings({ hourlyLimit: 0 }), store, {
      fetch: fetchMock,
      createId: () => 'budget-call',
    });

    await expect(gateway.beat(input)).rejects.toBeInstanceOf(BudgetExhaustedError);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.createCall).not.toHaveBeenCalled();
  });

  it('counts model fallback attempts against the global request budget', async () => {
    vi.resetModules();
    const { OpenAiLlmGateway: IsolatedGateway } = await import('../src/llm/client.js');
    const store = auditStore();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(429, { error: 'retry later' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(response(200, { choices: [{ message: { content: '{}' } }] }));
    const gateway = new IsolatedGateway(settings({ hourlyLimit: 1 }), store, {
      fetch: fetchMock,
      now: () => Date.now(),
      sleep: async () => {},
      createId: () => 'fallback-budget-call',
    });

    await expect(gateway.beat(input)).rejects.toMatchObject({ name: 'BudgetExhaustedError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.calls.get('fallback-budget-call')?.status).toBe('failed');
  });

  it('keeps interval and request timeout independent', async () => {
    const store = auditStore();
    let now = Date.now() + 100_000;
    const waits: number[] = [];
    const signal = { current: undefined as AbortSignal | undefined };
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal.current = init?.signal as AbortSignal;
      return response(200, { choices: [{ message: { content: '{}' } }] });
    });
    const gateway = new OpenAiLlmGateway(settings({ minIntervalSeconds: 4 }), store, {
      fetch: fetchMock,
      now: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms; },
      createId: () => 'wait-call',
      requestTimeoutMs: 25,
    });

    await gateway.beat(input);
    await gateway.beat(input);

    expect(waits).toContain(4_000);
    expect(waits.every((ms) => ms !== 25)).toBe(true);
    expect(signal.current?.aborted).toBe(false);
  });
});

describe('beat prompt assembly', () => {
  it('scores recency, intensity, importance, relation, and valence consistency', () => {
    const rows = [
      memory('recent-low', { atMinutes: 110, importance: 1, about: ['ring'], intensity: 0.1 }),
      memory('old-high-intensity', { atMinutes: 0, importance: 1, about: ['ring'], intensity: 1 }),
      memory('high-importance', { atMinutes: 0, importance: 9, about: ['ring'] }),
      memory('related-support', { atMinutes: 0, importance: 1, about: ['inn'], valence: 0.8, intensity: 0.5 }),
      memory('related-positive', { atMinutes: 0, importance: 1, about: ['inn'], valence: 0.5 }),
      memory('related-negative', { atMinutes: 0, importance: 1, about: ['inn'], valence: -0.5 }),
    ];
    const scored = scoreMemoryRows({ ...input, memoryRows: rows });
    const scores = new Map(scored.map(({ row, score }) => [row.id, score]));

    expect(scores.get('recent-low')).toBeGreaterThan(scores.get('old-high-intensity') ?? 0);
    expect(scores.get('high-importance')).toBeGreaterThan(scores.get('related-positive') ?? 0);
    expect(scores.get('related-positive')).toBeGreaterThan(scores.get('related-negative') ?? 0);
  });

  it('trims retrieved memories first, preserves world and recent events, and is deterministic', () => {
    const manyMemories = Array.from({ length: 8 }, (_, index) => memory(`m${index}`, { text: 'remember '.repeat(20) }));
    const withMemories = { ...input, memoryRows: manyMemories };
    const full = assembleBeatMessages(withMemories, 100_000);
    const constrained = assembleBeatMessages(withMemories, 800);
    expect(constrained).toEqual(assembleBeatMessages(withMemories, 800));
    expect(constrained[0]!.content).toContain('"entities"');
    expect(constrained[0]!.content).toContain('exact event');
    expect(JSON.stringify(constrained).length).toBeLessThan(JSON.stringify(full).length);
    expect(constrained).toMatchSnapshot();
    expect(() => assembleBeatMessages(withMemories, 1)).toThrow(ContextBudgetError);
  });
});
