// web/src/ui.ts — 纯文字流渲染：按日分节，段落即故事
import type { PublicEntry } from './api';

function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
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

  // 对话按行展开，其余整段呈现
  const lines = entry.content.split('\n');
  for (const [i, line] of lines.entries()) {
    if (i > 0) p.append(document.createElement('br'));
    p.append(document.createTextNode(line));
  }
  return p;
}

/** 把条目渲染为按日分节的连续文字流（条目须已按时间倒序） */
export function renderStream(entries: PublicEntry[]): DocumentFragment {
  const frag = document.createDocumentFragment();
  let lastDay = '';

  // 按时间正序书写（小说从下往上读），分节标题插在日期变化处
  const chronological = [...entries].sort((a, b) => a.ts - b.ts);
  for (const entry of chronological) {
    const day = dayLabel(entry.ts);
    if (day !== lastDay) {
      lastDay = day;
      const divider = document.createElement('div');
      divider.className = 'day-divider';
      divider.textContent = day;
      frag.append(divider);
    }
    frag.append(entryParagraph(entry));
  }

  if (entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'story empty';
    empty.textContent = '故事还没有开始。';
    frag.append(empty);
  }
  return frag;
}
