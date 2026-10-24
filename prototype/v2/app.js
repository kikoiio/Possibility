import { createStage } from './renderers.js';

const $ = id => document.getElementById(id);
const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const time = minutes => `第${Math.floor(minutes / 1440) + 1}天 ${String(Math.floor(minutes % 1440 / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;
const state = { data: null, activeId: sessionStorage.getItem('wispiva.v2.active'), tab: 'log', view: 'split', draft: null, sceneKey: '', journalKey: '', castKey: '', busy: false };
const stages = { '2d': createStage($('stage-2d'), '2d'), '3d': createStage($('stage-3d'), '3d') };
const statusNames = { paused: '已暂停', generating: '正在推演下一段', running: '世界正在运行', waiting: '等待下一段故事', error: '等待重试' };

async function api(path, body) {
  const response = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败');
  return result;
}
function active() { return state.data?.lines.find(line => line.id === state.activeId); }
function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => $('toast').hidden = true, 5000);
}
function run(fn) { return async event => { try { await fn(event); } catch (error) { toast(error.message); } }; }
async function refresh(force = false) {
  if (refresh.pending) {
    await refresh.pending;
    if (!force) return;
  }
  refresh.pending = (async () => {
    try {
      state.data = await api('state');
      if (!active()) state.activeId = state.data.lines[0]?.id;
      render();
      if ($('multiverse').open) renderMultiverse();
    } catch (error) { $('status').textContent = '服务连接中断，正在重连'; }
    finally { refresh.pending = null; }
  })();
  return refresh.pending;
}
function selectLine(lineId) {
  state.activeId = lineId;
  sessionStorage.setItem('wispiva.v2.active', lineId);
  state.sceneKey = ''; state.journalKey = ''; state.castKey = '';
  render();
}
function render() {
  const line = active();
  if (!line) return;
  const config = state.data.settings;
  $('mode-badge').textContent = config.mode === 'live' ? 'GROQ · 真实推演' : '演示模式 · 非 LLM';
  $('world-title').textContent = line.world.title || line.name;
  $('premise').textContent = line.world.premise || '一个由你定义的世界。';
  $('clock').textContent = time(line.worldTime);
  $('status').textContent = statusNames[line.status];
  $('pause').textContent = line.paused ? '开始' : '暂停';
  if (document.activeElement !== $('speed')) $('speed').value = line.speed;
  $('time-explainer').textContent = `1 真实小时 = ${line.speed} 世界小时 · 每段推演 ${config.beatMinutes} 世界分钟`;
  $('world-error').textContent = line.error || '';
  $('horizon').textContent = line.horizon > line.worldTime ? `故事已生成至 ${time(line.horizon)} · 还有 ${line.pendingEvents} 件事等待发生` : '未来尚待推演 · 等待期间世界时间保持不变';
  $('revision').textContent = '世界与历史已保存';
  $('line-count').textContent = state.data.lines.length;
  const buttons = state.data.lines.map(l => `<button class="line-button ${l.id === line.id ? 'selected' : ''}" data-line="${escape(l.id)}"><strong>${escape(l.name)}</strong><small><span class="line-running ${l.paused ? 'paused' : ''}"></span>${escape(statusNames[l.status])} · ${time(l.worldTime).replace('第', 'D')}</small></button>`).join('');
  if ($('line-list').innerHTML !== buttons) $('line-list').innerHTML = buttons;
  const sceneKey = `${line.id}:${line.head}:${Math.floor(line.worldTime)}`;
  if (state.sceneKey !== sceneKey) {
    for (const stage of Object.values(stages)) stage.update(line.scene);
    state.sceneKey = sceneKey;
  }
  if (state.castKey !== `${line.id}:${line.head}`) {
    $('cast').innerHTML = Object.values(line.world.entities).filter(e => e.kind === 'character').map(c => `<div class="cast-card" style="border-color:${safeColor(c.color)}"><strong>${escape(c.name)}</strong><p>${escape(c.state || '')}</p><p>${escape(c.goal || '')}</p></div>`).join('');
    state.castKey = `${line.id}:${line.head}`;
  }
  renderJournal();
}
function safeColor(color) { return /^#[0-9a-f]{6}$/i.test(color || '') ? color : '#82916b'; }
function renderJournal() {
  const line = active();
  const search = $('log-search').value.trim().toLowerCase();
  const key = JSON.stringify([line.id, line.head, state.tab, search, state.data.calls, state.data.usage]);
  if (key === state.journalKey) return;
  state.journalKey = key;
  const matches = text => String(text).toLowerCase().includes(search);
  const target = $('journal-content');
  const bottom = target.scrollHeight - target.clientHeight - target.scrollTop < 60;
  if (state.tab === 'log') {
    target.innerHTML = line.log.filter(e => matches(e.text)).map(e => `<article class="journal-entry"><span class="entry-time">${time(e.time)}</span><p class="entry-text">${escape(e.text)}</p>${e.changes?.length ? `<p class="entry-changes">修改 ${e.changes.map(escape).join(' · ')}</p>` : ''}<span class="entry-label">${e.kind === 'edit' ? '用户的「如果…」' : e.kind === 'origin' ? '世界的起点' : e.source === 'demo' ? '演示事件 · 非 LLM' : 'LLM 推演'}</span></article>`).join('');
    $('journal-note').textContent = '你离开页面后发生的事，也会留在这里。';
  } else if (state.tab === 'memory') {
    target.innerHTML = (line.world.memories || []).filter(m => matches(m.text)).map(m => `<article class="memory-item"><p>${escape(m.text)}</p><small>知情：${escape((m.knownBy || []).map(id => id === 'all' ? '所有人' : line.world.entities[id]?.name || id).join('、'))} · 来源 ${escape(String(m.source || '初始设定').slice(0, 8))}</small></article>`).join('');
    $('journal-note').textContent = '这些事实随世界线继承，并完整送入后续推演；超出上下文预算会明确停止。';
  } else {
    target.innerHTML = state.data.calls.filter(c => c.lineId === line.id).filter(c => matches(c.model || c.kind)).slice().reverse().map(c => `<article class="memory-item"><p>${escape(c.kind === 'edit' ? '编辑提案' : '世界推演')} · ${escape(c.status)}</p><small>${escape(c.model || c.mode)} · ${new Date(c.startedAt).toLocaleTimeString()}${c.usage?.total_tokens ? ` · ${c.usage.total_tokens} tokens` : ''}</small>${c.error ? `<p class="error">${escape(c.error)}</p>` : ''}</article>`).join('');
    $('journal-note').textContent = `真实调用：本小时 ${state.data.usage.hour}/${state.data.settings.maxCallsHour} · 今日 ${state.data.usage.day}/${state.data.settings.maxCallsDay}`;
  }
  if (!target.children.length) target.innerHTML = '<p class="empty-state">这里还没有记录。<br>让世界开始运行，或换个词查找。</p>';
  if (bottom && !search && state.tab === 'log') target.scrollTop = target.scrollHeight;
}
async function openEditor(newWorld = false) {
  const line = active();
  state.draft = await api('draft', { lineId: newWorld ? null : line.id });
  $('editor-title').textContent = newWorld ? '写下一个新世界' : '如果…';
  $('draft-name').value = newWorld ? '新的世界线' : `${line.name} · 如果`;
  $('draft-anchor').textContent = newWorld ? '这是一个独立世界的草稿。确认后创建，点击开始即可运行。' : `修改基于「${line.name}」的 ${time(state.draft.worldTime)}。原世界线继续运行；新线继承到这个时刻的历史，不会混入你编辑期间发生的事。`;
  $('edit-instruction').value = ''; $('edit-explanation').textContent = ''; $('edit-error').textContent = '';
  setDraftWorld(state.draft.world);
  $('editor').showModal();
}
function readDraft() { return JSON.parse($('world-json').value); }
function setDraftWorld(world) {
  $('world-json').value = JSON.stringify(world, null, 2);
  $('edit-premise').value = world.premise || '';
  const places = Object.entries(world.entities || {}).filter(([, e]) => e.kind === 'place');
  $('entity-fields').innerHTML = Object.entries(world.entities || {}).filter(([, e]) => e.kind === 'character').map(([id, c]) => `<details class="entity-editor"><summary>${escape(c.name || id)}</summary><label>目标<input data-entity="${escape(id)}" data-field="goal" value="${escape(c.goal)}"></label><label>当前状态<input data-entity="${escape(id)}" data-field="state" value="${escape(c.state)}"></label><label>性格<input data-entity="${escape(id)}" data-field="personality" value="${escape(c.personality)}"></label><label>所在地点<select data-entity="${escape(id)}" data-field="location">${places.map(([key, p]) => `<option value="${escape(key)}" ${key === c.location ? 'selected' : ''}>${escape(p.name || key)}</option>`).join('')}</select></label><label>知道的事（每行一条）<textarea data-entity="${escape(id)}" data-field="knowledge" rows="2">${escape((c.knowledge || []).join('\n'))}</textarea></label></details>`).join('');
}
$('entity-fields').addEventListener('input', event => {
  const el = event.target;
  if (!el.dataset.entity) return;
  try {
    const world = readDraft();
    world.entities[el.dataset.entity][el.dataset.field] = el.dataset.field === 'knowledge' ? el.value.split('\n').filter(Boolean) : el.value;
    $('world-json').value = JSON.stringify(world, null, 2);
  } catch { $('edit-error').textContent = '完整设定中有无效 JSON，请先修正。'; }
});
$('edit-premise').addEventListener('input', () => {
  try { const world = readDraft(); world.premise = $('edit-premise').value; $('world-json').value = JSON.stringify(world, null, 2); }
  catch { $('edit-error').textContent = '完整设定中有无效 JSON，请先修正。'; }
});
$('apply-json').onclick = run(() => { setDraftWorld(readDraft()); toast('编辑项已更新，尚未确认'); });
$('ask-llm').onclick = async () => {
  $('ask-llm').disabled = true; $('confirm-edit').disabled = true;
  $('edit-error').textContent = ''; $('edit-explanation').textContent = '正在根据你的想法修改草稿…';
  try {
    const result = await api('edit', { draftId: state.draft.id, world: readDraft(), instruction: $('edit-instruction').value });
    setDraftWorld(result.world); $('edit-explanation').textContent = result.explanation;
  } catch (error) { $('edit-error').textContent = error.message; $('edit-explanation').textContent = ''; }
  finally { $('ask-llm').disabled = false; $('confirm-edit').disabled = false; }
};
$('confirm-edit').onclick = async () => {
  $('confirm-edit').disabled = true; $('edit-error').textContent = '';
  try {
    const result = await api('confirm', { draftId: state.draft.id, world: readDraft(), name: $('draft-name').value });
    $('editor').close(); await refresh(true); selectLine(result.lineId); toast('新的世界线已生成。原世界线保持独立运行。');
  } catch (error) { $('edit-error').textContent = error.message; }
  finally { $('confirm-edit').disabled = false; }
};
function openSettings() {
  const s = state.data.settings;
  $('setting-mode').value = s.mode; $('setting-base').value = s.baseUrl; $('setting-key').value = '';
  $('key-status').textContent = s.keyConfigured ? '已配置密钥。留空会保留；密钥仅由本机服务读取，不返回网页。' : '尚未配置密钥。也可通过服务的 GROQ_API_KEY 环境变量提供。';
  const models = [...s.models];
  if (!models.some(m => m.id === s.model)) models.push({ id: s.model, label: s.model });
  $('setting-model').innerHTML = models.map(m => `<option value="${escape(m.id)}">${escape(m.label)}</option>`).join('');
  $('setting-model').value = s.model;
  $('setting-fallbacks').value = s.fallbacks.join(', ');
  $('setting-beat').value = s.beatMinutes; $('setting-tokens').value = s.maxTokens;
  $('setting-hour').value = s.maxCallsHour; $('setting-day').value = s.maxCallsDay;
  $('setting-interval').value = s.minIntervalSeconds; $('setting-strict').value = String(s.strict);
  $('settings-error').textContent = ''; $('settings').showModal();
}
$('settings-form').onsubmit = async event => {
  event.preventDefault();
  try {
    await api('settings', { mode: $('setting-mode').value, baseUrl: $('setting-base').value, apiKey: $('setting-key').value,
      model: $('setting-model').value, fallbacks: $('setting-fallbacks').value.split(',').map(v => v.trim()).filter(Boolean),
      beatMinutes: Number($('setting-beat').value), maxTokens: Number($('setting-tokens').value),
      maxCallsHour: Number($('setting-hour').value), maxCallsDay: Number($('setting-day').value),
      minIntervalSeconds: Number($('setting-interval').value), strict: $('setting-strict').value === 'true' });
    $('setting-key').value = ''; $('settings').close(); await refresh(); toast('推演设置已保存');
  } catch (error) { $('settings-error').textContent = error.message; }
};
function miniScene(scene) {
  const boxes = scene.locations.map(p => `<rect x="${p.x - p.width / 2}" y="${p.z - p.depth / 2}" width="${p.width}" height="${p.depth}" rx="2" fill="${safeColor(p.color)}" opacity=".6"/>`).join('');
  const dots = scene.characters.map(c => `<circle cx="${c.x}" cy="${c.z}" r="2.5" fill="${safeColor(c.color)}"/>`).join('');
  return `<svg viewBox="0 0 100 100" aria-label="世界画面" style="width:100%;height:120px;background:#f1efe3;border-radius:6px;margin-top:8px">${boxes}${dots}</svg>`;
}
function renderMultiverse() {
  const lines = state.data.lines;
  $('universe-map').innerHTML = lines.map(line => `<article class="universe-node"><strong>${escape(line.name)}</strong><p>${line.parentId ? `↳ 源自 ${escape(lines.find(l => l.id === line.parentId)?.name || '另一条世界线')} · ${time(line.forkTime)}` : '独立世界的起点'}</p>${miniScene(line.scene)}<p>${time(line.worldTime)} · ${statusNames[line.status]}</p><button data-watch="${escape(line.id)}">进入世界</button> <button data-toggle="${escape(line.id)}">${line.paused ? '开始' : '暂停'}</button></article>`).join('');
  for (const id of ['compare-a', 'compare-b']) {
    const value = $(id).value;
    const html = lines.map(l => `<option value="${escape(l.id)}">${escape(l.name)}</option>`).join('');
    if ($(id).innerHTML !== html) {
      $(id).innerHTML = html;
      $(id).value = lines.some(l => l.id === value) ? value : id === 'compare-a' ? state.activeId : lines.find(l => l.id !== state.activeId)?.id || state.activeId;
    }
  }
  renderComparison();
}
function renderComparison() {
  const a = state.data.lines.find(l => l.id === $('compare-a').value);
  const b = state.data.lines.find(l => l.id === $('compare-b').value);
  if (!a || !b) return;
  const aIds = new Set(a.log.map(e => e.id));
  const shared = b.log.filter(e => aIds.has(e.id));
  const sharedIds = new Set(shared.map(e => e.id));
  $('shared-history').textContent = `共同历史 ${shared.length} 条。浅色为同一份历史记录，绿色边线为各自发展的事件。`;
  $('comparison').innerHTML = [a, b].map(line => `<section class="compare-column"><h3>${escape(line.name)}</h3>${line.log.map(e => `<article class="compare-entry ${sharedIds.has(e.id) ? 'shared' : ''}"><small>${time(e.time)} · ${e.kind === 'edit' ? '用户修改' : e.source === 'demo' ? '演示事件' : '故事记录'}</small>${escape(e.text)}${e.changes?.length ? `<p class="entry-changes">${e.changes.map(escape).join(' · ')}</p>` : ''}</article>`).join('')}</section>`).join('');
}
$('line-list').onclick = event => { const b = event.target.closest('[data-line]'); if (b) selectLine(b.dataset.line); };
$('pause').onclick = run(async () => { await api('control', { lineId: active().id, paused: !active().paused, retry: true }); await refresh(); });
$('speed').onchange = run(async event => { await api('control', { lineId: active().id, speed: Number(event.target.value) }); await refresh(); });
$('what-if').onclick = run(() => openEditor());
$('new-world').onclick = run(() => openEditor(true));
$('open-settings').onclick = openSettings;
$('open-multiverse').onclick = () => { renderMultiverse(); $('multiverse').showModal(); };
$('compare-a').onchange = renderComparison; $('compare-b').onchange = renderComparison;
$('universe-map').onclick = run(async event => {
  const watch = event.target.closest('[data-watch]');
  if (watch) { selectLine(watch.dataset.watch); $('multiverse').close(); return; }
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) { const line = state.data.lines.find(l => l.id === toggle.dataset.toggle); await api('control', { lineId: line.id, paused: !line.paused, retry: true }); await refresh(); }
});
for (const el of document.querySelectorAll('[data-close]')) el.onclick = () => $(el.dataset.close).close();
for (const el of document.querySelectorAll('[data-tab]')) el.onclick = () => {
  state.tab = el.dataset.tab; state.journalKey = '';
  for (const b of document.querySelectorAll('[data-tab]')) b.classList.toggle('selected', b === el);
  renderJournal();
};
for (const el of document.querySelectorAll('[data-view]')) el.onclick = () => {
  state.view = el.dataset.view;
  for (const b of document.querySelectorAll('[data-view]')) b.classList.toggle('selected', b === el);
  $('stages').classList.toggle('split', state.view === 'split');
  $('shell-2d').hidden = state.view === '3d'; $('shell-3d').hidden = state.view === '2d';
};
$('log-search').oninput = () => { state.journalKey = ''; renderJournal(); };
window.addEventListener('pagehide', () => { for (const stage of Object.values(stages)) stage.dispose(); });
await refresh();
setInterval(refresh, 1000);
