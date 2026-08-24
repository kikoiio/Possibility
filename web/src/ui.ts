// web/src/ui.ts — 渲染：条目卡片 / 筛选条 / 居民主页
import type { PublicEntry, PublicResident } from './api';

export const TYPE_LABEL: Record<PublicEntry['type'], string> = {
  activity: '动态',
  dialogue: '对话',
  monologue: '独白',
  mystery: '谜团',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = Date.now();
  const diffDays = Math.floor((now - ts) / 86400000);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (diffDays <= 0) return `今天 ${hhmm}`;
  if (diffDays === 1) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function namesOf(entry: PublicEntry, byId: Map<string, PublicResident>): string {
  return entry.residentIds.map((id) => byId.get(id)?.name ?? id).join('、');
}

export function entryCard(entry: PublicEntry, byId: Map<string, PublicResident>): HTMLElement {
  const card = document.createElement('article');
  card.className = `entry-card type-${entry.type}`;

  const meta = document.createElement('div');
  meta.className = 'entry-meta';

  const badge = document.createElement('span');
  badge.className = 'entry-badge';
  badge.textContent = TYPE_LABEL[entry.type];
  meta.append(badge);

  const who = namesOf(entry, byId);
  if (who) {
    const whoEl = document.createElement('span');
    whoEl.className = 'entry-who';
    if (entry.residentIds.length === 1) {
      const link = document.createElement('a');
      link.href = `#/u/${entry.residentIds[0]}`;
      link.textContent = who;
      whoEl.append(link);
    } else {
      whoEl.textContent = who;
    }
    meta.append(whoEl);
  }

  const loc = document.createElement('span');
  loc.className = 'entry-loc';
  loc.textContent = entry.location;
  meta.append(loc);

  const time = document.createElement('time');
  time.textContent = formatTime(entry.ts);
  meta.append(time);

  card.append(meta);

  if (entry.title) {
    const title = document.createElement('h3');
    title.className = 'entry-title';
    title.textContent = entry.title;
    card.append(title);
  }

  const content = document.createElement('div');
  content.className = 'entry-content';
  for (const line of entry.content.split('\n')) {
    const p = document.createElement('p');
    p.innerHTML = escapeHtml(line);
    content.append(p);
  }
  card.append(content);

  return card;
}

export function renderChips(
  container: HTMLElement,
  residents: PublicResident[],
  activeId: string | null,
): void {
  container.replaceChildren();

  const all = document.createElement('a');
  all.className = `chip${activeId === null ? ' active' : ''}`;
  all.href = '#/';
  all.textContent = '全街';
  container.append(all);

  for (const r of residents) {
    const chip = document.createElement('a');
    chip.className = `chip${activeId === r.id ? ' active' : ''}`;
    chip.href = `#/r/${r.id}`;
    chip.textContent = r.name;
    container.append(chip);
  }
}

export function residentProfilePage(resident: PublicResident): HTMLElement {
  const page = document.createElement('section');
  page.className = 'resident-page';

  const head = document.createElement('div');
  head.className = 'resident-head';
  const name = document.createElement('h2');
  name.textContent = resident.name;
  const role = document.createElement('p');
  role.className = 'resident-role';
  role.textContent = `${resident.age} 岁 · ${resident.role}`;
  head.append(name, role);

  const desc = document.createElement('p');
  desc.className = 'resident-desc';
  desc.textContent = resident.description;

  const personality = document.createElement('p');
  personality.className = 'resident-line';
  personality.innerHTML = `<strong>性格</strong>：${escapeHtml(resident.personality)}`;

  const style = document.createElement('p');
  style.className = 'resident-line';
  style.innerHTML = `<strong>说话方式</strong>：${escapeHtml(resident.speechStyle)}`;

  const back = document.createElement('a');
  back.className = 'back-link';
  back.href = `#/r/${resident.id}`;
  back.textContent = '看 TA 的动态 →';

  page.append(head, desc, personality, style, back);
  return page;
}
