// web/src/main.ts — 纯文字流：倒叙（最新在上）+ 章节 + 前情提要
import { fetchChapters, fetchNow, fetchTimeline, type PublicChapter, type PublicEntry } from './api';
import { renderRecap, renderStream } from './ui';

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 30;

const stream = document.getElementById('stream')!;
const recap = document.getElementById('recap')!;
const nowLine = document.getElementById('now-line')!;
const loadMoreLink = document.getElementById('load-more') as HTMLAnchorElement;

let entries: PublicEntry[] = [];
let chapters: PublicChapter[] = [];
let cursor: string | null = null;

function render(): void {
  const recapEl = renderRecap(chapters);
  recap.replaceChildren(...(recapEl ? [recapEl] : []));
  stream.replaceChildren(renderStream(entries, chapters));
  loadMoreLink.hidden = cursor === null;
}

async function refresh(): Promise<void> {
  const [timelineRes, chaptersRes] = await Promise.all([fetchTimeline({ limit: PAGE_SIZE }), fetchChapters()]);
  chapters = chaptersRes.chapters;

  const seen = new Set(entries.map((e) => e.id));
  const fresh = timelineRes.entries.filter((e) => !seen.has(e.id));
  // 倒叙：新条目插到最前
  entries = entries.length === 0 ? timelineRes.entries : [...fresh, ...entries];
  cursor = timelineRes.nextCursor;
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
