// web/src/main.ts — 纯文字流：只呈现故事本身
// 无筛选、无角色页、无介绍——标题、此刻一行、连续的文字、加载更早。

import { fetchNow, fetchTimeline, type PublicEntry } from './api';
import { renderStream } from './ui';

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 30;

const stream = document.getElementById('stream')!;
const nowLine = document.getElementById('now-line')!;
const loadMoreLink = document.getElementById('load-more') as HTMLAnchorElement;

let entries: PublicEntry[] = [];
let cursor: string | null = null;

function render(): void {
  stream.replaceChildren(renderStream(entries));
  loadMoreLink.hidden = cursor === null;
}

async function refresh(): Promise<void> {
  const res = await fetchTimeline({ limit: PAGE_SIZE });
  const seen = new Set(entries.map((e) => e.id));
  const fresh = res.entries.filter((e) => !seen.has(e.id));
  entries = entries.length === 0 ? res.entries : [...fresh, ...entries];
  cursor = res.nextCursor;
  render();
}

async function refreshNow(): Promise<void> {
  try {
    const now = await fetchNow();
    const parts = now.residents.map((r) => `${r.name}在${r.location}${r.activity}`);
    nowLine.textContent = `此刻 ${now.localTime.slice(11)} · ${now.weather} ｜ ${parts.join('；')}`;
  } catch {
    // 此刻行失败不影响正文
  }
}

loadMoreLink.addEventListener('click', async () => {
  if (!cursor) return;
  const res = await fetchTimeline({ cursor, limit: PAGE_SIZE });
  const seen = new Set(entries.map((e) => e.id));
  entries.push(...res.entries.filter((e) => !seen.has(e.id)));
  cursor = res.nextCursor;
  render();
});

async function init(): Promise<void> {
  await Promise.all([refresh(), refreshNow()]);
  setInterval(() => {
    void refresh();
    void refreshNow();
  }, POLL_INTERVAL_MS);
}

init().catch((e) => {
  stream.textContent = `这条街暂时迷路了：${(e as Error).message}`;
});
