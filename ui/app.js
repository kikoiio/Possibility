import { inspectVoxelSpaces } from './geometry/voxel-inspection.js';

const $ = (id) => document.getElementById(id);
const ui = Object.fromEntries([
  'main', 'page-title', 'world-time', 'connection-label', 'connection-retry', 'more-menu',
  'new-world', 'world-resume', 'archive-controls', 'world-archives', 'world-open',
  'world-create', 'world-experience', 'dialogue-scroll', 'dialogue-log', 'dialogue-empty',
  'creation-summary', 'creation-summary-text', 'creation-status', 'creation-form', 'creation-input', 'creation-send',
  'creation-mode', 'creation-recovery', 'creation-retry', 'creation-adjust', 'voxel-status', 'voxel-empty', 'voxel-frame', 'voxel-interior', 'voxel-inspection',
  'source-input', 'source-status', 'source-remove', 'voxel-scene', 'voxel-undo', 'voxel-redo',
  'generate-actions', 'generate-hint', 'world-generate', 'world-draft', 'world-draft-scene',
  'world-draft-title', 'world-draft-description', 'world-draft-summary', 'draft-stale', 'world-accept',
  'scene-host', 'clock-state', 'play-pause', 'actor-step', 'actor-retry',
  'activity-scroll', 'activity-log', 'activity-empty', 'activity-new', 'world-status',
  'request-status', 'model-progress', 'model-phase', 'model-elapsed', 'model-cancel', 'operation-error',
].map((id) => [id, $(id)]));
const kinds = { origin: '起点', action: '行动', speech: '说话', environment: '环境', failure: '未完成' };
const list = (value) => Array.isArray(value) ? value : [];
const text = (value, fallback = '') => typeof value === 'string' && value.trim() ? value : fallback;
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const amount = (value) => finite(value) ? String(value) : '—';
const minute = (value) => finite(value) ? `第 ${amount(value)} 分钟` : '时间待同步';
const node = (tag, content = '', className = '') => {
  const element = document.createElement(tag);
  element.textContent = content;
  if (className) element.className = className;
  return element;
};
function setText(element, value) {
  const next = String(value ?? '');
  if (element.textContent !== next) element.textContent = next;
}

let state = null, connected = false, closed = false, lifecycle = 0;
let stateVersion = 0, eventVersion = 0, source = null, syncController = null;
let localTask = null, controlBusy = false, cancelBusy = false, cancelRequested = false;
let localError = '', composing = false, suppressEnterUntil = 0, suppressedDraft = null;
let progress = null, progressTimer = null, archiveSignature = '', draftSignature = '';
let activityWorld = null, activityRevision = null, activities = new Map(), activityNodes = new Map();
let following = true, unread = 0;
// The log moves only when the reader or a new fact moves it: layout must not
// reset a reading position, so there is no remembered offset to replay.
let pendingScroll = null;
const messageNodes = new Map();
let dialogueNotice = null;
const requests = new Set();
const slots = {
  draft: { host: ui['world-draft-scene'], key: null, token: 0, scene: null, latest: null, signature: '' },
  voxel: { host: ui['voxel-scene'], key: null, token: 0, scene: null, latest: null, signature: '' },
  world: { host: ui['scene-host'], key: null, token: 0, scene: null, latest: null, signature: '' },
};
const creating = () => state?.creation?.mode !== 'world';
const pending = () => Boolean(localTask || state?.model?.pending);
const activeKind = () => state?.model?.pending ? state.model.kind : localTask?.kind;
const waiting = () => state?.autonomy?.waitingReason || state?.waiting || '';
const retryable = () => Boolean(state?.autonomy?.waitingReason || text(state?.waiting).startsWith('actor:'));
const canPause = () => !creating() && (!state?.paused || (pending() && activeKind() === 'resident'));
const staleDraft = () => {
  const draft = state?.creation?.draft;
  return Boolean(draft) && (
    draft.baseConversationRevision !== undefined && draft.baseConversationRevision !== state?.creation?.dialogue?.revision ||
    draft.baseVoxelId !== state?.creation?.voxelId ||
    draft.baseVoxelRevision !== state?.creation?.voxel?.revision
  );
};
const currentDraft = () => {
  const draft = state?.creation?.draft;
  return activeKind() === 'creation' && pending() || draft?.id === suppressedDraft ? null : draft;
};
const latestRetry = () => { const a = list(state?.creation?.attempts).at(-1); return a && ['failed', 'cancelled', 'not-built'].includes(a.outcome) ? a : null; };
const canInspectOrigin = () => Boolean(state?.creation?.dialogue?.summary?.trim() && list(state?.creation?.dialogue?.messages).some(m => m.role === 'user'));
const resumableGeneration = () => {
  const g = state?.creation?.generation;
  return g && ['failed', 'cancelled'].includes(g.outcome) && g.conversationRevision === state.creation.dialogue.revision && g.voxelId === state.creation.voxelId && g.voxelRevision === state.creation.voxel?.revision ? g : null;
};
const nearBottom = (element) => element.scrollHeight - element.scrollTop - element.clientHeight < 48;

function setConnection(online, message) {
  connected = online;
  setText(ui['connection-label'], message);
  ui['connection-retry'].hidden = online;
  updateControls();
}
function updateControls() {
  const busy = !state || !connected || closed || controlBusy;
  const locked = busy || pending() || cancelBusy;
  ui['creation-mode'].disabled = locked || !creating();
  ui['creation-retry'].disabled = locked || !creating() || !latestRetry();
  ui['creation-adjust'].disabled = locked || !creating() || !latestRetry();
  ui['voxel-frame'].disabled = !slots.voxel.scene;
  ui['voxel-interior'].disabled = !slots.voxel.scene || !state?.creation?.voxel?.cells?.length;
  ui['creation-input'].disabled = locked || !creating();
  ui['creation-send'].disabled = locked || !creating() || composing || !ui['creation-input'].value.trim();
  ui['source-input'].disabled = locked || !creating();
  ui['source-remove'].disabled = locked || !creating() || !state?.creation?.source;
  ui['voxel-undo'].disabled = locked || !creating() || !state?.creation?.voxel?.canUndo;
  ui['voxel-redo'].disabled = locked || !creating() || !state?.creation?.voxel?.canRedo;
  ui['world-generate'].disabled = locked || !creating() || !canInspectOrigin();
  ui['world-accept'].disabled = locked || !creating() || !currentDraft() || staleDraft();
  ui['play-pause'].disabled = busy || creating() || (!canPause() && (pending() || Boolean(waiting())));
  setText(ui['play-pause'], canPause() ? '暂停' : '播放');
  ui['actor-step'].disabled = locked || creating() || !state?.paused || Boolean(waiting());
  ui['actor-retry'].hidden = creating() || !retryable() || pending();
  ui['actor-retry'].disabled = locked || !retryable();
  ui['model-cancel'].disabled = closed || !pending() || cancelBusy || cancelRequested;
  setText(ui['model-cancel'], cancelBusy || cancelRequested ? '正在取消…' : '取消');
  ui['new-world'].disabled = locked;
  ui['world-resume'].disabled = locked || !state?.creation?.hasWorld;
  ui['world-archives'].disabled = locked;
  ui['world-open'].disabled = locked || !ui['world-archives'].value;
  ui['creation-form'].setAttribute('aria-busy', String(Boolean(localTask?.kind === 'discussion' || state?.model?.pending && activeKind() === 'discussion')));
}
function takeProgress(next) {
  if (!next || !['connecting', 'generating', 'receiving', 'verifying', 'committing'].includes(next.phase)) return;
  // Progress is temporary UI only. Neither model output nor reasoning enters the feed.
  progress = { stageLabel: text(next.stageLabel), phase: next.phase, elapsedMs: finite(next.elapsedMs) ? Math.max(0, next.elapsedMs) : 0,
    headersReceivedMs: finite(next.headersReceivedMs) ? next.headersReceivedMs : null,
    firstTextMs: finite(next.firstTextMs) ? next.firstTextMs : null, at: performance.now() };
}
function failureText(result) {
  if (result?.attemptId) return text(result.message, '这次请求未完成，输入已保留。');
  if (result?.generationId) return `${text(result.message, '起点检查未通过。')} 可继续生成，或调整描述后重新生成。`;
  const diagnostics = list(result?.diagnostics).slice(0, 3).map((item) => {
    if (typeof item === 'string') return item;
    return `${text(item?.message, '未通过检查')}${item?.path ? `（${item.path}）` : ''}`;
  });
  return [text(result?.message, '这次操作没有完成，请重试。'), ...diagnostics].join(' ');
}
function renderStatus() {
  const busy = pending();
  ui['model-progress'].hidden = !busy;
  if (busy) {
    const kind = activeKind();
    const actor = list(state?.world?.actors).find((entry) => entry.id === (state?.model?.actorId || localTask?.actorId));
    const verifying = progress?.phase === 'verifying';
    const label = progress?.phase === 'committing' ? '正在保存本次变化' : kind === 'discussion'
      ? progress?.phase === 'connecting' ? '正在连接模型'
        : progress?.phase === 'generating' ? '模型已连接，正在生成回复'
          : progress?.phase === 'receiving' ? '正在接收模型回复'
            : '正在检查建造步骤与当前场景'
      : kind === 'creation' ? verifying ? '正在核验地点、人物与规律' : progress?.stageLabel || '正在生成这一小片世界'
      : verifying ? `正在核验${text(actor?.name, '人物')}的行动` : `${text(actor?.name, '人物')}正在考虑下一步`;
    setText(ui['model-phase'], cancelRequested || cancelBusy ? '正在停止这次请求' : label);
    const seconds = Math.floor(((progress?.elapsedMs || 0) + Math.max(0, performance.now() - (progress?.at ?? performance.now()))) / 1000);
    setText(ui['model-elapsed'], `已等待 ${seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`}${seconds >= 30 ? ' · 尚无可提交结果，可取消并保留输入' : ''}`);
  }
  const last = creating() ? state?.creation?.lastResult : waiting() ? state?.model?.lastResult : null;
  const serverError = !busy && last?.ok === false ? failureText(last) : '';
  const waitError = !busy && waiting() && !creating() ? (retryable() ? '这次行动没有完成。点击重试后，可以下一步或播放。' : '世界暂时无法继续。可从更多中返回创建页或切换存档。') : '';
  const error = localError || serverError || waitError;
  setText(ui['operation-error'], error);
  ui['operation-error'].hidden = !error;
  if (!creating()) setText(ui['clock-state'], waiting() ? '等待处理' : state?.paused ? '已暂停' : '生活继续');
}

function renderMenu() {
  ui['new-world'].hidden = creating();
  ui['world-resume'].hidden = !creating() || !state?.creation?.hasWorld;
  const worlds = list(state?.creation?.worlds);
  ui['archive-controls'].hidden = !worlds.length;
  ui['more-menu'].hidden = creating() && !state?.creation?.hasWorld && !worlds.length;
  const signature = JSON.stringify(worlds);
  if (signature !== archiveSignature) {
    archiveSignature = signature;
    const selected = ui['world-archives'].value;
    ui['world-archives'].replaceChildren(...worlds.map((world) => {
      const option = node('option', `${text(world.title, '未命名世界')} · ${minute(world.worldMinute)}`);
      option.value = world.id;
      return option;
    }));
    ui['world-archives'].value = worlds.some((world) => world.id === selected) ? selected : worlds[0]?.id || '';
  }
}
function renderDialogue() {
  const dialogue = state?.creation?.dialogue || {};
  const sourceMaterial = state?.creation?.source;
  setText(ui['source-status'], sourceMaterial ? `已添加：${sourceMaterial.name}（${sourceMaterial.characters} 字）` : '还没有添加素材，也可以直接开始对话。');
  ui['source-remove'].hidden = !sourceMaterial;
  const messages = list(dialogue.messages).filter((entry) => entry?.id && ['user', 'assistant'].includes(entry.role) && typeof entry.text === 'string');
  const visibleMessages = messages.slice(-12);
  const hiddenCount = messages.length - visibleMessages.length;
  const follow = nearBottom(ui['dialogue-scroll']);
  const wanted = new Set(visibleMessages.map((entry) => entry.id));
  for (const [id, item] of messageNodes) if (!wanted.has(id)) { item.remove(); messageNodes.delete(id); }
  if (hiddenCount) {
    if (!dialogueNotice) dialogueNotice = node('li', '', 'dialogue-collapsed');
    setText(dialogueNotice, `${hiddenCount} 条较早消息已收起`);
    if (ui['dialogue-log'].firstElementChild !== dialogueNotice) ui['dialogue-log'].prepend(dialogueNotice);
  } else if (dialogueNotice) {
    dialogueNotice.remove(); dialogueNotice = null;
  }
  visibleMessages.forEach((message, index) => {
    let item = messageNodes.get(message.id);
    if (!item) {
      item = node('li');
      item.append(node('span', '', 'message-author'), node('p', '', 'message-text'), node('div', '', 'attempt-result'));
      messageNodes.set(message.id, item);
    }
    item.className = message.role === 'user' ? 'message-user' : 'message-assistant';
    setText(item.children[0], message.role === 'user' ? '你' : 'Wispiva');
    setText(item.children[1], message.text);
    const attempt = list(state?.creation?.attempts).find(a => a.id === message.attemptId);
    const resultNode = item.children[2];
    const signature = JSON.stringify(attempt);
    if (resultNode.dataset.signature !== signature) {
      resultNode.dataset.signature = signature;
      resultNode.replaceChildren();
      if (attempt) {
        const labels = { committed: '已保存', unchanged: '没有变化', discussion: '仅讨论', failed: '未完成', cancelled: '已取消', 'not-built': '尚未建造' };
        resultNode.dataset.outcome = attempt.outcome;
        resultNode.append(node('strong', labels[attempt.outcome] || '等待结果'), node('p', attempt.message));
        if (attempt.timings?.calls) resultNode.append(node('p', `场景版本 ${attempt.fromRevision} → ${attempt.toRevision} · ${(attempt.timings.totalMs / 1000).toFixed(1)} 秒 · ${attempt.timings.calls.filter(c => c.requestSent).length} 次模型请求`, 'attempt-timing'));
        const details = list(attempt.diagnostics).concat(list(attempt.adjustments));
        if (details.length) {
          const disclosure = node('details'), summary = node('summary', '检查详情');
          disclosure.append(summary, ...details.map(d => node('p', `${d.path}：${d.message}`)));
          resultNode.append(disclosure);
        }
      }
    }
    resultNode.hidden = !attempt;
    resultNode.dataset.attemptId = attempt?.id || '';
    item.children[1].hidden = Boolean(attempt && message.text === attempt.message);
    if (attempt && message.text !== attempt.message) setText(item.children[0], 'Wispiva · 方案说明');
    const slot = hiddenCount ? index + 1 : index;
    if (ui['dialogue-log'].children[slot] !== item) ui['dialogue-log'].insertBefore(item, ui['dialogue-log'].children[slot] || null);
  });
  ui['dialogue-empty'].hidden = Boolean(messages.length);
  if (follow) ui['dialogue-scroll'].scrollTop = ui['dialogue-scroll'].scrollHeight;
  ui['creation-recovery'].hidden = !latestRetry() || pending();
  if (localTask?.kind === 'discussion' && messages.some(entry => entry.role === 'user' && !localTask.messageIds.has(entry.id) && entry.text === localTask.message)) {
    if (ui['creation-input'].value.trim() === localTask.message) ui['creation-input'].value = '';
  }
  ui['creation-summary'].hidden = !text(dialogue.summary);
  setText(ui['creation-summary-text'], text(dialogue.summary));
  ui['generate-actions'].hidden = !canInspectOrigin();
  setText(ui['world-generate'], resumableGeneration() ? '继续生成起点草稿' : state?.creation?.draft ? '重新生成起点草稿' : '查看起点草稿');
  setText(ui['generate-hint'], resumableGeneration() ? `已完成 ${resumableGeneration().completedStages.length} / 3 个步骤。继续时会沿用这些结果。` : staleDraft() ? '新的想法需要一份新草稿。' : '可以先检查起点，也可以继续聊。');
}
function draftLines(world) {
  const place = (id) => text(list(world.places).find((entry) => entry.id === id)?.name, id || '起点');
  const resource = (id) => list(world.resources).find((entry) => entry.id === id) || {};
  const effects = (entries) => list(entries).map((entry) => `${text(resource(entry.resourceId).name, entry.resourceId)} ${amount(entry.amount)}${text(resource(entry.resourceId).unit)}`).join('、');
  const conditions = (entries) => list(entries).map((entry) => `${text(resource(entry.resourceId).name, entry.resourceId)} ${entry.op === 'gte' ? '≥' : '≤'} ${amount(entry.value)}${text(resource(entry.resourceId).unit)}`).join(' 且 ');
  const rules = ['人物可以移动、观察和休息，每次完成行动后时间推进。'];
  if (world.story) {
    rules.push('只沿相连地点移动；说话只有同处的人听见，每个人保留自己的经历。');
    if (list(world.story.clues).length) rules.push('人物可以检查所在地点的线索，发现的内容进入本人的记忆。');
    const links = list(world.story.connections).map((entry) => `${place(entry.from)} ↔ ${place(entry.to)}`);
    if (links.length) rules.push(`相连地点：${links.join('；')}`);
  }
  if (list(world.resources).length) rules.push(`起始资源：${world.resources.map((entry) => `${entry.name} ${amount(entry.quantity)} / ${amount(entry.capacity)}${text(entry.unit)}`).join('；')}`);
  for (const process of list(world.processes)) rules.push(`${list(process.when).length ? `满足 ${conditions(process.when)} 时，` : '持续运行，'}每分钟${text(resource(process.resourceId).name, process.resourceId)}${process.deltaPerMinute < 0 ? '减少' : '增加'} ${amount(Math.abs(process.deltaPerMinute))}${text(resource(process.resourceId).unit)}。`);
  if (list(world.processes).length) rules.push('每分钟开始时判断全部运行条件，资源增减受 0 与容量限制。');
  for (const action of list(world.actions)) rules.push(`${text(action.name, action.id)}（${place(action.location)}）：${list(action.requires).length ? `需要 ${conditions(action.requires)}；` : ''}${list(action.costs).length ? `消耗 ${effects(action.costs)}` : '无需消耗资源'}${list(action.gains).length ? `；获得 ${effects(action.gains)}` : ''}。`);
  if (list(world.actions).length) rules.push('行动只在所在地点执行；前提、所需资源或容量不足时，不会产生效果。');
  return [
    ['地方', list(world.places).map((entry) => `${text(entry.name, entry.id)}：${text(entry.description, '起点地点')}`)],
    ['人物', list(world.actors).map((entry) => `${text(entry.name, entry.id)}${entry.role ? `（${entry.role}）` : ''}，在${place(entry.location)}${entry.goal ? `；${entry.goal}` : ''}`)],
    ['可执行规律', rules],
  ];
}
function renderDraft() {
  const draft = currentDraft();
  ui['world-draft'].hidden = !draft;
  ui['world-create'].classList.toggle('has-draft', Boolean(draft));
  if (!draft) { releaseScene(slots.draft); draftSignature = ''; return; }
  const world = draft.definition?.world;
  if (!world) return;
  setText(ui['world-draft-title'], text(world.title, '世界草稿'));
  setText(ui['world-draft-description'], text(world.description));
  ui['draft-stale'].hidden = !staleDraft();
  const lines = draftLines(world);
  const signature = JSON.stringify([draft.id, lines]);
  if (signature !== draftSignature) {
    draftSignature = signature;
    ui['world-draft-summary'].replaceChildren(...lines.flatMap(([title, entries]) => {
      const description = node('dd'), items = node('ul');
      items.append(...entries.map((entry) => node('li', entry)));
      description.append(items);
      return [node('dt', title), description];
    }));
  }
  if (list(state.creation.voxel?.cells).length) { syncVoxel(slots.draft, `voxel-draft:${draft.id}`, state.creation.voxel); return; }
  syncScene(slots.draft, draft.id, { world, scene: { document: draft.definition.scene, revision: 0 }, paused: true, worldMinute: 0, revision: 0 });
}

function updateUnread() {
  ui['activity-new'].hidden = following || unread === 0;
  setText(ui['activity-new'], `${unread} 条新动态 · 回到底部`);
}
// Splits "风能电池 4 → 6 格" into label, change and unit. Only the arrow form is
// touched: any other text stays one plain string, so nothing is reinterpreted.
const changePattern = /^(.*?)(\d+)\s*(?:→|->)\s*(\d+)(.*)$/u;
function renderActivityText(element, value) {
  const match = changePattern.exec(value || '');
  if (!match) { element.textContent = value || ''; return; }
  const [, label, before, after, tail] = match;
  if (!label.trim()) { element.textContent = value; return; }
  // Compare against the element we already rendered: rebuilding identical
  // children on every push would drop selection and cause needless layout.
  if (element.dataset.change === `${label}|${before}|${after}|${tail}`) return;
  element.dataset.change = `${label}|${before}|${after}|${tail}`;
  const line = node('span', '', 'activity-change');
  line.append(node('span', label.trim(), 'change-label'));
  const delta = Number(after) - Number(before);
  const chip = node('span', '', `change-chip ${delta > 0 ? 'is-up' : delta < 0 ? 'is-down' : 'is-flat'}`);
  chip.append(node('b', before), node('span', '→', 'change-arrow'), node('b', after));
  line.append(chip);
  if (tail.trim()) line.append(node('span', tail.trim(), 'change-tail'));
  element.replaceChildren(line);
}
function renderActivity(next) {
  const key = next.instanceId || next.genesis?.instanceId || next.genesis?.draftId || next.world?.title;
  const reset = key !== activityWorld || finite(activityRevision) && finite(next.revision) && next.revision < activityRevision;
  if (reset) {
    activities.clear(); activityNodes.clear(); ui['activity-log'].replaceChildren();
    // Opening or returning to a world starts at the newest fact; only scrolling
    // away from the bottom turns following off.
    following = true; unread = 0; activityWorld = key;
  }
  activityRevision = next.revision;
  const scroll = ui['activity-scroll'];
  const wasFollowing = following;
  const top = scroll.getBoundingClientRect().top;
  const anchor = !wasFollowing ? [...ui['activity-log'].children].find((entry) => entry.getBoundingClientRect().bottom > top) : null;
  const anchorTop = anchor?.getBoundingClientRect().top;
  const previous = new Set(activities.keys());
  for (const entry of list(next.activity)) {
    if (!entry || typeof entry.id !== 'string' || !entry.id || !Object.hasOwn(kinds, entry.kind) || typeof entry.text !== 'string') continue;
    // Store just display fields, never the complete state or model payload.
    activities.set(entry.id, { id: entry.id, revision: finite(entry.revision) ? entry.revision : 0, minute: entry.minute, kind: entry.kind, text: entry.text, detail: text(entry.detail) });
  }
  // An older backend can publish its rules as an environment entry at the
  // world's base revision. The panel already lists those rules under "正在发生",
  // so that entry would read as a stray line perched on the panel edge.
  const entries = [...activities.values()]
    .filter((entry) => !(entry.kind === 'environment' && entry.revision === 0 && !entry.detail))
    .sort((a, b) => a.revision - b.revision).slice(-300);
  activities = new Map(entries.map((entry) => [entry.id, entry]));
  for (const [id, item] of activityNodes) if (!activities.has(id)) { item.remove(); activityNodes.delete(id); }
  entries.forEach((entry, index) => {
    let item = activityNodes.get(entry.id);
    if (!item) {
      item = node('li'); item.dataset.activityId = entry.id;
      const meta = node('div', '', 'activity-meta'); meta.append(node('time'), node('span'));
      item.append(meta, node('p', '', 'activity-text'), node('p', '', 'activity-detail'));
      activityNodes.set(entry.id, item);
    }
    item.className = `activity-${entry.kind}`;
    setText(item.children[0].children[0], minute(entry.minute));
    setText(item.children[0].children[1], kinds[entry.kind]);
    // Resource changes are stated as "A → B" text; render that arrow as its own
    // element so a change reads as a change and not as part of a sentence.
    renderActivityText(item.children[1], entry.text);
    setText(item.children[2], entry.detail);
    item.children[2].hidden = !entry.detail;
    if (ui['activity-log'].children[index] !== item) ui['activity-log'].insertBefore(item, ui['activity-log'].children[index] || null);
  });
  ui['activity-empty'].hidden = entries.length > 0;
  if (wasFollowing) { scroll.scrollTop = scroll.scrollHeight; pendingScroll = scroll.scrollTop; unread = 0; }
  else {
    if (anchor?.parentNode) scroll.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    unread = Math.min(300, unread + entries.filter((entry) => !previous.has(entry.id)).length);
  }
  updateUnread();
}

function releaseScene(slot) {
  if (!slot.key && !slot.scene) return;
  slot.token++;
  try { slot.scene?.dispose(); } catch { /* Only release this slot's resources. */ }
  slot.scene = null; slot.key = null; slot.signature = ''; slot.latest = null;
  slot.host.replaceChildren();
}
function sceneFailure(slot, token) {
  if (token !== slot.token || closed) return;
  try { slot.scene?.dispose(); } catch { /* The text view remains usable. */ }
  slot.scene = null;
  const error = node('div', '', 'scene-error');
  error.append(node('p', '场景暂时无法显示，可以继续查看文字。'));
  const retry = node('button', '重新载入场景', 'button secondary'); retry.type = 'button';
  retry.addEventListener('click', () => {
    const key = slot.key, latest = slot.latest;
    releaseScene(slot);
    if (latest && !closed) syncScene(slot, key, latest);
  });
  error.append(retry); slot.host.replaceChildren(error);
}
function syncScene(slot, key, next) {
  if (closed || !next.world || !next.scene?.document) { releaseScene(slot); return; }
  // This runs just before a layout pass, which resets a scroller's offset to
  // its top. Re-applying the current position keeps the reader where any new
  // facts or a narrower panel would otherwise have dropped them.
  const scroll = ui['activity-scroll'];
  scroll.scrollTop = pendingScroll ?? scroll.scrollTop; pendingScroll = null;
  // The weather is part of the scene itself (sky, fog and light), so a weather
  // change alone has to reach the renderer.
  const signature = `${next.revision}:${next.worldMinute}:${next.paused}:${next.scene.revision ?? 0}:${next.world.environment?.weather ?? ''}`;
  if (slot.key === key) {
    slot.latest = next;
    if (slot.scene && slot.signature !== signature) {
      try { slot.scene.update(next); } catch { sceneFailure(slot, slot.token); }
    }
    slot.signature = signature;
    return;
  }
  releaseScene(slot);
  slot.key = key; slot.latest = next; slot.signature = signature;
  const token = ++slot.token;
  // Give each asynchronous renderer its own mount. A late renderer can never
  // replace the current host; its detached mount is disposed when it resolves.
  const mount = node('div', '', 'scene-mount');
  slot.host.replaceChildren(mount);
  void import('./scene.js').then(async ({ createScene }) => {
    if (closed || token !== slot.token) return;
    const created = await createScene(mount, slot.latest);
    if (closed || token !== slot.token) { created?.dispose(); return; }
    slot.scene = created;
    created.update(slot.latest);
  }).catch(() => sceneFailure(slot, token));
}

function syncVoxel(slot, key, world) {
  if (slot === slots.voxel && ui['voxel-inspection'].dataset.signature !== `${key}/${world.revision}`) {
    const inspection = inspectVoxelSpaces(world), host = ui['voxel-inspection'];
    host.dataset.signature = `${key}/${world.revision}`;
    host.replaceChildren();
    host.hidden = !inspection.issues.length;
    if (inspection.issues.length) host.append(node('summary', `空间检查 · ${inspection.issues.length} 项待处理`),
      ...inspection.issues.map(i => node('p', i.message)), node('p', '检查仅覆盖单层矩形建筑。保存的变化可以继续修改，外观仍需你查看。'));
  }
  const signature = JSON.stringify([world.revision, world.actors || []]);
  const accepted = () => {
    slot.host.dataset.revision = String(world.revision);
    if (slot === slots.voxel) {
      setText(ui['voxel-status'], world.error || `画布版本 ${world.revision} · ${list(world.cells).length} 个方块 · ${list(world.objects).length} 个对象`);
      ui['voxel-empty'].hidden = Boolean(world.error || list(world.cells).length);
      updateControls();
    }
  };
  if (slot.key === key) {
    slot.latest = world;
    if (slot.scene && slot.signature !== signature) {
      try { slot.scene.update(world); slot.signature = signature; accepted(); } catch { voxelFailure(slot, slot.token); }
    }
    return;
  }
  releaseScene(slot);
  slot.key = key; slot.latest = world;
  if (slot === slots.voxel) {
    setText(ui['voxel-status'], '正在更新画布…');
    ui['voxel-empty'].hidden = true;
    ui['voxel-interior'].setAttribute('aria-pressed', 'false');
    setText(ui['voxel-interior'], '查看室内');
  }
  const token = ++slot.token;
  const mount = node('div', '', 'scene-mount');
  slot.host.replaceChildren(mount);
  void import('./voxel-scene.js').then(async ({ createVoxelScene }) => {
    if (closed || token !== slot.token) return;
    const scene = await createVoxelScene(mount, slot.latest);
    if (closed || token !== slot.token) { scene?.dispose(); return; }
    slot.scene = scene;
    scene.update(slot.latest);
    slot.signature = JSON.stringify([slot.latest.revision, slot.latest.actors || []]);
    slot.host.dataset.revision = String(slot.latest.revision);
    if (slot === slots.voxel) {
      const latest = slot.latest;
      setText(ui['voxel-status'], latest.error || `画布版本 ${latest.revision} · ${list(latest.cells).length} 个方块 · ${list(latest.objects).length} 个对象`);
      ui['voxel-empty'].hidden = Boolean(latest.error || list(latest.cells).length);
      updateControls();
    }
  }).catch(() => voxelFailure(slot, token));
}
function voxelFailure(slot, token) {
  if (closed || token !== slot.token) return;
  try { slot.scene?.dispose(); } catch { /* Conversation remains available. */ }
  slot.scene = null;
  if (slot === slots.voxel) { setText(ui['voxel-status'], '草稿状态已收到，画面载入失败。'); ui['voxel-empty'].hidden = true; }
  const error = node('div', '', 'scene-error');
  error.append(node('p', '画面暂时无法显示，你仍可以继续对话。'));
  const retry = node('button', '重新载入画面', 'button secondary');
  retry.type = 'button';
  retry.addEventListener('click', () => {
    const key = slot.key, latest = slot.latest;
    releaseScene(slot);
    if (!closed) syncVoxel(slot, key, latest);
  });
  error.append(retry);
  slot.host.replaceChildren(error);
}

function applyState(next) {
  if (closed) return;
  if (!next?.creation || !['create', 'world'].includes(next.creation.mode) || next.creation.mode === 'world' && !next.world) throw new Error('世界状态不完整，请重新连接。');
  const previousMode = state?.creation?.mode;
  const previousModel = state?.model;
  if (next.model?.pending && (!previousModel?.pending || previousModel.kind !== next.model.kind || previousModel.actorId !== next.model.actorId)) {
    progress = { phase: 'connecting', elapsedMs: 0, at: performance.now() };
    localError = '';
  }
  state = next; stateVersion++;
  if (next.model?.pending) takeProgress(next.model.progress);
  if (!pending()) cancelRequested = false;
  const isCreate = creating();
  ui['world-create'].hidden = !isCreate;
  ui['world-experience'].hidden = isCreate;
  ui['world-time'].hidden = isCreate;
  setText(ui['page-title'], isCreate ? '从想法开始' : text(next.world.title, '世界'));
  document.title = isCreate ? '从想法开始 · Wispiva' : `${text(next.world.title, '世界')} · Wispiva`;
  const target = isCreate ? ui['creation-status'] : ui['world-status'];
  if (ui['request-status'].parentNode !== target) target.append(ui['request-status']);
  renderMenu();
  if (isCreate) {
    releaseScene(slots.world); renderDialogue(); renderDraft();
    if (currentDraft()) releaseScene(slots.voxel);
    else syncVoxel(slots.voxel, next.creation.voxelId || 'creation', next.creation.voxel || { revision: 0, cells: [], objects: [] });
  }
  else {
    releaseScene(slots.draft); releaseScene(slots.voxel);
    setText(ui['world-time'], minute(next.worldMinute));
    // Weather and resource totals now live in scene chips and in the activity
    // list; the old bottom bar repeated them across the full width.
    renderActivity(next);
    const worldKey = next.instanceId || next.genesis?.instanceId || next.genesis?.draftId || next.world.title;
    const voxel = next.genesis?.voxel;
    if (list(voxel?.cells).length) syncVoxel(slots.world, `voxel:${worldKey}`, { ...voxel, actors: list(next.voxelActors) });
    else syncScene(slots.world, `world:${worldKey}`, next);
  }
  updateControls(); renderStatus();
  if (previousMode && previousMode !== next.creation.mode) {
    ui['more-menu'].open = false;
    (isCreate ? ui['creation-input'] : ui.main).focus({ preventScroll: true });
  }
}
function applyReply(result, version) {
  // A delayed HTTP response must not undo a newer push (including pause or
  // world switching at the same world revision). The next push aligns it.
  if (result?.state && (version === eventVersion || !connected)) applyState(result.state);
}
async function readState() {
  syncController?.abort();
  const controller = new AbortController(), version = stateVersion, life = lifecycle;
  syncController = controller;
  try {
    const response = await fetch('/api/state', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`状态读取失败（HTTP ${response.status}）。`);
    const next = await response.json();
    if (closed || life !== lifecycle || controller.signal.aborted || version !== stateVersion) return;
    applyState(next);
    if (!source || source.readyState !== 0) setConnection(true, '已连接');
  } catch (error) {
    if (!closed && life === lifecycle && !controller.signal.aborted && version === stateVersion) {
      localError = `${text(error.message, '无法读取世界状态。')} 请重新连接。`;
      setConnection(false, '连接中断，正在重连'); renderStatus();
    }
  } finally { if (syncController === controller) syncController = null; }
}
function connect() {
  if (closed) return;
  source?.close(); source = null;
  setConnection(false, '正在连接…');
  if (typeof EventSource === 'function') {
    const stream = new EventSource('/api/events'); source = stream;
    stream.addEventListener('state', (event) => {
      if (closed || source !== stream) return;
      try {
        const next = JSON.parse(event.data);
        eventVersion++;
        applyState(next);
        localError = '';
        setConnection(true, '已连接'); renderStatus();
      } catch {
        setConnection(false, '状态同步失败');
        localError = '收到的世界状态不完整，请重新连接。'; renderStatus();
      }
    });
    stream.addEventListener('error', () => {
      if (closed || source !== stream) return;
      setConnection(false, '连接中断，正在重连');
    });
  }
  void readState();
}

async function postJSON(path, body, controller) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
  const result = await response.json().catch(() => { throw new Error(`服务没有返回可读结果（HTTP ${response.status}）。`); });
  if (!response.ok && result.ok !== false) return { ...result, ok: false, message: text(result.message, `操作未完成（HTTP ${response.status}）。`) };
  return result;
}
async function control(body) {
  if (closed || !state || !connected || controlBusy || pending() && body.type !== 'pause') return;
  const controller = new AbortController(), version = eventVersion, life = lifecycle;
  let navigated = false;
  requests.add(controller); controlBusy = true; localError = '';
  updateControls(); renderStatus();
  try {
    const result = await postJSON('/api/control', body, controller);
    if (closed || life !== lifecycle) return;
    applyReply(result, version);
    if (result.ok === false) localError = failureText(result);
    else if (['creation-open', 'creation-resume', 'world-open', 'world-accept'].includes(body.type)) {
      navigated = true;
      ui['more-menu'].open = false;
      if (body.type === 'creation-open') ui['creation-input'].value = '';
    }
  } catch (error) {
    if (!closed && life === lifecycle) { localError = `${text(error.message, '操作未完成。')} 请确认连接后重试。`; void readState(); }
  } finally {
    requests.delete(controller);
    if (!closed && life === lifecycle) {
      controlBusy = false; updateControls(); renderStatus();
      if (navigated) (creating() ? ui['creation-input'] : ui.main).focus({ preventScroll: true });
    }
  }
}

// Parse SSE across arbitrary UTF-8 / CR / LF / CRLF chunk boundaries.
function eventParser(onEvent) {
  let line = '', skipLF = false, type = 'message', data = [], size = 0;
  const consume = () => {
    if (line === '') {
      const event = type, payload = data.join('\n'), hasData = data.length > 0;
      type = 'message'; data = []; size = 0;
      if (hasData && (event === 'progress' || event === 'result')) {
        let value;
        try { value = JSON.parse(payload); } catch { throw new Error('回复流格式不完整，请检查连接后重试。'); }
        onEvent(event, value);
      }
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') type = value;
      if (field === 'data') { data.push(value); size += value.length; }
    }
    line = '';
  };
  return (chunk) => {
    for (const char of chunk) {
      if (skipLF) { skipLF = false; if (char === '\n') continue; }
      if (char === '\r' || char === '\n') { consume(); skipLF = char === '\r'; }
      else line += char;
      if (line.length + size > 4 * 1024 * 1024) throw new Error('单次回复过长，已停止读取。请重新连接查看最新状态。');
    }
  };
}
async function streamStep(path, body, task) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(path === '/api/creation-chat' ? { baseVoxelRevision: state?.creation?.voxel?.revision, voxelId: state?.creation?.voxelId, conversationRevision: state?.creation?.dialogue?.revision, ...body } : body), signal: task.controller.signal });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    return { ...result, ok: false, message: text(result.message, `请求失败（HTTP ${response.status}）。`) };
  }
  if (!response.body || !response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream')) {
    await response.body?.cancel();
    throw new Error('没有收到回复流，请重新连接后重试。');
  }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let result = null;
  const parse = eventParser((event, data) => {
    if (result || closed || localTask !== task) return;
    if (event === 'progress') { takeProgress(data); renderStatus(); }
    else {
      if (typeof data?.ok !== 'boolean') throw new Error('回复结果不完整，请重新连接查看最新状态。');
      result = data;
    }
  });
  try {
    while (!result) {
      const { value, done } = await reader.read();
      parse(done ? decoder.decode() : decoder.decode(value, { stream: true }));
      if (done) break;
    }
    if (!result) throw new Error('连接中断，未收到完整回复。请重新连接查看已保存内容，再继续。');
    return result;
  } finally {
    try { await reader.cancel(); } catch { /* Already closed or aborted. */ }
    reader.releaseLock();
  }
}
async function runStep(kind, path, body) {
  if (closed || pending() || controlBusy || !connected) return;
  const task = { kind, controller: new AbortController(), message: body.message, messageIds: new Set(list(state?.creation?.dialogue?.messages).map((entry) => entry.id)), actorId: state?.autonomy?.nextActorId };
  const version = eventVersion, life = lifecycle;
  localTask = task; localError = ''; cancelRequested = false;
  progress = { phase: 'connecting', elapsedMs: 0, at: performance.now() };
  if (kind === 'creation') { suppressedDraft = state?.creation?.draft?.id || null; renderDraft(); }
  updateControls(); renderStatus();
  let failedTransport = false;
  try {
    const result = await streamStep(path, body, task);
    if (closed || life !== lifecycle) return;
    applyReply(result, version);
    if (!result.ok && !(kind === 'resident' && result.reason === 'cancelled' && !waiting())) localError = failureText(result);
    if (kind === 'discussion' && (result.ok || result.attempt) && ui['creation-input'].value.trim() === task.message) ui['creation-input'].value = '';
  } catch (error) {
    if (!closed && life === lifecycle) { localError = text(error.message, '这次请求没有完成，请重试。'); failedTransport = true; }
  } finally {
    if (localTask === task) localTask = null;
    if (!closed && life === lifecycle) {
      if (!state?.model?.pending) cancelRequested = false;
      if (creating()) { renderDialogue(); renderDraft(); }
      updateControls(); renderStatus();
      if (kind === 'discussion' && !ui['creation-input'].disabled) ui['creation-input'].focus({ preventScroll: true });
      if (failedTransport) void readState();
    }
  }
}
async function cancelModel() {
  if (!pending() || cancelBusy || cancelRequested || closed) return;
  const controller = new AbortController(), version = eventVersion, life = lifecycle;
  requests.add(controller); cancelBusy = true; localError = '';
  updateControls(); renderStatus();
  try {
    const result = await postJSON('/api/model-cancel', {}, controller);
    if (closed || life !== lifecycle) return;
    applyReply(result, version);
    if (result.ok === false) localError = failureText(result);
    else cancelRequested = pending();
  } catch (error) { if (!closed && life === lifecycle) localError = text(error.message, '取消请求未送达，请再次尝试。'); }
  finally {
    requests.delete(controller);
    if (!closed && life === lifecycle) { cancelBusy = false; updateControls(); renderStatus(); }
  }
}

ui['creation-form'].addEventListener('submit', (event) => {
  event.preventDefault();
  if (ui['creation-send'].disabled || composing || performance.now() < suppressEnterUntil) return;
  return runStep('discussion', '/api/creation-chat', { message: ui['creation-input'].value.trim(), mode: ui['creation-mode'].value || 'build' });
});
ui['creation-input'].addEventListener('input', updateControls);
ui['creation-retry'].addEventListener('click', () => {
  if (!ui['creation-retry'].disabled && latestRetry()) return runStep('discussion', '/api/creation-chat', { retryAttemptId: latestRetry().id });
});
ui['creation-adjust'].addEventListener('click', () => {
  const a = latestRetry();
  if (ui['creation-adjust'].disabled || !a) return;
  ui['creation-input'].value = list(state.creation.dialogue.messages).find(m => m.id === a.userMessageId)?.text || '';
  ui['creation-mode'].value = a.mode === 'discuss' ? 'discuss' : 'build';
  updateControls(); ui['creation-input'].focus();
});
ui['voxel-frame'].addEventListener('click', () => slots.voxel.scene?.frame?.());
ui['voxel-interior'].addEventListener('click', () => {
  const cutaway = ui['voxel-interior'].getAttribute('aria-pressed') !== 'true';
  slots.voxel.scene?.cutaway?.(cutaway);
  ui['voxel-interior'].setAttribute('aria-pressed', String(cutaway));
  setText(ui['voxel-interior'], cutaway ? '显示屋顶' : '查看室内');
});
ui['source-input'].addEventListener('change', async () => {
  const file = ui['source-input'].files?.[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('文件过大，请选择不超过 500 万字的文本。大文本会按需检索。');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
    if (!content.trim() || content.length > 5_000_000) throw new Error('请选择不超过 500 万字的非空文本文件。大文本会按需检索。');
    await control({ type: 'source-set', source: { name: file.name.slice(0, 120), text: content } });
  } catch (error) {
    localError = error instanceof TypeError ? '无法读取文本，请确认文件使用 UTF-8 编码。' : text(error.message, '无法读取文件。');
    renderStatus();
  } finally { ui['source-input'].value = ''; }
});
ui['source-remove'].addEventListener('click', () => control({ type: 'source-set', source: null }));
ui['creation-input'].addEventListener('compositionstart', () => { composing = true; updateControls(); });
ui['creation-input'].addEventListener('compositionend', () => { composing = false; suppressEnterUntil = performance.now() + 80; updateControls(); });
ui['creation-input'].addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229 || composing || performance.now() < suppressEnterUntil) return;
  event.preventDefault();
  if (!ui['creation-send'].disabled) ui['creation-form'].requestSubmit();
});
for (const type of ['undo', 'redo']) {
  ui[`voxel-${type}`].addEventListener('click', () => {
    if (!ui[`voxel-${type}`].disabled) return control({ type: `voxel-${type}`, baseRevision: state.creation.voxel.revision });
  });
}
ui['world-generate'].addEventListener('click', () => {
  if (!ui['world-generate'].disabled) return runStep('creation', '/api/world-generate', { conversationRevision: state.creation.dialogue.revision, ...(!state.creation.dialogue.ready ? { authorRequested: true } : {}), ...(resumableGeneration() ? { retryGenerationId: resumableGeneration().id } : {}) });
});
ui['world-accept'].addEventListener('click', () => {
  if (!ui['world-accept'].disabled) return control({ type: 'world-accept', draftId: currentDraft().id });
});
ui['play-pause'].addEventListener('click', () => {
  if (!ui['play-pause'].disabled) return control({ type: canPause() ? 'pause' : 'play' });
});
ui['actor-step'].addEventListener('click', () => {
  if (!ui['actor-step'].disabled) return runStep('resident', '/api/actor-step', {});
});
ui['actor-retry'].addEventListener('click', () => {
  if (!ui['actor-retry'].disabled) return control({ type: 'actor-retry' });
});
ui['model-cancel'].addEventListener('click', cancelModel);
ui['new-world'].addEventListener('click', () => control({ type: 'creation-open' }));
ui['world-resume'].addEventListener('click', () => control({ type: 'creation-resume' }));
ui['world-open'].addEventListener('click', () => control({ type: 'world-open', worldId: ui['world-archives'].value }));
ui['world-archives'].addEventListener('change', updateControls);
ui['connection-retry'].addEventListener('click', connect);
ui['activity-scroll'].addEventListener('scroll', () => {
  following = nearBottom(ui['activity-scroll']);
  if (following) unread = 0;
  updateUnread();
});
ui['activity-new'].addEventListener('click', () => {
  following = true; unread = 0;
  ui['activity-scroll'].focus({ preventScroll: true });
  ui['activity-scroll'].scrollTop = ui['activity-scroll'].scrollHeight;
  pendingScroll = ui['activity-scroll'].scrollTop;
  updateUnread();
});
ui['more-menu'].addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { ui['more-menu'].open = false; ui['more-menu'].querySelector('summary').focus(); }
});
document.addEventListener('click', (event) => {
  if (ui['more-menu'].open && !ui['more-menu'].contains(event.target)) ui['more-menu'].open = false;
});
window.addEventListener('pagehide', () => {
  closed = true; lifecycle++;
  source?.close(); source = null;
  syncController?.abort(); syncController = null;
  localTask?.controller.abort(); localTask = null;
  for (const controller of requests) controller.abort();
  requests.clear();
  window.clearInterval(progressTimer); progressTimer = null;
  releaseScene(slots.world); releaseScene(slots.draft); releaseScene(slots.voxel);
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  closed = false; controlBusy = false; cancelBusy = false; cancelRequested = false;
  progressTimer = window.setInterval(renderStatus, 1000);
  connect();
});
ui['creation-status'].append(ui['request-status']);
updateControls();
progressTimer = window.setInterval(renderStatus, 1000);
connect();
