import { useState } from 'react';
import type { ControlPayload, LogEntry, LogPage, StateSnapshot, WorldLine } from '@wispiva/contract';

type AppProps = {
  snapshot: StateSnapshot;
  logs?: Record<string, LogPage>;
  onControl?: (payload: ControlPayload) => void | Promise<void>;
  onLoadOlder?: (line: WorldLine) => void | Promise<void>;
};

const styles = {
  page: { fontFamily: 'system-ui, sans-serif', padding: 20, color: '#202124' },
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 12 },
  card: { border: '1px solid #ccc', borderRadius: 6, padding: 12 },
  controls: { display: 'flex', flexWrap: 'wrap' as const, gap: 6, marginTop: 10 },
};

function recentText(snapshot: StateSnapshot, line: WorldLine): string {
  return snapshot.views[line.id]?.recentText
    ?? snapshot.recentLogs[line.id]?.[0]?.event.text
    ?? '暂无事件';
}

export function App({ snapshot, logs = {}, onControl, onLoadOlder }: AppProps) {
  const [selectedLineId, setSelectedLineId] = useState(snapshot.lines[0]?.id ?? '');
  const selected = snapshot.lines.find((line) => line.id === selectedLineId) ?? snapshot.lines[0];
  const selectedPage = selected === undefined ? undefined : logs[selected.id];
  const selectedLogs = selected === undefined
    ? []
    : selectedPage?.entries ?? snapshot.recentLogs[selected.id] ?? [];

  const command = (payload: ControlPayload) => {
    void onControl?.(payload);
  };

  return (
    <main style={styles.page}>
      <h1>多元宇宙</h1>
      <section aria-label="世界线总览" style={styles.grid}>
        {snapshot.lines.map((line) => (
          <article key={line.id} style={{ ...styles.card, borderColor: line.id === selectedLineId ? '#555' : '#ccc' }}>
            <button type="button" onClick={() => setSelectedLineId(line.id)} aria-pressed={line.id === selectedLineId}>
              {line.name}
            </button>
            <p>{line.speed}× · {line.paused ? '已暂停' : '运行中'} · {line.status}</p>
            <p>世界时间：{line.worldTimeMinutes}</p>
            <p>{recentText(snapshot, line)}</p>
            <div style={styles.controls}>
              <button type="button" onClick={() => command({ lineId: line.id, paused: !line.paused })}>
                {line.paused ? '继续' : '暂停'}
              </button>
              <button type="button" onClick={() => command({ lineId: line.id, speed: Math.max(1, line.speed / 2) })}>减速</button>
              <button type="button" onClick={() => command({ lineId: line.id, speed: line.speed * 2 })}>加速</button>
              <RenameControl line={line} onRename={(name) => command({ lineId: line.id, name })} />
              {line.status === 'error' && <button type="button" onClick={() => command({ lineId: line.id, retry: true })}>重试</button>}
            </div>
          </article>
        ))}
      </section>
      {selected !== undefined && (
        <section aria-label="事件日志">
          <h2>{selected.name} · 事件日志</h2>
          {selectedLogs.map((entry: LogEntry) => <p key={entry.id}>{entry.event.text}</p>)}
          <button
            type="button"
            disabled={selectedPage !== undefined
              ? selectedPage.nextBeforeRevisionId === null
              : selectedLogs.length === 0}
            onClick={() => void onLoadOlder?.(selected)}
          >
            更早事件
          </button>
        </section>
      )}
    </main>
  );
}

function RenameControl({ line, onRename }: { line: WorldLine; onRename: (name: string) => void }) {
  const [name, setName] = useState(line.name);
  return (
    <>
      <input aria-label={`${line.name} 新名称`} value={name} onChange={(event) => setName(event.target.value)} />
      <button type="button" onClick={() => onRename(name)}>改名</button>
    </>
  );
}
