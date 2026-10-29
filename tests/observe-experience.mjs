import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CampSimulation } from '../core.mjs';
import { createCampExperience, createCampServer } from '../server.mjs';
import { observeResident, buildResidentMessages, verifyDecision } from '../actor.mjs';
import { createEventParser } from '../model/stream-events.mjs';

const base = resolve('.tmp/prototype'); mkdirSync(base, { recursive: true });
const dir = mkdtempSync(join(base, 'experience-')); const active = new Set(); const checks = [];
const llm = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic-secret' };
let fixtureCalls = 0; let fixtureConfigReads = 0;
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
async function check(name, fn) { try { await fn(); checks.push({ name, pass: true }); } catch (error) { checks.push({ name, pass: false, error: error.message }); } }
function mock(action, inspect = () => {}) {
  return async (_url, init) => {
    fixtureCalls++; const body = JSON.parse(init.body); const input = JSON.parse(body.input.at(-1).content); inspect(input, body);
    const proposal = { observationMinute: input.observation.worldMinute, action, reason: '我想照料眼前的住处。', memory: '这是我此刻的理解，并不保证尝试成功。' };
    const response = { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(proposal) }] }] };
    return new Response(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: '{' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
}
function options(name, fetchImpl) { return { stateFile: join(dir, name, 'state.json'), configLoader: () => { fixtureConfigReads++; return { llm }; }, fetchImpl }; }
function room(name, fetchImpl = mock({ type: 'secureCargo' })) { const e = createCampExperience(options(name, fetchImpl)); e.control({ type: 'pause' }); active.add(e); return e; }
function close(e) { e.close(); active.delete(e); }
try {
  await check('fresh camp has two residents and no automatic model calls', () => {
    const e = room('fresh'); assert.equal(e.state().world.actors.length, 2); assert.equal(e.state().autonomy.enabled, false); assert.equal(fixtureConfigReads, 0);
  });
  let firstInput;
  const e = room('shared-save', mock({ type: 'secureCargo' }, (input, body) => { firstInput = input; assert.equal(body.stream, true); assert.equal(Object.hasOwn(body, 'max_output_tokens'), false); }));
  let result;
  await check('resident acts on real camp and stays paused after one minute', async () => {
    result = await e.actorStep({ actorId: 'ihe' }); assert.equal(result.ok, true); assert.equal(result.state.worldMinute, 1); assert.equal(result.state.paused, true);
    assert.equal(result.state.world.camp.cargoSecured, true); assert.equal(result.state.world.actors[0].location, 'tank');
  });
  await check('subjective memory is separate and referenced to actual history', () => {
    const entry = result.state.actors.ihe.lastDecision; assert.equal(entry.outcome.ok, true); assert.equal(entry.observation.cargoSecured, false); assert.equal(entry.after.cargoSecured, true);
    assert.equal(entry.source.fromMinute, 0); assert.equal(entry.source.toMinute, 1); assert.equal(result.state.actors.loran.totalMemories, 0);
  });
  await check('observation excludes other private goals and thermal/global laws', () => {
    const data = JSON.stringify(firstInput); assert.equal(data.includes(e.state().world.actors[1].goal), false); assert.equal(data.includes('mechanism'), false); assert.equal(Object.hasOwn(firstInput, 'world'), false);
  });
  close(e); let loranInput;
  const restored = room('shared-save', mock({ type: 'rest' }, (input) => { loranInput = input; }));
  await check('world and personal memory reload together', () => { assert.equal(restored.state().actors.ihe.totalMemories, 1); assert.equal(restored.state().world.camp.cargoSecured, true); });
  await check('second resident receives no first resident memories', async () => {
    const r = await restored.actorStep({ actorId: 'loran' }); assert.equal(r.ok, true); assert.equal(loranInput.memories.length, 0); assert.equal(loranInput.observation.actorId, 'loran');
    assert.equal(r.state.actors.loran.totalMemories, 1); assert.equal(r.state.actors.ihe.totalMemories, 1);
  });
  await check('cabin observer cannot see current outdoor resource readings', () => {
    const snapshot = CampSimulation.load(join(dir, 'shared-save/state.json')).view(1);
    const view = observeResident(snapshot, 'loran'); assert.equal(view.waterL, null); assert.equal(view.plantHealth, null); assert.equal(view.deckWetness, null); assert.equal(view.windKph, null);
    assert.equal(view.neighbors.length, 0);
  });
  await check('outside observer does not know a hidden cabin resident goal', () => {
    const snapshot = CampSimulation.load(join(dir, 'shared-save/state.json')).view(1);
    snapshot.world.privateSecret = 'hidden-fixture'; snapshot.world.actors[1].privateThought = 'hidden-thought';
    const view = observeResident(snapshot, 'ihe'); assert.equal(view.neighbors.length, 0); assert.equal(JSON.stringify(view).includes('hidden-'), false);
  });
  await check('saved input retrieval is owner-scoped', () => {
    const snapshot = CampSimulation.load(join(dir, 'shared-save/state.json')).snapshot();
    const input = JSON.parse(buildResidentMessages(snapshot, 'ihe', snapshot.experience.ledgers).at(-1).content);
    assert.equal(input.memories.length, 1); assert.equal(input.memories[0].observation.actorId, 'ihe');
  });
  await check('altered memory time provenance is quarantined on reload', () => {
    const snapshot = JSON.parse(readFileSync(join(dir, 'shared-save/state.json'), 'utf8'));
    const entry = snapshot.experience.ledgers.ihe.entries[0];
    entry.source.fromMinute += 100; entry.source.toMinute += 100;
    mkdirSync(join(dir, 'invalid-memory'), { recursive: true });
    writeFileSync(join(dir, 'invalid-memory/state.json'), JSON.stringify(snapshot));
    const invalid = room('invalid-memory');
    assert.equal(invalid.state().actors.ihe.totalMemories, 0);
    assert.equal(invalid.state().autonomy.waitingReason, 'invalid-saved-memory');
    assert.equal(invalid.state().world.camp.cargoSecured, true);
  });
  await check('model cannot use author-only weather or change another resident', () => {
    const observation = firstInput.observation;
    const proposal = { observationMinute: observation.worldMinute, action: { type: 'setWeather', mode: 'rain' }, reason: 'fixture', memory: 'fixture' };
    assert.equal(verifyDecision(proposal, observation).ok, false); proposal.action = { type: 'rest', actorId: 'loran' }; assert.equal(verifyDecision(proposal, observation).ok, false);
  });
  await check('invalid candidate creates no action or subjective memory', async () => {
    const invalid = room('invalid', mock({ type: 'teleport' })); const r = await invalid.actorStep({ actorId: 'ihe' });
    assert.equal(r.reason, 'invalid-decision'); assert.equal(r.state.worldMinute, 0); assert.equal(r.state.actors.ihe.totalMemories, 0);
  });
  await check('failed water attempt preserves actual resource consequences', async () => {
    const failed = room('failed', mock({ type: 'waterPlants', liters: 39 }));
    const expected = new CampSimulation(); expected.advanceWorld(1);
    const r = await failed.actorStep({ actorId: 'ihe' }); assert.equal(r.ok, true); assert.equal(r.state.actors.ihe.lastDecision.outcome.reason, 'insufficient-water');
    assert.equal(r.state.world.camp.waterL, expected.view(1).world.camp.waterL); assert.equal(r.state.world.actors[0].location, 'terrace');
  });
  await check('intervention rejects a stale decision', async () => {
    const gate = deferred(); const started = deferred(); const pending = room('stale', async (...args) => { started.resolve(); await gate.promise; return mock({ type: 'secureCargo' })(...args); });
    const promise = pending.actorStep({ actorId: 'ihe' }); await started.promise;
    pending.control({ type: 'action', action: { type: 'setWeather', mode: 'clear' } }); gate.resolve(); const r = await promise;
    assert.equal(r.reason, 'stale-basis'); assert.equal(r.state.world.weather.mode, 'clear'); assert.equal(r.state.worldMinute, 0); assert.equal(r.state.actors.ihe.totalMemories, 0);
  });
  await check('cancel discards output without applying action', async () => {
    const started = deferred(); const pending = room('cancel', async () => { started.resolve(); return new Promise(() => {}); });
    const promise = pending.actorStep({ actorId: 'ihe' }); await started.promise; pending.cancelModel(); const r = await promise;
    assert.equal(r.reason, 'cancelled'); assert.equal(r.state.worldMinute, 0); assert.equal(r.state.actors.ihe.totalMemories, 0);
  });
  await check('reset cannot inherit the old call or its result', async () => {
    const started = deferred(); const pending = room('reset', async () => { started.resolve(); return new Promise(() => {}); });
    const promise = pending.actorStep({ actorId: 'ihe' }); await started.promise;
    pending.control({ type: 'reset' }); pending.control({ type: 'pause' }); await promise;
    const r = pending.state(); assert.equal(r.worldMinute, 0); assert.equal(r.model.lastResult, null); assert.equal(r.autonomy.enabled, false);
    const copy = room('reset'); assert.equal(copy.state().autonomy.waitingReason, null);
  });
  await check('disable save cannot resurrect an aborted call', async () => {
    const started = deferred(); const pending = room('disable', async () => { started.resolve(); return new Promise(() => {}); });
    pending.control({ type: 'autonomy', enabled: true }); const promise = pending.actorStep({ actorId: 'ihe' }); await started.promise;
    pending.control({ type: 'autonomy', enabled: false });
    mkdirSync(join(dir, 'disabled-copy'), { recursive: true }); copyFileSync(join(dir, 'disable/state.json'), join(dir, 'disabled-copy/state.json'));
    const copy = room('disabled-copy'); assert.equal(copy.state().autonomy.waitingReason, null); assert.equal(copy.state().autonomy.enabled, false);
    await promise; assert.equal(pending.state().autonomy.waitingReason, null);
  });
  await check('restart marks an interrupted call rather than replaying it', async () => {
    const started = deferred(); const pending = room('interrupted', async () => { started.resolve(); return new Promise(() => {}); });
    const promise = pending.actorStep({ actorId: 'ihe' }); await started.promise;
    mkdirSync(join(dir, 'interrupted-copy'), { recursive: true }); copyFileSync(join(dir, 'interrupted/state.json'), join(dir, 'interrupted-copy/state.json'));
    const copy = room('interrupted-copy'); assert.equal(copy.state().autonomy.waitingReason, 'interrupted'); assert.equal(copy.state().waiting, 'actor:interrupted');
    pending.cancelModel(); await promise;
  });
  await check('autonomous failure stops instead of retrying on every tick', async () => {
    let calls = 0; const automatic = room('automatic', async () => { calls++; return new Response('{}', { status: 429 }); });
    automatic.control({ type: 'autonomy', enabled: true }); automatic.control({ type: 'resume' });
    await new Promise((r) => setTimeout(r, 1100)); assert.equal(calls, 1); assert.equal(automatic.state().waiting, 'actor:http-error'); automatic.control({ type: 'autonomy', enabled: false });
  });
  await check('audits are role-tagged and secrets are redacted', () => { const text = readFileSync(join(dir, 'shared-save/model-calls.jsonl'), 'utf8'); assert.equal(text.includes(llm.apiKey), false); assert.equal(text.includes('"role":"resident"'), true); });
  await check('actor HTTP endpoint delivers streaming progress and final state', async () => {
    const { server, experience } = createCampServer({ ...options('http', mock({ type: 'setCanopy', open: true })), withCreation: false }); active.add(experience); experience.control({ type: 'pause' }); server.address = () => ({ port: 5175 });
    const request = Readable.from(['{"actorId":"loran"}']); request.method = 'POST'; request.url = '/api/actor-step'; request.headers = { host: '127.0.0.1:5175', accept: 'text/event-stream', 'content-type': 'application/json' };
    class Reply extends EventEmitter { chunks = []; headersSent = false; destroyed = false; writeHead(code, headers) { this.code = code; this.headers = headers; this.headersSent = true; } flushHeaders() {} write(text) { this.chunks.push(text); return true; } end(text = '') { if (text) this.chunks.push(text); } }
    const response = new Reply(); await server.listeners('request')[0](request, response);
    const frames = []; const parser = createEventParser((frame) => frames.push(frame)); parser.push(response.chunks.join('')); parser.end();
    const result = JSON.parse(frames.find((frame) => frame.event === 'result').data);
    assert.equal(response.code, 200); assert.equal(frames.some((frame) => frame.event === 'progress'), true); assert.equal(result.ok, true); assert.equal(result.state.world.camp.canopyOpen, true); assert.equal(result.state.actors.loran.totalMemories, 1);
  });
} finally { for (const e of active) e.close(); rmSync(dir, { recursive: true, force: true }); }
const summary = { checks: checks.length, passed: checks.filter((c) => c.pass).length, fixtureCalls, fixtureConfigReads, realRequests: 0, privateConfigReads: 0 };
writeFileSync(join(base, 'experience-observation.json'), JSON.stringify({ summary, checks }, null, 2) + '\n');
console.log(JSON.stringify({ summary, failures: checks.filter((c) => !c.pass) }, null, 2));
if (summary.checks !== summary.passed) process.exitCode = 1;
