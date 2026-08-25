// web/src/main.ts — 信息流单页：路由 / 轮询 / 筛选 / 加载更多
// 页面零输入控件（筛选全部走 hash 链接导航）。

import { fetchNow, fetchResidents, fetchTimeline, type PublicEntry, type PublicResident } from './api';
import { entryCard, nowStrip, renderChips, residentProfilePage } from './ui';

const POLL_INTERVAL_MS = 30_000;
const PAGE_SIZE = 20;

interface AppState {
  residents: PublicResident[];
  byId: Map<string, PublicResident>;
  entries: PublicEntry[];
  seen: Set<string>;
  cursor: string | null;
}

const state: AppState = {
  residents: [],
  byId: new Map(),
  entries: [],
  seen: new Set(),
  cursor: null,
};

const view = document.getElementById('view')!;
const chips = document.getElementById('resident-chips')!;
const nowContainer = document.getElementById('now')!;

/** 刷新「此刻」状态带（世界活着的实时证据） */
async function refreshNow(): Promise<void> {
  try {
    const now = await fetchNow();
    nowContainer.replaceChildren(nowStrip(now));
  } catch {
    // 状态带失败不影响信息流
  }
}

/** 当前路由：#/ 全部；#/r/<id> 按居民筛选；#/u/<id> 居民主页 */
function route(): { kind: 'all' } | { kind: 'filter'; id: string } | { kind: 'resident'; id: string } {
  const hash = location.hash;
  const filter = hash.match(/^#\/r\/([\w-]+)/);
  if (filter) return { kind: 'filter', id: filter[1]! };
  const resident = hash.match(/^#\/u\/([\w-]+)/);
  if (resident) return { kind: 'resident', id: resident[1]! };
  return { kind: 'all' };
}

function activeFilter(): string | null {
  const r = route();
  return r.kind === 'filter' ? r.id : null;
}

function renderFeed(): void {
  view.replaceChildren();
  if (state.entries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-hint';
    empty.textContent = '街上还很安静，等新的一天开始吧。';
    view.append(empty);
    return;
  }
  for (const entry of state.entries) {
    view.append(entryCard(entry, state.byId));
  }
  if (state.cursor) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'load-more';
    more.textContent = '看看更早的街上';
    more.addEventListener('click', () => void loadMore());
    view.append(more);
  }
}

async function refresh(reset = true): Promise<void> {
  const filter = activeFilter();
  const res = await fetchTimeline({ resident: filter ?? undefined, limit: PAGE_SIZE });
  if (reset) {
    state.entries = res.entries;
    state.seen = new Set(res.entries.map((e) => e.id));
  } else {
    for (const e of res.entries) {
      if (!state.seen.has(e.id)) {
        state.seen.add(e.id);
        state.entries.unshift(e);
      }
    }
  }
  state.cursor = res.nextCursor;
  renderFeed();
}

async function loadMore(): Promise<void> {
  if (!state.cursor) return;
  const filter = activeFilter();
  const res = await fetchTimeline({ resident: filter ?? undefined, cursor: state.cursor, limit: PAGE_SIZE });
  for (const e of res.entries) {
    if (!state.seen.has(e.id)) {
      state.seen.add(e.id);
      state.entries.push(e);
    }
  }
  state.cursor = res.nextCursor;
  renderFeed();
}

async function renderResidentPage(id: string): Promise<void> {
  const resident = state.byId.get(id);
  view.replaceChildren();
  if (!resident) {
    view.textContent = '没有找到这位居民。';
    return;
  }
  view.append(residentProfilePage(resident));

  const section = document.createElement('section');
  section.className = 'resident-entries';
  const res = await fetchTimeline({ resident: id, limit: PAGE_SIZE });
  for (const entry of res.entries) {
    section.append(entryCard(entry, state.byId));
  }
  view.append(section);
}

async function applyRoute(): Promise<void> {
  const r = route();
  renderChips(chips, state.residents, activeFilter());
  if (r.kind === 'resident') {
    await renderResidentPage(r.id);
  } else {
    await refresh();
  }
}

async function init(): Promise<void> {
  const { residents } = await fetchResidents();
  state.residents = residents;
  state.byId = new Map(residents.map((r) => [r.id, r]));

  // 居民名字可点：chips 旁边加"主页"入口放在卡片 who 上，这里渲染筛选条
  await applyRoute();
  await refreshNow();
  window.addEventListener('hashchange', () => void applyRoute());
  setInterval(() => {
    void refreshNow();
    if (route().kind !== 'resident') void refresh(false);
  }, POLL_INTERVAL_MS);
}

init().catch((e) => {
  view.textContent = `加载失败：${(e as Error).message}`;
});
