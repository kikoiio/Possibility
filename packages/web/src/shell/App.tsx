import { useState } from 'react';
import type { ConfirmPayload, ControlPayload, Draft, EditProposal, LogEntry, LogPage, Memory, StateSnapshot, WorldLine } from '@wispiva/contract';
import { EditorPanel } from '../editor/EditorPanel.js';
import { MemoryPanel, type MemoryReflection } from '../memory-view/MemoryPanel.js';
import { ChatPanel, type DialogueLine, type PresenceCharacter } from '../presence/ChatPanel.js';
import { DigestPanel, type DigestEntry } from '../presence/DigestPanel.js';

type AppProps = {
  snapshot: StateSnapshot;
  logs?: Record<string, LogPage>;
  onControl?: (payload: ControlPayload) => void | Promise<void>;
  onLoadOlder?: (line: WorldLine) => void | Promise<void>;
  // 在场/编辑器/记忆视图(P3)。全部可选:数据由宿主(main.tsx/hook 层)注入。
  onChat?: (input: { text: string; avatarId: string; otherId: string }) => void | Promise<void>;
  chat?: { characters?: PresenceCharacter[]; dialogue?: DialogueLine[]; slowdownActive?: boolean };
  digest?: DigestEntry[];
  editor?: {
    draft?: Draft | null;
    proposal?: EditProposal | null;
    onCreateDraft?: () => Draft | Promise<Draft>;
    onProposeEdit?: (input: { draftId: string; instruction: string }) => EditProposal | Promise<EditProposal>;
    onConfirm?: (payload: ConfirmPayload) => void | Promise<void>;
  };
  memory?: { eventText: string; memories: Memory[]; reflections: MemoryReflection[] };
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

export function App({ snapshot, logs = {}, onControl, onLoadOlder, onChat, chat, digest, editor, memory }: AppProps) {
  const [selectedLineId, setSelectedLineId] = useState(snapshot.lines[0]?.id ?? '');
  const [tab, setTab] = useState<'log' | 'chat' | 'digest' | 'editor' | 'memory'>('log');
  const [avatarId, setAvatarId] = useState(chat?.characters?.[0]?.id ?? '');
  const [otherId, setOtherId] = useState(chat?.characters?.[1]?.id ?? '');
  const [dialogue, setDialogue] = useState<DialogueLine[]>(chat?.dialogue ?? []);
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
        <nav aria-label="视图" style={styles.controls}>
          {(['log', 'chat', 'digest', 'editor', 'memory'] as const).map(key => (
            <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)}>
              {{ log: '事件日志', chat: '对话', digest: '新闻播报', editor: '编辑器', memory: '记忆对照' }[key]}
            </button>
          ))}
        </nav>
      )}
      {selected !== undefined && tab === 'log' && (
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
      {tab === 'chat' && (
        <section aria-label="在场对话">
          <ChatPanel
            characters={chat?.characters ?? []}
            selectedEntityId={avatarId}
            otherEntityId={otherId}
            lines={dialogue}
            slowdownActive={chat?.slowdownActive ?? false}
            onSelectAvatar={(id) => { setAvatarId(id); const next = chat?.characters?.find(c => c.id !== id); if (next) setOtherId(next.id); }}
            onSend={async text => {
              setDialogue(prev => [...prev, { id: `local-${prev.length}`, speaker: avatarId, text }]);
              await onChat?.({ text, avatarId, otherId });
            }}
          />
        </section>
      )}
      {tab === 'digest' && <DigestPanel entries={digest ?? []} />}
      {tab === 'editor' && editor?.onCreateDraft && editor.onProposeEdit && editor.onConfirm && (
        <EditorPanel
          draft={editor.draft ?? null}
          proposal={editor.proposal ?? null}
          onCreateDraft={editor.onCreateDraft}
          onProposeEdit={editor.onProposeEdit}
          onConfirm={editor.onConfirm}
        />
      )}
      {tab === 'memory' && memory && (
        <MemoryPanel eventText={memory.eventText} memories={memory.memories} reflections={memory.reflections} />
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
