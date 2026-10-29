// UI contract checks in memory: no server, model, browser, private config or save.
// The backend's independent tests own rule execution and dialogue persistence.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { setImmediate as flush } from 'node:timers/promises';

const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../ui/style.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8');
const sceneSource = readFileSync(new URL('../ui/scene.js', import.meta.url), 'utf8');
const clone = (value) => structuredClone(value);
const settle = async () => { for (let i = 0; i < 8; i++) await flush(); };
const checks = [];
async function check(name, run) {
  try { await run(); checks.push({ name, pass: true }); }
  catch (error) { checks.push({ name, pass: false, error: error.stack }); }
}

class Element {
  constructor(tag, document) {
    this.tagName = tag.toUpperCase(); this.ownerDocument = document;
    this.id = ''; this.children = []; this.parentNode = null; this.attributes = {};
    this.dataset = {}; this.style = {}; this.listeners = new Map();
    this.hidden = false; this.disabled = false; this.open = false; this.value = '';
    this._text = ''; this._scrollTop = 0; this.className = ''; this.clientHeight = 240;
    this.classList = { toggle: (name, on) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      if (on) names.add(name); else names.delete(name); this.className = [...names].join(' ');
    } };
  }
  set textContent(value) { for (const child of this.children) child.parentNode = null; this.children = []; this._text = String(value); }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('UI must render server content as text, never HTML'); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  append(...nodes) { for (const node of nodes) this.insertBefore(node, null); }
  insertBefore(node, before) {
    if (node === before) return;
    node.remove(); node.parentNode = this;
    const index = before ? this.children.indexOf(before) : this.children.length;
    assert(index >= 0, 'insertBefore reference must be a child');
    this.children.splice(index, 0, node);
  }
  replaceChildren(...nodes) { this.textContent = ''; this.append(...nodes); }
  remove() {
    if (this.parentNode) {
      const siblings = this.parentNode.children, index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    }
    this.parentNode = null;
  }
  contains(node) { return this === node || this.children.some((child) => child.contains(node)); }
  querySelector(tag) { return this.children.find((child) => child.tagName === tag.toUpperCase()) || this.children.map((child) => child.querySelector(tag)).find(Boolean); }
  addEventListener(name, handler) { if (!this.listeners.has(name)) this.listeners.set(name, []); this.listeners.get(name).push(handler); }
  dispatch(name, fields = {}) {
    const event = { target: this, keyCode: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...fields };
    const results = (this.listeners.get(name) || []).map((handler) => handler(event));
    return { event, done: Promise.all(results) };
  }
  requestSubmit() { this.dispatch('submit'); }
  focus() { if (!this.disabled) this.ownerDocument.activeElement = this; }
  get scrollHeight() {
    if (this.id === 'activity-scroll') return Math.max(this.clientHeight, this.ownerDocument.getElementById('activity-log').children.length * 60);
    if (this.id === 'dialogue-scroll') return Math.max(this.clientHeight, this.ownerDocument.getElementById('dialogue-log').children.length * 96);
    return this.clientHeight;
  }
  get scrollTop() { return this._scrollTop; }
  set scrollTop(value) { this._scrollTop = Math.max(0, Math.min(Number(value), this.scrollHeight - this.clientHeight)); }
  getBoundingClientRect() {
    if (this.parentNode?.id === 'activity-log') {
      const top = this.parentNode.children.indexOf(this) * 60 - this.ownerDocument.getElementById('activity-scroll').scrollTop;
      return { top, bottom: top + 60, height: 60 };
    }
    return { top: 0, bottom: this.clientHeight, height: this.clientHeight };
  }
}
function memoryDocument() {
  const elements = new Map(), listeners = new Map();
  const document = {
    title: '', activeElement: null, hidden: false,
    getElementById(id) { assert(elements.has(id), `missing UI binding ${id}`); return elements.get(id); },
    createElement(tag) { return new Element(tag, document); },
    addEventListener(name, callback) { listeners.set(name, callback); },
    dispatch(name, event) { return listeners.get(name)?.(event); },
  };
  const root = new Element('root', document), stack = [root];
  for (const token of html.matchAll(/<([^>]+)>|([^<]+)/g)) {
    if (token[2]) { stack.at(-1)._text += token[2]; continue; }
    const tag = token[1];
    if (tag.startsWith('!')) continue;
    if (tag.startsWith('/')) { stack.pop(); continue; }
    const name = tag.match(/^\S+/)[0];
    const element = new Element(name, document);
    for (const attribute of tag.matchAll(/\b([a-z-]+)="([^"]*)"/g)) element.setAttribute(attribute[1], attribute[2]);
    element.id = element.attributes.id || '';
    element.className = element.attributes.class || '';
    for (const flag of ['hidden', 'disabled', 'open']) element[flag] = new RegExp(`(?:^|\\s)${flag}(?:\\s|$)`).test(tag);
    if (element.id) { assert(!elements.has(element.id), `duplicate id ${element.id}`); elements.set(element.id, element); }
    stack.at(-1).append(element);
    if (name === 'body') document.body = element;
    if (!['meta', 'link', 'input', 'br', 'hr'].includes(name)) stack.push(element);
  }
  return { document, elements };
}
const emptyState = () => ({
  instanceId: null, world: null, scene: null, worldMinute: 0, revision: 0, paused: true, activity: [],
  model: { pending: false, lastResult: null }, autonomy: { enabled: false, nextActorId: 'lin', waitingReason: null }, waiting: null,
  creation: { mode: 'create', hasWorld: false, draft: null, lastResult: null, worlds: [], dialogue: { messages: [], summary: '', ready: false, revision: 0 } },
});
const definition = () => ({
  world: {
    profile: 'generated-world', title: '海边的灯', description: '只从一间灯室开始。', environment: { weather: '海风' },
    places: [{ id: 'lamp-room', name: '灯室', description: '面向海面的小房间。' }],
    actors: [{ id: 'lin', name: '林', role: '守灯人', location: 'lamp-room', goal: '让来船看见光。' }],
    resources: [
      { id: 'charge', name: '电量', unit: '格', quantity: 6, capacity: 12, location: 'lamp-room' },
      { id: 'lamp', name: '灯开关', unit: '', quantity: 0, capacity: 1, location: 'lamp-room' },
    ],
    processes: [
      { id: 'charge-up', resourceId: 'charge', deltaPerMinute: 1, description: '海风充电。' },
      { id: 'shine', resourceId: 'charge', deltaPerMinute: -3, when: [{ resourceId: 'lamp', op: 'gte', value: 1 }, { resourceId: 'charge', op: 'gte', value: 3 }], description: '灯亮且有电才耗电。' },
    ],
    actions: [{ id: 'light', name: '打开灯', location: 'lamp-room', requires: [{ resourceId: 'lamp', op: 'lte', value: 0 }, { resourceId: 'charge', op: 'gte', value: 3 }], costs: [], gains: [{ resourceId: 'lamp', amount: 1 }] }],
  },
  scene: { id: 'lamp-preview', objects: [] }, initialMemories: [],
});
const readyState = () => {
  const state = emptyState();
  state.creation.dialogue = { revision: 2, ready: true, summary: '一位守灯人，一间灯室，灯耗电且能充电。', messages: [
    { id: 'u1', role: 'user', text: '我想从一座灯塔开始。' }, { id: 'a1', role: 'assistant', text: '先从灯室开始好吗？谁在这里？' },
    { id: 'u2', role: 'user', text: '好，只有守灯人林，灯会耗电。' }, { id: 'a2', role: 'assistant', text: '这一小片起点清楚了。要先看看草稿吗？' },
  ] };
  return state;
};
const draftState = (id = 'draft-1') => {
  const state = readyState(); state.creation.draft = { id, definition: definition(), baseConversationRevision: 2 }; return state;
};
const worldState = (id = 'world-1') => {
  const state = readyState(), def = definition();
  Object.assign(state, { instanceId: id, world: def.world, scene: { document: def.scene, revision: 0 }, activity: [{ id: `${id}:origin`, kind: 'origin', revision: 0, minute: 0, text: '海边的灯从这里开始。' }] });
  state.creation.mode = 'world'; state.creation.hasWorld = true; return state;
};
const result = (state, extra = {}) => ({ ok: true, state: clone(state), ...extra });
function sse(value, { progress = [], chunkSize = 23, eol = '\r\n', multiline = false } = {}) {
  const frames = [...progress.map((data) => ['progress', data]), ['result', value]];
  const bytes = new TextEncoder().encode(`: heartbeat${eol}${eol}` + frames.map(([type, data]) => `event: ${type}${eol}${JSON.stringify(data, null, multiline ? 2 : undefined).split('\n').map((line) => `data: ${line}`).join(eol)}${eol}${eol}`).join(''));
  return new Response(new ReadableStream({ start(controller) {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}
function heldStream() {
  let controller, stopped = false;
  const response = new Response(new ReadableStream({ start(value) { controller = value; }, cancel() { stopped = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  const write = (type, value) => { if (!stopped) controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)); };
  return {
    response,
    progress(value) { write('progress', value); },
    finish(value) { write('result', value); if (!stopped) controller.close(); stopped = true; },
    break() { if (!stopped) controller.close(); stopped = true; },
    attach(signal) { signal.addEventListener('abort', () => { if (!stopped) controller.error(new DOMException('aborted', 'AbortError')); stopped = true; }, { once: true }); return response; },
  };
}

async function page(initial = emptyState(), options = {}) {
  const { document, elements } = memoryDocument();
  const windowEvents = new Map(), timers = new Map(), routes = new Map(), requests = [], sources = [], scenes = [], sceneStarts = [];
  let now = 0, timer = 0, server = clone(initial), holdScenes = false, failScenes = 0;
  class MemorySource {
    constructor(path) { this.path = path; this.readyState = 0; this.handlers = new Map(); this.closed = false; sources.push(this); }
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    close() { this.closed = true; this.readyState = 2; }
    emit(name, data) { if (name === 'state') this.readyState = 1; if (name === 'error') this.readyState = 0; this.handlers.get(name)?.({ data: JSON.stringify(data) }); }
  }
  const window = {
    addEventListener(name, callback) { windowEvents.set(name, callback); },
    setInterval(callback) { const id = ++timer; timers.set(id, callback); return id; },
    clearInterval(id) { timers.delete(id); },
  };
  const fetchUI = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ path, body, signal: init.signal });
    const route = routes.get(path)?.shift();
    if (route) return route(body, init);
    if (path === '/api/state') return options.initialGet ? options.initialGet() : Response.json(server);
    throw new Error(`Unexpected UI request ${path}`);
  };
  const loadScene = async () => ({ createScene: async (host, state) => {
    if (failScenes) { failScenes--; throw new Error('Synthetic scene failure'); }
    const instance = { host, mode: '3d', disposed: false, updates: [clone(state)], update(next) { assert(!this.disposed); this.updates.push(clone(next)); }, dispose() { this.disposed = true; host.replaceChildren(); } };
    scenes.push(instance);
    if (holdScenes) await new Promise((resolve) => sceneStarts.push(resolve));
    return instance;
  } });
  // Substitute exactly the renderer import. The rest of app.js runs unchanged.
  assert.equal(app.split("import('./scene.js')").length, 2);
  const context = vm.createContext({ document, window, EventSource: MemorySource, performance: { now: () => now }, fetch: fetchUI, AbortController, TextDecoder, console, __loadSceneModule: loadScene });
  new vm.Script(app.replace("import('./scene.js')", '__loadSceneModule()')).runInContext(context);
  const api = {
    document, elements, requests, sources, scenes, timers, sceneStarts,
    $(id) { return document.getElementById(id); },
    async push(state) { server = clone(state); sources.at(-1).emit('state', server); await settle(); },
    setServer(state) { server = clone(state); },
    route(path, handler) { if (!routes.has(path)) routes.set(path, []); routes.get(path).push(handler); },
    async click(id) { assert.equal(api.$(id).disabled, false, `${id} must be enabled`); await api.$(id).dispatch('click').done; await settle(); },
    async input(value) { api.$('creation-input').value = value; await api.$('creation-input').dispatch('input').done; },
    async submit() { await api.$('creation-form').dispatch('submit').done; await settle(); },
    async tick(ms = 1000) { now += ms; for (const callback of timers.values()) callback(); await settle(); },
    holdScenes(value) { holdScenes = value; }, failScene() { failScenes++; },
    hide() { windowEvents.get('pagehide')(); },
    async restore() { windowEvents.get('pageshow')({ persisted: true }); await settle(); },
    close() { windowEvents.get('pagehide')(); },
  };
  await settle();
  if (options.autoPush !== false) await api.push(initial);
  return api;
}
async function withPage(initial, run, options) {
  const browser = await page(initial, options);
  try { await run(browser); } finally { browser.close(); await settle(); }
}

await check('single entry preserves palette and local dependencies, removes obsolete dashboard UI', () => {
  assert.match(html, /lang="zh-CN"/); assert.match(html, /viewport/);
  assert.doesNotMatch(html, /actor-tabs|author-overview|world-example|data-speed|step-five|<pre\b/);
  assert.doesNotMatch(html + css, /fonts\.google|https?:\/\//);
  assert.match(css, /--paper: #e8e0d0/); assert.match(css, /--night: #0e1317/); assert.match(css, /--red: #a64f4a/);
  assert.match(css, /focus-visible/); assert.match(css, /prefers-reduced-motion/); assert.match(css, /max-width: 480px/);
  assert.match(sceneSource, /export async function createScene\(host, state\)/);
  assert.doesNotMatch(app, /innerHTML|insertAdjacentHTML|setTimeout|localStorage/);
});
await check('first visit waits for dialogue; one initial GET and long SSE, with no polling', () => withPage(emptyState(), async (p) => {
  assert.equal(p.$('world-create').hidden, false); assert.equal(p.$('world-experience').hidden, true);
  assert.equal(p.$('creation-send').disabled, true); assert.equal(p.$('generate-actions').hidden, true);
  assert.equal(p.$('world-accept').disabled, true); assert.equal(p.$('more-menu').hidden, true);
  assert.equal(p.sources[0].path, '/api/events');
  await p.tick(90000); await p.tick(90000);
  assert.deepEqual(p.requests.map((entry) => entry.path), ['/api/state']);
}));
await check('a selected story is sent as material, shown by name, and can be removed', () => withPage(emptyState(), async (p) => {
  const story = '红发会的故事原文。';
  const next = emptyState(); next.creation.source = { name: '红发会.txt', characters: story.length };
  p.route('/api/control', body => {
    assert.deepEqual(body, { type: 'source-set', source: { name: '红发会.txt', text: story } });
    return Response.json(result(next));
  });
  const bytes = new TextEncoder().encode(story);
  p.$('source-input').files = [{ name: '红发会.txt', size: bytes.length, arrayBuffer: async () => bytes.buffer }];
  await p.$('source-input').dispatch('change').done; await settle();
  assert.match(p.$('source-status').textContent, /红发会\.txt/);
  assert.equal(p.$('source-remove').hidden, false);
  next.creation.source = null;
  p.route('/api/control', body => { assert.deepEqual(body, { type: 'source-set', source: null }); return Response.json(result(next)); });
  await p.click('source-remove');
  assert.match(p.$('source-status').textContent, /还没有添加素材/);
}));
await check('IME and empty submissions never send; submit locks while streaming and displays no model JSON', () => withPage(emptyState(), async (p) => {
  await p.submit(); assert.equal(p.requests.length, 1);
  await p.input('海边有一座灯塔');
  p.$('creation-input').dispatch('compositionstart');
  p.$('creation-input').dispatch('keydown', { key: 'Enter', isComposing: true });
  await p.submit(); assert.equal(p.requests.length, 1);
  p.$('creation-input').dispatch('compositionend');
  p.$('creation-input').dispatch('keydown', { key: 'Enter' });
  p.$('creation-input').dispatch('keydown', { key: 'Enter', keyCode: 229 });
  await settle(); assert.equal(p.requests.length, 1);
  await p.tick(100);
  const stream = heldStream(); p.route('/api/creation-chat', (_body, init) => stream.attach(init.signal));
  const submitted = p.submit(); await settle();
  assert.equal(p.$('creation-input').disabled, true); assert.equal(p.$('creation-send').disabled, true);
  assert.equal(p.$('model-cancel').disabled, false);
  await p.submit(); assert.equal(p.requests.filter((entry) => entry.path === '/api/creation-chat').length, 1);
  stream.progress({ phase: 'receiving', elapsedMs: 2000, preview: '{"reasoning":"SHOULD_NEVER_DISPLAY"}', outputCharacters: 99 }); await settle();
  assert.match(p.$('model-phase').textContent, /回复/); assert.match(p.$('model-elapsed').textContent, /2 秒/);
  assert.doesNotMatch(p.document.body.textContent, /SHOULD_NEVER_DISPLAY|outputCharacters/);
  const next = emptyState(); next.creation.dialogue = { revision: 1, ready: false, summary: '先从灯室开始。', messages: [
    { id: 'u1', role: 'user', text: '海边有一座灯塔' }, { id: 'a1', role: 'assistant', text: '先从灯室开始好吗？谁在这里？' },
  ] };
  stream.finish(result(next, { message: '先从灯室开始好吗？谁在这里？' })); await submitted;
  assert.equal(p.$('dialogue-log').children.length, 2);
  assert.equal(p.$('creation-input').value, ''); assert.equal(p.$('generate-actions').hidden, false);
  assert.equal(p.$('model-progress').hidden, true); assert.equal(p.$('operation-error').hidden, true);
  assert.equal(p.document.body.textContent.split('先从灯室开始好吗？谁在这里？').length, 2);
  assert.equal(p.document.activeElement, p.$('creation-input'));
}));
await check('Shift+Enter stays a newline; Enter sends the current message via the form', () => withPage(emptyState(), async (p) => {
  await p.input('先从一间房开始。');
  const event = p.$('creation-input').dispatch('keydown', { key: 'Enter', shiftKey: true }).event;
  assert.equal(event.defaultPrevented, false); assert.equal(p.requests.length, 1);
  p.route('/api/creation-chat', (body) => { assert.deepEqual(body, { message: '先从一间房开始。', mode: 'build', conversationRevision: 0 }); return sse(result(emptyState())); });
  assert.equal(p.$('creation-input').dispatch('keydown', { key: 'Enter' }).event.defaultPrevented, true);
  await settle(); assert.equal(p.requests.length, 2);
}));
await check('ready dialogue generates with revision only; creation clears prior preview before any response', () => withPage(draftState(), async (p) => {
  const old = p.scenes[0], stream = heldStream();
  p.route('/api/world-generate', (body, init) => { assert.deepEqual(body, { conversationRevision: 2 }); return stream.attach(init.signal); });
  const generation = p.click('world-generate'); await settle();
  assert.equal(old.disposed, true); assert.equal(p.$('world-draft').hidden, true); assert.equal(p.$('world-accept').disabled, true);
  const next = draftState('draft-2'); next.creation.dialogue.messages.push({ id: 'draft-message', role: 'assistant', text: '草稿好了，请确认。' });
  stream.finish(result(next, { message: '草稿好了，请确认。' })); await generation;
  assert.equal(p.$('world-draft').hidden, false); assert.equal(p.$('world-experience').hidden, true);
  assert.equal(p.$('world-accept').disabled, false); assert.equal(p.scenes.length, 2);
  assert.equal(p.document.body.textContent.split('草稿好了，请确认。').length, 2);
}));
await check('draft rules show conditional processes and action prerequisites, resource bounds and names', () => withPage(draftState(), async (p) => {
  const rules = p.$('world-draft-summary').textContent;
  assert.match(rules, /持续运行，每分钟电量增加 1格/);
  assert.match(rules, /满足 灯开关 ≥ 1 且 电量 ≥ 3格 时，每分钟电量减少 3格/);
  assert.match(rules, /打开灯（灯室）：需要 灯开关 ≤ 0 且 电量 ≥ 3格/);
  assert.match(rules, /每分钟开始时/); assert.match(rules, /容量限制/);
  assert.match(rules, /守灯人/); assert.match(rules, /电量 6 \/ 12格/);
  const exact = draftState('precise-threshold');
  exact.creation.draft.definition.world.processes[1].when[1].value = 0.0001;
  await p.push(exact);
  assert.match(p.$('world-draft-summary').textContent, /电量 ≥ 0\.0001格/);
}));
await check('feedback is persisted, marks older draft stale, blocks acceptance and enables regeneration', () => withPage(draftState(), async (p) => {
  await p.input('灯亮着的时候才耗电。');
  const next = draftState(); next.creation.dialogue.revision = 3;
  next.creation.dialogue.messages.push({ id: 'feedback', role: 'user', text: '灯亮着的时候才耗电。' }, { id: 'reply3', role: 'assistant', text: '已经记下，请重新生成草稿。' });
  p.route('/api/creation-chat', () => sse(result(next)));
  await p.submit(); assert.equal(p.$('draft-stale').hidden, false); assert.equal(p.$('world-accept').disabled, true);
  await p.$('world-accept').dispatch('click').done;
  assert.equal(p.requests.some((entry) => entry.body?.type === 'world-accept'), false);
  p.route('/api/world-generate', (body) => {
    assert.deepEqual(body, { conversationRevision: 3 });
    next.creation.draft = { ...next.creation.draft, id: 'updated', baseConversationRevision: 3 };
    return sse(result(next));
  });
  await p.click('world-generate'); assert.equal(p.$('world-accept').disabled, false);
}));
await check('legacy drafts remain confirmable; only explicit accept opens the paused world', () => {
  const initial = draftState(); delete initial.creation.draft.baseConversationRevision;
  return withPage(initial, async (p) => {
    assert.equal(p.$('world-accept').disabled, false); assert.equal(p.$('world-experience').hidden, true);
    const oldScene = p.scenes[0];
    p.route('/api/control', (body) => { assert.deepEqual(body, { type: 'world-accept', draftId: 'draft-1' }); return Response.json(result(worldState())); });
    await p.click('world-accept');
    assert.equal(p.$('world-create').hidden, true); assert.equal(p.$('world-experience').hidden, false);
    assert.equal(p.$('world-time').textContent, '第 0 分钟'); assert.equal(p.$('play-pause').textContent, '播放');
    assert.equal(oldScene.disposed, true); assert.equal(p.document.activeElement, p.$('main'));
  });
});
await check('play is a single control; paused stepping sends no actorId, while pause stays usable during a resident request', () => withPage(worldState(), async (p) => {
  const next = worldState();
  p.route('/api/control', (body) => { assert.deepEqual(body, { type: 'play' }); next.paused = false; next.autonomy.enabled = true; return Response.json(result(next)); });
  await p.click('play-pause'); assert.equal(p.$('play-pause').textContent, '暂停'); assert.equal(p.$('actor-step').disabled, true);
  next.model = { pending: true, kind: 'resident', actorId: 'lin', progress: { phase: 'generating', elapsedMs: 1000, preview: 'not-an-event' } };
  await p.push(next); assert.equal(p.$('play-pause').disabled, false);
  p.route('/api/control', (body) => { assert.deepEqual(body, { type: 'pause' }); next.paused = true; next.model = { pending: false, lastResult: { ok: false, reason: 'cancelled' } }; return Response.json(result(next)); });
  await p.click('play-pause'); assert.equal(p.$('actor-retry').hidden, true); assert.equal(p.$('operation-error').hidden, true);
  p.route('/api/actor-step', (body) => {
    assert.deepEqual(body, {}); next.worldMinute++; next.revision++; next.activity.push({ id: 'step1', revision: 1, minute: 1, kind: 'action', text: '林走近灯。' });
    return sse(result(next));
  });
  await p.click('actor-step'); assert.equal(p.$('world-time').textContent, '第 1 分钟'); assert.equal(p.$('clock-state').textContent, '已暂停');
}));
await check('only committed activity enters the log, progress stays a single transient status, push updates scene once per world change', () => withPage(worldState(), async (p) => {
  const next = worldState(), scene = p.scenes[0], count = scene.updates.length, origin = p.$('activity-log').children[0];
  next.model = { pending: true, kind: 'resident', actorId: 'lin', progress: { phase: 'verifying', elapsedMs: 1900, preview: '{"action":"FAKE_FACT"}' } };
  await p.push(next); await p.push(next);
  assert.equal(scene.updates.length, count); assert.equal(p.$('activity-log').children.length, 1);
  assert.equal(p.$('activity-log').children[0], origin); assert.match(p.$('model-phase').textContent, /核验林/);
  assert.doesNotMatch(p.document.body.textContent, /FAKE_FACT/);
  next.revision = 1; next.worldMinute = 1; next.model.pending = false;
  next.activity.push({ id: 'speech1', revision: 1, minute: 1, kind: 'speech', text: '林：“灯已经亮了。”', detail: '没有其他人在场' });
  await p.push(next); await p.push(next);
  assert.equal(p.$('activity-log').children.length, 2); assert.equal(scene.updates.length, count + 1);
  assert.equal(p.$('model-progress').hidden, true); assert.equal(p.requests.length, 1);
}));
await check('activity follows the bottom, respects reading position and counts only new facts after reconnect', () => withPage(worldState(), async (p) => {
  const next = worldState();
  next.activity = Array.from({ length: 12 }, (_, index) => ({ id: `a${index}`, revision: index, minute: index, kind: 'action', text: `已发生 ${index}` })); next.revision = 12;
  await p.push(next); const scroll = p.$('activity-scroll');
  assert.equal(scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight);
  scroll.scrollTop = 120; scroll.dispatch('scroll');
  next.activity.push({ id: 'new1', revision: 13, minute: 13, kind: 'speech', text: '一句新话' }); next.revision = 13;
  await p.push(next); assert.equal(scroll.scrollTop, 120); assert.match(p.$('activity-new').textContent, /1 条新动态/);
  p.sources[0].emit('error'); await p.push(next); await p.push(next);
  assert.equal(scroll.scrollTop, 120); assert.match(p.$('activity-new').textContent, /1 条新动态/);
  await p.click('activity-new'); assert.equal(scroll.scrollTop, scroll.scrollHeight - scroll.clientHeight);
  assert.equal(p.$('activity-new').hidden, true); assert.equal(p.document.activeElement, scroll);
}));
await check('activity remains bounded to 300 DOM entries and preserves a visible anchor when old facts are trimmed', () => withPage(worldState(), async (p) => {
  const next = worldState();
  next.activity = Array.from({ length: 300 }, (_, index) => ({ id: `entry-${index}`, revision: index, minute: index, kind: 'environment', text: `环境 ${index}` })); next.revision = 300;
  await p.push(next); assert.equal(p.$('activity-log').children.length, 300);
  const scroll = p.$('activity-scroll'); scroll.scrollTop = 600; scroll.dispatch('scroll');
  const anchor = p.$('activity-log').children[10], position = anchor.getBoundingClientRect().top;
  next.activity = [{ id: 'entry-300', revision: 300, minute: 300, kind: 'action', text: '新的行动' }]; next.revision = 301;
  await p.push(next); assert.equal(p.$('activity-log').children.length, 300);
  assert.equal(anchor.getBoundingClientRect().top, position);
  assert.equal(p.$('activity-log').children[0].dataset.activityId, 'entry-1');
  await p.push(next); assert.match(p.$('activity-new').textContent, /1 条新动态/);
}));
await check('changing worlds resets activity even if event IDs overlap; returning to current world preserves it', () => withPage(worldState(), async (p) => {
  const next = worldState(); next.creation.mode = 'create';
  const old = p.scenes[0]; await p.push(next); assert.equal(old.disposed, true);
  next.creation.mode = 'world'; await p.push(next); assert.equal(p.$('activity-log').children.length, 1);
  const other = worldState('world-2'); other.activity[0].id = next.activity[0].id; other.activity[0].text = '新起点。';
  await p.push(other); assert.equal(p.$('activity-log').children.length, 1); assert.match(p.$('activity-log').textContent, /新起点/);
  assert.doesNotMatch(p.$('activity-log').textContent, /海边的灯从这里开始/);
}));
await check('failed actions show recovery; retry unlocks play and next without auto-submitting another model request', () => {
  const initial = worldState(); initial.autonomy.waitingReason = 'invalid-decision';
  initial.model.lastResult = { ok: false, message: '电量不足，开灯未执行。' };
  initial.activity.push({ id: 'failure1', revision: 0.5, minute: 0, kind: 'failure', text: '林的尝试未能完成。' });
  return withPage(initial, async (p) => {
    assert.equal(p.$('actor-retry').hidden, false); assert.equal(p.$('actor-step').disabled, true); assert.match(p.$('operation-error').textContent, /电量不足/);
    p.route('/api/control', (body) => { assert.deepEqual(body, { type: 'actor-retry' }); initial.autonomy.waitingReason = null; return Response.json(result(initial)); });
    await p.click('actor-retry'); assert.equal(p.$('actor-retry').hidden, true); assert.equal(p.$('actor-step').disabled, false);
    assert.equal(p.$('play-pause').disabled, false); assert.equal(p.$('operation-error').hidden, true); assert.equal(p.requests.length, 2);
  });
});
await check('cancelling generation calls model-cancel and leaves no old preview or invented world', () => withPage(draftState(), async (p) => {
  const stream = heldStream(); p.route('/api/world-generate', (_body, init) => stream.attach(init.signal));
  const task = p.click('world-generate'); await settle();
  const next = readyState(); next.creation.lastResult = { ok: false, reason: 'cancelled', message: '草稿生成已取消，可以重新生成。' };
  p.route('/api/model-cancel', () => { stream.finish(result(next, next.creation.lastResult)); return Response.json(result(next)); });
  await p.click('model-cancel'); await task;
  assert.equal(p.$('world-draft').hidden, true); assert.equal(p.$('world-experience').hidden, true);
  assert.equal(p.$('world-generate').disabled, false); assert.match(p.$('operation-error').textContent, /取消/);
  assert.equal(p.requests.filter((entry) => entry.path === '/api/world-generate').length, 1);
}));
await check('interrupted reply preserves the persisted user message, exposes recovery and never auto-retries', () => withPage(emptyState(), async (p) => {
  await p.input('请从灯室开始。');
  const stream = heldStream(); p.route('/api/creation-chat', (_body, init) => stream.attach(init.signal));
  const task = p.submit(); await settle();
  const next = emptyState(); next.creation.dialogue.revision = 1;
  next.creation.dialogue.messages.push({ id: 'saved-input', role: 'user', text: '请从灯室开始。' });
  next.model = { pending: true, kind: 'discussion', progress: { phase: 'generating', elapsedMs: 10 } };
  await p.push(next); assert.equal(p.$('creation-input').value, '');
  next.model.pending = false; next.creation.lastResult = { ok: false, message: '回复中断，可以继续发送消息。' }; p.setServer(next);
  stream.break(); await task; await settle();
  assert.equal(p.$('dialogue-log').children.length, 1); assert.equal(p.$('creation-input').disabled, false);
  assert.match(p.$('operation-error').textContent, /中断|完整回复/);
  assert.equal(p.requests.filter((entry) => entry.path === '/api/creation-chat').length, 1);
}));
await check('SSE handles split UTF-8, multiline data, CRLF and CR delimiters', async () => {
  for (const eol of ['\r\n', '\r', '\n']) await withPage(readyState(), async (p) => {
    p.route('/api/world-generate', () => sse(result(draftState()), { eol, chunkSize: 1, multiline: true, progress: [{ phase: 'verifying', elapsedMs: 3, preview: '不应显示的模型片段' }] }));
    await p.click('world-generate'); assert.equal(p.$('world-draft-title').textContent, '海边的灯');
    assert.equal(p.$('operation-error').hidden, true); assert.doesNotMatch(p.document.body.textContent, /不应显示的模型片段/);
  });
});
await check('malformed response reports a recoverable error and does not restore a suppressed draft', () => withPage(draftState(), async (p) => {
  p.route('/api/world-generate', () => new Response('event: result\ndata: {broken}\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  await p.click('world-generate'); await settle();
  assert.match(p.$('operation-error').textContent, /格式不完整/);
  assert.equal(p.$('world-draft').hidden, true); assert.equal(p.$('world-accept').disabled, true);
}));
await check('HTTP errors include field diagnostics and preserve user input for recovery', () => withPage(emptyState(), async (p) => {
  await p.input('一间灯室');
  p.route('/api/creation-chat', () => Response.json({ ok: false, message: '消息未保存。', diagnostics: [{ path: 'message', message: '请补充起点。' }] }, { status: 422 }));
  await p.submit(); assert.equal(p.$('creation-input').value, '一间灯室');
  assert.match(p.$('operation-error').textContent, /消息未保存/); assert.match(p.$('operation-error').textContent, /message/);
  assert.equal(p.$('creation-send').disabled, false);
}));
await check('delayed HTTP control reply never rolls back newer SSE state', () => withPage(worldState(), async (p) => {
  let finish;
  p.route('/api/control', () => new Promise((resolve) => { finish = resolve; }));
  const playing = p.click('play-pause'); await settle();
  const latest = worldState(); latest.paused = false; latest.revision = 3; latest.worldMinute = 3;
  latest.activity.push({ id: 'late-speech', revision: 3, minute: 3, kind: 'speech', text: '已经过去三分钟。' });
  await p.push(latest);
  const old = worldState(); old.paused = false;
  finish(Response.json(result(old))); await playing;
  assert.equal(p.$('world-time').textContent, '第 3 分钟'); assert.match(p.$('activity-log').textContent, /已经过去三分钟/);
}));
await check('initial GET cannot overwrite a newer push, disconnect disables input and reconnect does not duplicate messages', async () => {
  let finish;
  await withPage(readyState(), async (p) => {
    const log = p.$('dialogue-log'), message = log.children[0];
    finish(Response.json(emptyState())); await settle(); assert.equal(log.children.length, 4);
    p.sources[0].emit('error'); assert.equal(p.$('creation-input').disabled, true); assert.equal(p.$('connection-retry').hidden, false);
    await p.push(readyState()); assert.equal(p.$('creation-input').disabled, false);
    assert.equal(log.children.length, 4); assert.equal(log.children[0], message); assert.equal(p.sources.length, 1);
  }, { initialGet: () => new Promise((resolve) => { finish = resolve; }) });
});
await check('server strings remain inert text in dialogue, draft, archives and activity', () => {
  const payload = '<img src=x onerror="alert(1)">', initial = draftState();
  initial.creation.dialogue.messages[1].text = payload; initial.creation.dialogue.summary = payload;
  initial.creation.draft.definition.world.title = payload; initial.creation.draft.definition.world.places[0].name = payload;
  initial.creation.worlds = [{ id: 'archive', title: payload, worldMinute: 1 }];
  return withPage(initial, async (p) => {
    assert.match(p.$('dialogue-log').textContent, /<img/); assert.equal(p.$('world-draft-title').textContent, payload);
    assert.match(p.$('world-archives').textContent, /<img/);
    const next = worldState(); next.activity[0].text = payload; next.activity[0].detail = payload; await p.push(next);
    assert.match(p.$('activity-log').textContent, /<img/);
    const visit = (element) => { assert.notEqual(element.tagName, 'IMG'); element.children.forEach(visit); };
    visit(p.document.body);
  });
});
await check('more menu switches archives, creates a new dialogue and returns to the existing world', () => {
  const initial = worldState(); initial.creation.worlds = [{ id: 'archive1', title: '旧港口', worldMinute: 8 }];
  return withPage(initial, async (p) => {
    p.$('more-menu').open = true;
    p.route('/api/control', (body) => { assert.deepEqual(body, { type: 'world-open', worldId: 'archive1' }); return Response.json(result(worldState('archived-world'))); });
    await p.click('world-open'); assert.equal(p.$('more-menu').open, false);
    const next = worldState('archived-world'); next.creation.mode = 'create'; next.creation.dialogue = emptyState().creation.dialogue;
    p.route('/api/control', (body) => { assert.deepEqual(body, { type: 'creation-open' }); return Response.json(result(next)); });
    await p.click('new-world'); assert.equal(p.$('world-resume').hidden, false); assert.equal(p.$('dialogue-log').children.length, 0);
    assert.equal(p.document.activeElement, p.$('creation-input'));
    p.route('/api/control', (body) => { assert.deepEqual(body, { type: 'creation-resume' }); next.creation.mode = 'world'; return Response.json(result(next)); });
    await p.click('world-resume'); assert.equal(p.$('world-experience').hidden, false);
    p.$('more-menu').open = true; p.$('more-menu').dispatch('keydown', { key: 'Escape' });
    assert.equal(p.$('more-menu').open, false); assert.equal(p.document.activeElement.tagName, 'SUMMARY');
  });
});
await check('late preview initialization cannot overwrite the world host and is disposed after it resolves', () => withPage(readyState(), async (p) => {
  p.holdScenes(true); await p.push(draftState());
  const preview = p.scenes[0], previewHost = preview.host;
  assert(previewHost.parentNode); await p.push(worldState());
  assert.equal(previewHost.parentNode, null); assert.equal(p.scenes.length, 2);
  const currentHost = p.$('scene-host').children[0];
  p.sceneStarts.splice(0).forEach((resolve) => resolve()); await settle();
  assert.equal(preview.disposed, true); assert.equal(p.scenes[1].disposed, false);
  assert.equal(p.$('scene-host').children[0], currentHost); assert.equal(p.$('world-draft-scene').children.length, 0);
}));
await check('scene failures keep text usable and offer an explicit renderer retry', () => withPage(readyState(), async (p) => {
  p.failScene(); await p.push(draftState());
  assert.match(p.$('world-draft-scene').textContent, /重新载入场景/);
  assert.equal(p.$('world-accept').disabled, false);
  await p.$('world-draft-scene').querySelector('button').dispatch('click').done; await settle();
  assert.equal(p.scenes.length, 1); assert.equal(p.scenes[0].disposed, false);
}));
await check('pagehide closes SSE, aborts this page request, clears timers and disposes scenes; bfcache restores one subscription', () => withPage(worldState(), async (p) => {
  const stream = heldStream(); p.route('/api/actor-step', (_body, init) => stream.attach(init.signal));
  const task = p.click('actor-step'); await settle(); const request = p.requests.at(-1);
  const count = p.requests.length; p.hide(); await task;
  assert.equal(p.requests.length, count); assert.equal(p.sources[0].closed, true); assert.equal(request.signal.aborted, true);
  assert.equal(p.timers.size, 0); assert(p.scenes.every((scene) => scene.disposed));
  await p.restore(); await p.push(worldState());
  assert.equal(p.sources.filter((source) => !source.closed).length, 1); assert.equal(p.timers.size, 1);
  assert.equal(p.$('actor-step').disabled, false); assert.equal(p.$('activity-log').children.length, 1);
  assert.equal(p.requests.filter((entry) => entry.path === '/api/model-cancel').length, 0);
}));

const summary = { checks: checks.length, passed: checks.filter((item) => item.pass).length, realRequests: 0, modelCalls: 0, privateConfigReads: 0, savedWorldReads: 0, serverStarts: 0, browserRuns: 0 };
console.log(JSON.stringify({ summary, failures: checks.filter((item) => !item.pass) }, null, 2));
if (summary.passed !== summary.checks) process.exitCode = 1;
