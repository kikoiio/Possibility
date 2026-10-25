import { useCallback, useEffect, useState } from 'react';
import type { LogPage, SseEvent, StateSnapshot, WorldLine } from '@wispiva/contract';
import { createApiClient } from '../api/client.js';
import { parseSseChunks } from '../api/events.js';

const pageSize = 20;

function initialLogPages(snapshot: StateSnapshot): Record<string, LogPage> {
  return Object.fromEntries(Object.entries(snapshot.recentLogs).map(([lineId, entries]) => [
    lineId,
    {
      lineId,
      entries,
      nextBeforeRevisionId: entries.at(-1)?.id ?? null,
    },
  ]));
}

export function useShellData() {
  const [snapshot, setSnapshot] = useState<StateSnapshot | null>(null);
  const [logs, setLogs] = useState<Record<string, LogPage>>({});
  const api = createApiClient();

  const applyEvent = useCallback((event: SseEvent) => {
    if (event.type === 'snapshot') {
      setSnapshot(event.data);
      setLogs(initialLogPages(event.data));
    } else if (event.type === 'line') {
      setSnapshot((current) => current === null ? current : {
        ...current,
        lines: current.lines.some((line) => line.id === event.data.id)
          ? current.lines.map((line) => line.id === event.data.id ? event.data : line)
          : [...current.lines, event.data],
      });
    } else if (event.type === 'revision') {
      setSnapshot((current) => current === null ? current : {
        ...current,
        recentLogs: {
          ...current.recentLogs,
          [event.data.lineId]: [event.data.entry, ...(current.recentLogs[event.data.lineId] ?? [])].slice(0, 12),
        },
      });
      setLogs((current) => {
        const page = current[event.data.lineId];
        return page === undefined ? current : {
          ...current,
          [event.data.lineId]: { ...page, entries: [event.data.entry, ...page.entries] },
        };
      });
    }
  }, []);

  useEffect(() => {
    let closed = false;
    let source: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async () => {
      try {
        const state = await api.getState();
        if (closed) return;
        applyEvent({ type: 'snapshot', data: state });
        source = new EventSource(api.eventsUrl);
        const consume = (raw: string, type?: string) => {
          try {
            const framed = type === undefined ? raw : `event: ${type}\ndata: ${raw}\n\n`;
            for (const event of parseSseChunks([framed])) applyEvent(event);
          } catch {
            source?.close();
          }
        };
        source.onmessage = (message) => consume(message.data);
        for (const type of ['snapshot', 'line', 'revision', 'call']) {
          source.addEventListener(type, (message) => consume((message as MessageEvent<string>).data, type));
        }
        source.onerror = () => {
          source?.close();
          retryTimer = setTimeout(() => void connect(), 1000);
        };
      } catch {
        if (!closed) retryTimer = setTimeout(() => void connect(), 1000);
      }
    };

    void connect();
    return () => {
      closed = true;
      source?.close();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [api.eventsUrl, applyEvent]);

  const control = useCallback(async (payload: Parameters<ReturnType<typeof createApiClient>['control']>[0]) => {
    await api.control(payload);
    applyEvent({ type: 'snapshot', data: await api.getState() });
  }, [api, applyEvent]);

  const loadOlder = useCallback(async (line: WorldLine) => {
    const page = logs[line.id];
    if (page !== undefined && page.nextBeforeRevisionId === null) return;
    const beforeRevisionId = page === undefined ? line.headRevisionId : page.nextBeforeRevisionId;
    if (beforeRevisionId === null) return;
    const older = await api.getLog(line.id, { beforeRevisionId, limit: pageSize });
    setLogs((current) => {
      const previous = current[line.id];
      const seen = new Set(previous?.entries.map((entry) => entry.id) ?? []);
      return {
        ...current,
        [line.id]: {
          ...older,
          entries: [...(previous?.entries ?? []), ...older.entries.filter((entry) => !seen.has(entry.id))],
        },
      };
    });
  }, [api, logs]);

  return { snapshot, logs, control, loadOlder };
}
