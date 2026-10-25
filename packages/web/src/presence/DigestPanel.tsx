export type DigestEntry = { revisionId: string; text: string; importance: number; atMinutes: number };

export function DigestPanel({ entries }: { entries: DigestEntry[] }) {
  return (
    <section aria-label="新闻播报" style={{ borderLeft: '3px solid #b58d4d', padding: '4px 16px', color: '#342f26' }}>
      <h2>世界近况</h2>
      {entries.length === 0
        ? <p>暂无值得播报的新消息。</p>
        : <ol>{entries.map((entry) => (
          <li key={entry.revisionId}>
            <p>{entry.text}</p>
            <small>重要度 {entry.importance.toFixed(1)} · 世界时间 {entry.atMinutes} 分钟</small>
          </li>
        ))}</ol>}
    </section>
  );
}
