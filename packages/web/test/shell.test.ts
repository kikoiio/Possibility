import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SseEvent, StateSnapshot } from '@wispiva/contract';
import { createApiClient } from '../src/api/client.js';
import { parseSseChunks, reconnectEvents } from '../src/api/events.js';
import { App } from '../src/shell/App.js';

const fixture = JSON.parse(readFileSync(resolve(process.cwd(), 'packages/contract/fixtures/sse-reconnect-snapshot.json'), 'utf8')) as {
  snapshot: StateSnapshot;
  replay: SseEvent[];
};

describe('web shell', () => {
  it('renders fixture line names and recent event text', () => {
    const html = renderToString(React.createElement(App, { snapshot: fixture.snapshot }));
    expect(html).toContain('α');
    expect(html).toContain('阿苇在书院门口挂起午后开放的木牌。');
  });

  it('uses contract API paths, methods, and payloads', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{}', { status: 200 }));
    const api = createApiClient(fetchMock, '/api');
    await api.getState();
    await api.getLog('line/a', { beforeRevisionId: 'rev 1', limit: 10 });
    await api.control({ lineId: 'line_alpha', paused: true });
    await api.postDraft({ lineId: 'line_alpha' });
    await api.postEdit({ id: 'draft_1' });
    await api.postConfirm({ draftId: 'draft_1', proposalId: 'proposal_1', ifText: '如果…' });
    await api.postSettings({ models: ['model-a'] });

    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['/api/state', 'GET'],
      ['/api/lines/line%2Fa/log?beforeRevisionId=rev+1&limit=10', 'GET'],
      ['/api/control', 'POST'],
      ['/api/draft', 'POST'],
      ['/api/edit', 'POST'],
      ['/api/confirm', 'POST'],
      ['/api/settings', 'POST'],
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({ lineId: 'line_alpha', paused: true });
    expect(JSON.parse(String(fetchMock.mock.calls[3]?.[1]?.body))).toEqual({ lineId: 'line_alpha' });
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({ draftId: 'draft_1' });
    expect(JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body))).toEqual({ draftId: 'draft_1', proposalId: 'proposal_1', ifText: '如果…' });
    expect(JSON.parse(String(fetchMock.mock.calls[6]?.[1]?.body))).toEqual({ models: ['model-a'] });
  });

  it('parses split SSE frames and aligns state before replaying increments', async () => {
    const calls: string[] = [];
    const chunks = [
      'event: line\ndata: {"id":"line_alpha","name":"改名后"',
      ',"parentLineId":null,"forkRevisionId":null,"forkTimeMinutes":null,"headRevisionId":"rev_library_open","worldTimeMinutes":570,"speed":24,"paused":false,"plan":null,"status":"ready","error":null,"retryAt":0}\n\n',
    ];
    const events = await reconnectEvents(async () => {
      calls.push('state');
      return fixture.snapshot;
    }, {
      *[Symbol.iterator]() {
        calls.push('incremental');
        yield* chunks;
      },
    });
    expect(calls).toEqual(['state', 'incremental']);
    expect(events[0]).toEqual({ type: 'snapshot', data: fixture.snapshot });
    expect(events[1]?.type).toBe('line');
    expect(parseSseChunks(['data: ', JSON.stringify(fixture.replay[1]), '\n\n'])).toEqual([fixture.replay[1]]);
    assert.equal(events.length, 2);
  });
});
