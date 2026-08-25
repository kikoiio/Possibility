// web/src/ui.ts — 纯文字流渲染：倒叙（最新在上），章节块内嵌，前情提要累积
import type { PublicChapter, PublicEntry } from './api';

function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function isToday(ts: number): boolean {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

function entryParagraph(entry: PublicEntry): HTMLElement {
  const p = document.createElement('p');
  p.className = `story ${entry.type}`;

  const time = document.createElement('span');
  time.className = 'story-time';
  time.textContent = timeLabel(entry.ts);
  p.append(time);

  if (entry.title) {
    const title = document.createElement('strong');
    title.className = 'story-title';
    title.textContent = `【${entry.title}】`;
    p.append(title);
  }

  const lines = entry.content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (i > 0) p.append(document.createElement('br'));
    p.append(document.createTextNode(line));
  }
  return p;
}

function chapterBlock(chapter: PublicChapter): HTMLElement {
  const block = document.createElement('section');
  block.className = 'chapter-block';

  const ornament = document.createElement('div');
  ornament.className = 'chapter-ornament';
  ornament.textContent = '❦';

  const title = document.createElement('h3');
  title.className = 'chapter-title';
  title.textContent = `第${'一二三四五六七八九十'[chapter.number - 1] ?? chapter.number}章 · ${chapter.title}`;

  const content = document.createElement('p');
  content.className = 'chapter-content';
  content.textContent = chapter.content;

  block.append(ornament, title, content);
  return block;
}

/** 前情提要折叠区：全部章节按序累积（故事的概览版本） */
export function renderRecap(chapters: PublicChapter[]): HTMLElement | null {
  if (chapters.length === 0) return null;

  const details = document.createElement('details');
  details.className = 'recap';

  const summary = document.createElement('summary');
  summary.textContent = `前情提要 · 已连载 ${chapters.length} 章`;
  details.append(summary);

  for (const ch of chapters) {
    const item = document.createElement('div');
    item.className = 'recap-chapter';
    const title = document.createElement('p');
    title.className = 'recap-title';
    title.textContent = `第${'一二三四五六七八九十'[ch.number - 1] ?? ch.number}章 · ${ch.title}`;
    const content = document.createElement('p');
    content.className = 'recap-content';
    content.textContent = ch.content;
    item.append(title, content);
    details.append(item);
  }
  return details;
}

/** 倒叙文字流：条目与章节按时间倒序合并；日分节插在日期变化处 */
export function renderStream(entries: PublicEntry[], chapters: PublicChapter[]): DocumentFragment {
  const frag = document.createDocumentFragment();

  const merged = [
    ...entries.map((e) => ({ kind: 'entry' as const, ts: e.ts, entry: e })),
    ...chapters.map((c) => ({ kind: 'chapter' as const, ts: c.ts, chapter: c })),
  ].sort((a, b) => b.ts - a.ts);

  let lastDay = '';
  let firstEntry = true;
  for (const item of merged) {
    if (item.kind === 'entry') {
      const day = dayLabel(item.ts);
      if (day !== lastDay) {
        const divider = document.createElement('div');
        divider.className = 'day-divider';
        divider.textContent = firstEntry && isToday(item.ts) ? `今天 · ${day}` : day;
        frag.append(divider);
        lastDay = day;
      }
      firstEntry = false;
      frag.append(entryParagraph(item.entry));
    } else {
      frag.append(chapterBlock(item.chapter));
    }
  }

  if (merged.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'story empty';
    empty.textContent = '故事还没有开始。';
    frag.append(empty);
  }
  return frag;
}
