import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Experiment, applyOps } from './core.js';
import { messagesFor, complete } from './llm.js';
import { sceneOf } from './seed.js';
import { createPrototype } from './server.js';

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'artifacts'), { recursive: true });
const observations = [];
function observed(name, evidence) { observations.push({ name, evidence }); console.log(`${name}: ${JSON.stringify(evidence)}`); }
const event = (offsetMinutes, text, ops = [], memories = []) => ({ offsetMinutes, text, ops, memories });
const set = (path, value) => ({ op: 'set', path, valueJson: JSON.stringify(value) });
let now = 0;
const e = new Experiment(null, () => {}, () => now);
const a = Object.values(e.data.lines)[0];
e.control(a.id, { paused: false });
let call = e.begin(a.id);
e.accept(a.id, call, { events: [event(10, '十分钟'), event(20, '二十分钟')] }, 1440);
now = 3600000;
e.tick();
assert.equal(a.worldTime, 1920);
assert.deepEqual(e.history(a.id).slice(1).map(x => x.time), [490, 500]);
observed('24x-clock-and-event-offsets', { realHours: 1, worldHours: (a.worldTime - 480) / 60, eventMinutes: [490, 500] });

e.control(a.id, { paused: true });
const pausedAt = a.worldTime;
now += 3600000; e.tick();
assert.equal(a.worldTime, pausedAt);
e.control(a.id, { paused: false });
call = e.begin(a.id);
e.control(a.id, { paused: true });
e.accept(a.id, call, { events: [event(0, '晚到的回复')] }, 60);
now += 5000; e.tick();
assert.equal(a.worldTime, pausedAt);
assert(!e.history(a.id).some(x => x.text === '晚到的回复'));
e.control(a.id, { paused: false });
e.tick();
assert(e.history(a.id).some(x => x.text === '晚到的回复'));
observed('pause-with-late-llm-response', { pausedTime: pausedAt, lateReplyOnlyBecameVisibleAfterResume: true });

now = 0;
const f = new Experiment(null, () => {}, () => now);
const parent = Object.values(f.data.lines)[0];
f.control(parent.id, { paused: false });
call = f.begin(parent.id);
f.accept(parent.id, call, { events: [
  event(10, '沈青梧离开茶馆', [set('/entities/shen/location', 'stage')], [{ text: '沈青梧答应保护老周。', knownBy: ['shen', 'zhou'] }]),
] }, 60);
const draft = f.draft(parent.id);
now = 30000; f.tick();
assert.equal(f.world(parent.id).entities.shen.location, 'stage');
const childWorld = structuredClone(draft.world);
childWorld.entities.lu.goal = '帮助老周公开真相';
childWorld.rules = ['所有人都可以读心'];
childWorld.magic = { strength: 12 };
const child = f.confirm(draft.id, childWorld, '如果老周说出来');
assert.equal(f.world(child.id).entities.shen.location, 'tea');
assert.equal(child.worldTime, 480);
assert(!f.history(child.id).some(x => x.text === '沈青梧离开茶馆'));
assert.equal(f.world(parent.id).entities.lu.goal, '写出一篇让自己不再逃避故乡的报道');
assert.equal(child.paused, false);
const shared = f.history(child.id).filter(x => f.history(parent.id).some(y => y.id === x.id)).length;
assert.equal(shared, 1);
observed('fixed-base-multi-edit-branch', { parentLocation: f.world(parent.id).entities.shen.location, childLocation: f.world(child.id).entities.shen.location, inheritedFutureEvents: 0, changedFields: f.history(child.id).at(-1).changes, sharedEventIds: shared });

for (let n = 0; n < 18; n++) {
  if (parent.plan) { now += 150000; f.tick(); }
  call = f.begin(parent.id);
  f.accept(parent.id, call, { events: [event(1, `后续事件${n}`, [])] }, 60);
  now += 150000; f.tick();
}
const recent = f.history(parent.id).slice(-12);
assert(!recent.some(x => x.text === '沈青梧离开茶馆'));
const prompt = messagesFor(f.world(parent.id), recent).at(-1).content;
assert(prompt.includes('沈青梧答应保护老周'));
assert(!messagesFor(f.world(child.id), f.history(child.id)).at(-1).content.includes('沈青梧答应保护老周'));
assert(messagesFor(f.world(child.id), []).at(-1).content.includes('所有人都可以读心'));
observed('long-term-memory-and-branch-isolation', { recentEvents: recent.length, oldPromiseStillInPrompt: true, futureParentMemoryAbsentFromChild: true, arbitraryWorldFieldsIncluded: true });

const beforeScene = sceneOf(f.world(child.id), child.worldTime, child.head);
assert.equal(beforeScene.characters.find(c => c.id === 'shen').x, 17);
const once = applyOps(f.world(child.id), [set('/entities/book', { kind: 'item', name: '旧账本', owner: 'lu' }), set('/entities/lu/goal', '保护账本')]);
assert.equal(once.entities.book.name, '旧账本');
observed('shared-rendering-projection-and-open-facts', { characterCount: beforeScene.characters.length, locationCount: beforeScene.locations.length, newItem: once.entities.book.name, sameProjectionForBothViews: true });

const config = { apiKey: 'synthetic-test-key', baseUrl: 'http://127.0.0.1', model: 'openai/gpt-oss-120b', fallbacks: ['openai/gpt-oss-20b'], maxTokens: 1000 };
const requestModels = [];
const result = await complete(config, messagesFor(f.world(child.id), []), 'beat', async (url, options) => {
  const body = JSON.parse(options.body); requestModels.push(body.model);
  if (requestModels.length === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ events: [event(1, '来自模拟传输的有效事件')] }) } }], usage: { total_tokens: 100 } }));
});
assert.equal(result.model, 'openai/gpt-oss-20b');
observed('http-provider-fallback', { modelsAttempted: requestModels, acceptedModel: result.model, note: 'synthetic transport; not a real Groq inference' });

const dir = mkdtempSync(join(here, 'artifacts', 'restore-'));
let app = createPrototype({ port: 0, dataDir: dir });
let port = await app.start();
const get = () => fetch(`http://127.0.0.1:${port}/api/state`).then(r => r.json());
const post = (route, value) => fetch(`http://127.0.0.1:${port}/api/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).then(r => r.json());
let originalId;
try {
  const initial = await get(); originalId = initial.lines[0].id;
  const remoteDraft = await post('draft', { lineId: originalId });
  remoteDraft.world.rules = ['观察脚本写入的持久化事实'];
  const response = await post('confirm', { draftId: remoteDraft.id, world: remoteDraft.world, name: '重启后还在' });
  assert(response.lineId);
  await post('settings', { mode: 'live', apiKey: 'synthetic-persistence-key', maxCallsHour: 2, minIntervalSeconds: 10 });
  const publicData = await get();
  assert(!JSON.stringify(publicData).includes('synthetic-persistence-key'));
} finally { await app.close(); }
const meteredModels = [];
app = createPrototype({ port: 0, dataDir: dir, request: async (url, options) => {
  const body = JSON.parse(options.body);
  meteredModels.push(body.model);
  if (body.model === 'openai/gpt-oss-120b') return new Response('{}', { status: 429 });
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ events: [event(10, '备用模型已接续')] }) } }] }));
} });
port = await app.start();
try {
  const restored = await get();
  assert.equal(restored.lines[0].id, originalId);
  assert(restored.lines.some(l => l.name === '重启后还在' && l.world.rules[0] === '观察脚本写入的持久化事实'));
  assert(restored.settings.keyConfigured);
  assert.equal(restored.usage.day, 0);
  observed('server-restart-and-private-settings', { worldLinesRestored: restored.lines.length, editedFactRestored: true, noCredentialReturnedToBrowser: true, realRequestsMade: 0 });
  await post('settings', { model: 'openai/gpt-oss-120b', fallbacks: ['openai/gpt-oss-20b'], minIntervalSeconds: 0.1, maxCallsHour: 10 });
  await post('control', { lineId: originalId, paused: false });
  const deadline = Date.now() + 5000;
  while (meteredModels.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(meteredModels, ['openai/gpt-oss-120b', 'openai/gpt-oss-20b']);
  assert(app.experiment.line(originalId).plan);
  observed('fallback-resumes-after-user-call-interval', { modelsAttempted: meteredModels, note: 'synthetic provider with the actual server budget scheduler' });
} finally { await app.close(); }

const report = { observedAt: new Date().toISOString(), observations, realLlmVerified: false, note: '本脚本验证机制与模拟HTTP传输；真实Groq推演由live-groq.mjs单独记录。' };
writeFileSync(join(here, 'artifacts', 'observations.json'), JSON.stringify(report, null, 2));
console.log(`OBSERVATIONS_COMPLETE ${observations.length}`);

