import { useState } from 'react';

export type PresenceCharacter = { id: string; name: string };
export type DialogueLine = { id: string; speaker: string; text: string };

export type ChatPanelProps = {
  characters: PresenceCharacter[];
  selectedEntityId: string;
  otherEntityId: string;
  lines: DialogueLine[];
  slowdownActive: boolean;
  onSelectAvatar: (entityId: string) => void;
  onSend: (text: string) => void | Promise<void>;
};

export function ChatPanel({ characters, selectedEntityId, otherEntityId, lines, slowdownActive, onSelectAvatar, onSend }: ChatPanelProps) {
  const [text, setText] = useState('');
  return (
    <section aria-label="在场对话" style={{ border: '1px solid #c9c4b7', borderRadius: 10, padding: 16, background: '#fbfaf6', color: '#29291f' }}>
      <h2>入世对话</h2>
      {slowdownActive && <p role="status" style={{ background: '#f3e7be', padding: '8px 12px', borderRadius: 6 }}>对话期间，世界以 1× 速度运行</p>}
      <label>
        你的化身
        <select aria-label="你的化身" value={selectedEntityId} onChange={(event) => onSelectAvatar(event.target.value)}>
          {characters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}
        </select>
      </label>
      <p>对话对象：{characters.find((character) => character.id === otherEntityId)?.name ?? otherEntityId}</p>
      <ol aria-label="对话记录" style={{ minHeight: 80, paddingLeft: 24 }}>
        {lines.map((line) => <li key={line.id}><strong>{line.speaker}：</strong>{line.text}</li>)}
      </ol>
      <form onSubmit={(event) => { event.preventDefault(); if (text.trim()) { void onSend(text); setText(''); } }}>
        <label>
          说些什么
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} />
        </label>
        <button type="submit" disabled={!text.trim()}>发送</button>
      </form>
    </section>
  );
}
