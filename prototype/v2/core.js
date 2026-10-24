import { randomUUID } from 'node:crypto';
import { SEED, sceneOf } from './seed.js';

const copy = x => structuredClone(x);
const id = () => randomUUID();
const finite = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
export const formatTime = minutes => `第${Math.floor(minutes / 1440) + 1}天 ${String(Math.floor(minutes % 1440 / 60)).padStart(2, '0')}:${String(Math.floor(minutes % 60)).padStart(2, '0')}`;

export function validateWorld(world) {
  if (!world || typeof world !== 'object' || Array.isArray(world)) throw new Error('世界必须是 JSON 对象');
  if (!world.entities || typeof world.entities !== 'object' || Array.isArray(world.entities)) throw new Error('请保留 entities 对象；可以添加、删除或修改其中的实体');
  for (const [key, e] of Object.entries(world.entities)) {
    if (!e || typeof e !== 'object' || Array.isArray(e)) throw new Error(`实体 ${key} 必须是对象`);
    if (e.kind === 'character' && e.location && !world.entities[e.location]) throw new Error(`${e.name || key} 引用了不存在的地点 ${e.location}`);
    for (const k of ['x', 'z', 'width', 'depth', 'height']) {
      if (e[k] !== undefined && !finite(e[k], -10000, 10000)) throw new Error(`${key}.${k} 必须是有限数字`);
    }
  }
  if (world.memories !== undefined && !Array.isArray(world.memories)) throw new Error('memories 必须是数组');
  for (const m of world.memories || []) {
    if (!m || typeof m.text !== 'string' || !Array.isArray(m.knownBy) || m.knownBy.some(k => typeof k !== 'string')) throw new Error('每条记忆需要 text 字符串和 knownBy 字符串数组');
  }
  if (JSON.stringify(world).length > 150000) throw new Error('这轮原型的单个世界上限为 150KB');
  return world;
}

export function applyOps(world, ops) {
  const result = copy(world);
  if (!Array.isArray(ops) || ops.length > 100) throw new Error('变化列表格式不正确');
  for (const op of ops) {
    if (!['set', 'remove'].includes(op.op) || typeof op.path !== 'string' || !op.path.startsWith('/')) throw new Error('变化需要 set/remove 操作和 JSON Pointer 路径');
    const keys = op.path.slice(1).split('/').map(k => k.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new Error('不支持的字段路径');
    let obj = result;
    for (const k of keys.slice(0, -1)) {
      if (!Object.hasOwn(obj, k) || obj[k] === null || typeof obj[k] !== 'object') throw new Error(`路径不存在：${op.path}`);
      obj = obj[k];
    }
    const last = keys.at(-1);
    if (op.op === 'remove') {
      if (!Object.hasOwn(obj, last)) throw new Error(`删除路径不存在：${op.path}`);
      if (Array.isArray(obj)) {
        if (!/^\d+$/.test(last)) throw new Error('数组下标不正确');
        obj.splice(Number(last), 1);
      } else delete obj[last];
    } else {
      const value = JSON.parse(op.valueJson);
      if (Array.isArray(obj) && !/^\d+$/.test(last)) throw new Error('请用数字下标或整体替换数组');
      obj[last] = value;
    }
  }
  return validateWorld(result);
}

export function changedPaths(a, b, prefix = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) || Array.isArray(b)) return [prefix || '/'];
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].flatMap(k => changedPaths(a[k], b[k], `${prefix}/${k}`));
}

export class Experiment {
  constructor(data, save = () => {}, now = () => performance.now()) {
    this.data = data || { version: 2, lines: {}, revisions: {}, drafts: {}, calls: [] };
    this.save = save;
    this.now = now;
    this.lastTick = now();
    for (const line of Object.values(this.data.lines)) {
      line.inFlight = null;
      if (line.status === 'generating') line.status = 'ready';
    }
    if (!Object.keys(this.data.lines).length) this.newLine('α线', SEED);
  }

  persist() { this.save(this.data); }
  line(lineId) {
    const line = this.data.lines[lineId];
    if (!line) throw new Error('世界线不存在');
    return line;
  }
  world(lineId) { return this.data.revisions[this.line(lineId).head].world; }
  revision(parent, world, time, event) {
    const rev = { id: id(), parent, world: copy(validateWorld(world)), time, event: { id: id(), ...event } };
    this.data.revisions[rev.id] = rev;
    return rev;
  }
  newLine(name, world = SEED, base = null) {
    const worldTime = base?.worldTime ?? 480;
    const rev = this.revision(base?.head ?? null, world, worldTime, {
      kind: base ? 'edit' : 'origin', text: base ? '用户确认了「如果…」，新的世界线开始运行。' : '江水退去，戏台露出了轮廓。故事从这里开始。',
      changes: base ? changedPaths(this.data.revisions[base.head].world, world) : [],
      source: 'user',
    });
    const line = {
      id: id(), name: String(name || '新世界线').slice(0, 80), parentId: base?.lineId ?? null,
      forkRevision: base?.head ?? null, forkTime: base?.worldTime ?? null,
      head: rev.id, worldTime, speed: base?.speed ?? 24, paused: base?.paused ?? true,
      plan: null, inFlight: null, status: 'ready', error: null, retryAt: 0,
    };
    this.data.lines[line.id] = line;
    this.persist();
    return line;
  }
  history(lineId) {
    const list = [];
    let rev = this.data.revisions[this.line(lineId).head];
    while (rev) {
      list.push({ ...rev.event, time: rev.time, revisionId: rev.id });
      rev = this.data.revisions[rev.parent];
    }
    return list.reverse();
  }
  draft(lineId = null) {
    this.tick();
    const line = lineId ? this.line(lineId) : null;
    const draft = {
      id: id(), lineId, head: line?.head ?? null, worldTime: line?.worldTime ?? 480,
      speed: line?.speed ?? 24, paused: line?.paused ?? true, world: copy(line ? this.world(lineId) : SEED), createdAt: Date.now(),
    };
    this.data.drafts[draft.id] = draft;
    this.persist();
    return copy(draft);
  }
  confirm(draftId, world, name) {
    const draft = this.data.drafts[draftId];
    if (!draft) throw new Error('编辑草稿不存在，请重新打开「如果…」');
    validateWorld(world);
    const newLine = this.newLine(name, world, draft.head ? draft : null);
    delete this.data.drafts[draftId];
    this.persist();
    return newLine;
  }
  control(lineId, options) {
    this.tick();
    const line = this.line(lineId);
    if (options.speed !== undefined) {
      if (!finite(options.speed, 1, 86400)) throw new Error('倍速范围为 1–86400');
      line.speed = options.speed;
    }
    if (options.paused !== undefined) line.paused = !!options.paused;
    if (options.name) line.name = String(options.name).slice(0, 80);
    if (options.retry) { line.retryAt = 0; line.error = null; line.status = 'ready'; }
    this.persist();
    return line;
  }
  begin(lineId, kind = 'beat', meta = {}) {
    const line = this.line(lineId);
    if (kind === 'beat' && (line.inFlight || line.plan)) return null;
    const call = {
      id: id(), kind, lineId, baseRevision: line.head, startTime: line.worldTime,
      startedAt: Date.now(), status: 'pending', ...meta,
    };
    this.data.calls.push(call);
    if (kind === 'beat') { line.inFlight = call.id; line.status = 'generating'; line.error = null; }
    this.persist();
    return call;
  }
  accept(lineId, call, payload, span) {
    const line = this.line(lineId);
    if (line.inFlight !== call.id || line.head !== call.baseRevision || line.worldTime !== call.startTime) {
      call.status = 'discarded'; this.persist(); return false;
    }
    if (!Array.isArray(payload.events) || payload.events.length > 20) throw new Error('推演事件格式不正确');
    const events = payload.events.map(event => {
      if (!finite(event.offsetMinutes, 0, span) || !event.text || typeof event.text !== 'string') throw new Error('事件必须在本次推演时段内且具有叙述');
      if (event.memories !== undefined && !Array.isArray(event.memories)) throw new Error('事件记忆必须是数组');
      for (const m of event.memories || []) {
        if (!m || typeof m.text !== 'string' || !Array.isArray(m.knownBy)) throw new Error('长期记忆需要内容和知情者');
      }
      return { ...copy(event), id: id(), at: call.startTime + event.offsetMinutes };
    }).sort((a, b) => a.at - b.at);
    let projected = copy(this.world(lineId));
    for (const event of events) projected = this.applyEvent(projected, event);
    line.plan = { from: call.startTime, to: call.startTime + span, events, callId: call.id };
    line.inFlight = null;
    line.status = 'ready'; line.error = null;
    call.status = 'accepted'; call.finishedAt = Date.now();
    this.persist();
    return true;
  }
  applyEvent(world, event) {
    const next = applyOps(world, event.ops || []);
    next.memories ||= [];
    for (const m of event.memories || []) {
      if (!next.memories.some(x => x.text === m.text)) next.memories.push({ id: id(), text: m.text, knownBy: m.knownBy, source: event.id });
    }
    return validateWorld(next);
  }
  fail(lineId, call, error) {
    call.status = 'failed'; call.error = String(error.message || error).slice(0, 300); call.finishedAt = Date.now();
    const line = this.line(lineId);
    if (line.inFlight === call.id) {
      line.inFlight = null; line.status = 'error'; line.error = call.error;
      line.retryAt = Date.now() + (error.retryAfterMs || 30000);
    }
    this.persist();
  }
  tick() {
    const now = this.now();
    const delta = Math.max(0, now - this.lastTick);
    this.lastTick = now;
    let changed = false;
    for (const line of Object.values(this.data.lines)) {
      if (line.paused || !line.plan) continue;
      const until = Math.min(line.plan.to, line.worldTime + delta / 60000 * line.speed);
      const due = line.plan.events.filter(event => event.at <= until);
      for (const event of due) {
        const world = this.applyEvent(this.world(line.id), event);
        const rev = this.revision(line.head, world, event.at, {
          ...event, kind: 'story', source: this.data.calls.find(c => c.id === line.plan.callId)?.mode || 'llm',
          callId: line.plan.callId,
        });
        line.head = rev.id;
      }
      line.plan.events = line.plan.events.filter(event => event.at > until);
      line.worldTime = until;
      if (until >= line.plan.to) line.plan = null;
      changed = true;
    }
    if (changed) this.persist();
  }
  snapshot() {
    return Object.values(this.data.lines).map(line => ({
      id: line.id, name: line.name, parentId: line.parentId, forkTime: line.forkTime,
      head: line.head, worldTime: line.worldTime, speed: line.speed, paused: line.paused,
      status: line.paused ? 'paused' : line.inFlight ? 'generating' : line.plan ? 'running' : line.status === 'error' ? 'error' : 'waiting',
      error: line.error, horizon: line.plan?.to ?? line.worldTime,
      pendingEvents: line.plan?.events.length ?? 0,
      world: copy(this.world(line.id)), log: this.history(line.id),
      scene: sceneOf(this.world(line.id), line.worldTime, line.head),
    }));
  }
}
