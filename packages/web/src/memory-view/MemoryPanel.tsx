import type { Memory } from '@wispiva/contract';

export type MemoryReflection = { owner: string; text: string };
export type MemoryPanelProps = { eventText: string; memories: Memory[]; reflections: MemoryReflection[] };

export function MemoryPanel({ eventText, memories, reflections }: MemoryPanelProps) {
  const byOwner = new Map<string, Memory[]>();
  for (const memory of memories) byOwner.set(memory.owner, [...(byOwner.get(memory.owner) ?? []), memory]);
  return (
    <section aria-label="记忆对照" className="memory-panel" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
      <section aria-label="事件事实"><h2>事件事实</h2><p>{eventText}</p></section>
      <section aria-label="L1 记忆"><h2>L1 记忆</h2>
        {[...byOwner].map(([owner, rows]) => <section key={owner} data-owner={owner}><h3>{owner}</h3>
          {rows.map((memory) => <p key={memory.id} className={memory.valence > 0 ? 'valence-positive' : memory.valence < 0 ? 'valence-negative' : 'valence-neutral'} data-valence={memory.valence}>{memory.text}</p>)}
        </section>)}
      </section>
      <section aria-label="L2 讲法"><h2>L2 讲法</h2>{reflections.map((reflection) => <article key={reflection.owner} data-owner={reflection.owner}><h3>{reflection.owner}</h3><p>{reflection.text}</p></article>)}</section>
    </section>
  );
}
