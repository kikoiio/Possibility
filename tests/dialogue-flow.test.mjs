import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createPrototypeExperience, createCampServer } from '../server.mjs';
import { createGeneratedFixture } from '../world-definition.mjs';
import { CampSimulation } from '../core.mjs';
import { projectActivity } from '../activity.mjs';
import { parseGeneratedJSON } from '../model/generated-json.mjs';
import { parseGenesisOutput } from '../genesis-records.mjs';
import { checkWorldCandidate } from '../world-genesis.mjs';

const base = resolve('.tmp/prototype'); mkdirSync(base, { recursive: true });
const llm = { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic' };
const reply = payload => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] });
function fixture(t, handler) {
  const directory = mkdtempSync(join(base, 'dialogue-'));
  const requests = [];
  const options = { stateFile: join(directory, 'state.json'), configLoader: () => ({ llm }), fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body), input = JSON.parse(body.input.at(-1).content); requests.push(input);
    assert.equal(body.stream, true); assert.equal('max_output_tokens' in body, false);
    if (input.step) assert.equal(body.text, undefined, 'NDJSON generation must not be forced into one JSON object');
    return handler ? handler(input, requests.length) : reply(input.previousSummary !== undefined
      ? { reply: requests.length === 1 ? '先从观测台开始吗？想看见什么变化？' : '先做观测台和档案室，让电量影响记录星图。可以生成，也可以继续改。', summary: '作者选择从小型海岛观测站开始，人物用电量记录星图，海风补能。', ready: true }
      : createGeneratedFixture());
  } };
  let experience = createPrototypeExperience(options);
  t.after(() => { experience.close(); rmSync(directory, { recursive: true, force: true }); });
  return { options, requests, get experience() { return experience; }, reload() { experience.close(); experience = createPrototypeExperience(options); return experience; } };
}

test('creation is a persisted discussion: clarification, scoped draft, revision, explicit origin', async t => {
  const f = fixture(t); let e = f.experience;
  const first = await e.discussStep({ message: '我想创造一个海岛观测站。' });
  assert.equal(first.ok, true); assert.equal(first.state.creation.dialogue.ready, false);
  assert.equal(first.state.world, null); assert.equal(first.state.creation.draft, null);
  assert.equal((await e.worldStep({ conversationRevision: 1 })).reason, 'discussion-required');
  assert.equal(f.requests.length, 1);
  await e.discussStep({ message: '先从两三个地点开始，电量影响记录星图，海风缓慢补充。' });
  const discussed = e.state().creation.dialogue;
  assert.equal(discussed.ready, true); assert.equal(discussed.messages.length, 4);
  e = f.reload(); assert.deepEqual(e.state().creation.dialogue, discussed); assert.equal(f.requests.length, 2);
  const generated = await e.worldStep({ conversationRevision: discussed.revision });
  assert.equal(generated.ok, true); assert.equal(generated.state.world, null);
  const firstDraft = generated.state.creation.draft;
  assert.equal(f.requests.at(-1).confirmedBrief, discussed.summary);
  assert.equal(f.requests.at(-1).conversation.length, 4);
  await e.discussStep({ message: '把人物的关注点改为修复旧航线。' });
  assert.equal(e.control({ type: 'world-accept', draftId: firstDraft.id }).ok, false);
  assert.equal((await e.worldStep({ conversationRevision: discussed.revision })).ok, false);
  const revised = await e.worldStep({ conversationRevision: e.state().creation.dialogue.revision });
  assert.equal(revised.ok, true); assert.deepEqual(f.requests.at(-1).previousDraft, firstDraft.definition);
  const accepted = e.control({ type: 'world-accept', draftId: revised.state.creation.draft.id });
  assert.equal(accepted.ok, true); assert.equal(accepted.state.worldMinute, 0); assert.equal(accepted.state.paused, true);
  assert.equal(accepted.state.genesis.dialogue.messages.length, 8);
});

test('malformed discussion cannot approve a scope or invent a draft', async t => {
  const f = fixture(t, () => reply({ reply: '已经帮你创造完世界。', ready: true }));
  const result = await f.experience.discussStep({ message: '一个小世界' });
  assert.equal(result.reason, 'invalid-discussion'); assert.equal(result.state.creation.dialogue.ready, false);
  assert.equal(result.state.creation.dialogue.messages.length, 2); assert.equal(result.state.creation.draft, null);
  assert.equal((await f.experience.worldStep({ conversationRevision: 1 })).ok, false);
  assert.equal(f.requests.length, 1);
});

test('discussion accepts provider prose around a complete JSON reply', async t => {
  const payload = { reply: '先从一座小岛的灯室开始，可以继续讨论。', summary: '一座海岛灯室作为起点。', ready: false };
  const f = fixture(t, () => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: `模型说明：\n${JSON.stringify(payload)}` }] }] }));
  const result = await f.experience.discussStep({ message: '我想从海岛灯室开始。' });
  assert.equal(result.ok, true);
  assert.equal(result.reply, payload.reply);
  assert.equal(result.state.creation.dialogue.summary, payload.summary);
  assert.equal(result.state.creation.dialogue.messages.at(-1).text, payload.reply);
});

test('discussion ignores provider metadata and keeps long source material out of the request body', async t => {
  const payload = { reply: '先确定街区和开始时刻。', summary: '等待确定第一片街区与开始时刻。', ready: false, trace: { hidden: true }, citations: ['source-1'] };
  const f = fixture(t, (input) => {
    assert.equal(Object.hasOwn(input.sourceMaterial, 'text'), false);
    assert.equal(Object.hasOwn(input.sourceContext, 'text'), true);
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: `说明文字\n${JSON.stringify(payload)}` }] }] });
  });
  f.experience.control({ type: 'source-set', source: { name: '很长的素材.txt', text: '城市与街区。'.repeat(10000) } });
  const result = await f.experience.discussStep({ message: '从城市街区开始。' });
  assert.equal(result.ok, true);
  assert.equal(result.reply, payload.reply);
  assert.equal(result.state.creation.dialogue.ready, false);
});

test('discussion lets the model request a second local source retrieval pass', async t => {
  const f = fixture(t, (_input, count) => count === 1
    ? reply({ reply: '我先查一下素材中的城市背景。', summary: '需要核对城市背景。', ready: false, retrievalQueries: ['红发会发生的城市与街区'] })
    : reply({ reply: '素材中确认这是伦敦城市起点，我们可以继续缩小开始地点。', summary: '以红发会中的伦敦城市为背景，仍待确定第一片街区。', ready: false }));
  f.experience.control({ type: 'source-set', source: { name: '故事.txt', text: '红发会发生在伦敦城市，故事从萨克斯-科堡广场附近开始。' } });
  const result = await f.experience.discussStep({ message: '我想要红发会里的那个城市。' });
  assert.equal(result.ok, true);
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[1].sourceContext.text, /伦敦/);
  assert.match(result.reply, /伦敦城市/);
});

test('story material survives reload, reaches discussion and generation, and changing it invalidates the draft', async t => {
  const f = fixture(t); let e = f.experience;
  const story = '红发会故事原文。'.repeat(5000);
  const added = e.control({ type: 'source-set', source: { name: '红发会.txt', text: story } });
  assert.equal(added.ok, true);
  assert.deepEqual(added.state.creation.source, { name: '红发会.txt', characters: story.length });
  assert.equal(JSON.stringify(added.state).includes(story), false);
  e = f.reload();
  assert.equal(e.state().creation.source.name, '红发会.txt');
  await e.discussStep({ message: '从威尔逊上班那天开始。' });
  assert.equal(f.requests.at(-1).sourceMaterial.characters, story.length);
  assert(f.requests.at(-1).sourceContext.text.length < story.length);
  assert(f.requests.at(-1).sourceContext.text.length > 0);
  await e.discussStep({ message: '让他发现助理的异常。' });
  const draft = await e.worldStep({ conversationRevision: e.state().creation.dialogue.revision });
  assert.equal(draft.ok, true);
  assert.equal(f.requests.slice(-3).every(request => request.sourceMaterial.characters === story.length), true);
  assert.equal(f.requests.slice(-3).every(request => request.sourceContext.text.length < story.length), true);
  const replaced = e.control({ type: 'source-set', source: { name: '新故事.txt', text: '新的素材。' } });
  assert.equal(replaced.state.creation.draft, null);
  assert.equal(replaced.state.creation.dialogue.ready, false);
  assert.equal(replaced.state.creation.dialogue.summary, '');
  assert.equal(e.control({ type: 'world-accept', draftId: draft.state.creation.draft.id }).ok, false);
  assert.equal(e.control({ type: 'source-set', source: { name: '大文件.txt', text: 'x'.repeat(5_000_001) } }).ok, false);
  assert.equal(e.state().creation.source.name, '新故事.txt');
  assert.equal(e.control({ type: 'source-set', source: null }).state.creation.source, null);
});

test('story upload accepts a long JSON body with UTF-8 characters split between request chunks', async t => {
  const f = fixture(t); const { server, experience } = createCampServer(f.options);
  t.after(() => experience.close()); server.address = () => ({ port: 5175 });
  const story = '红发会'.repeat(12000);
  const data = Buffer.from(JSON.stringify({ type: 'source-set', source: { name: '故事.txt', text: story } }));
  const split = data.indexOf(Buffer.from('红')) + 1;
  const request = Readable.from([data.subarray(0, split), data.subarray(split)]);
  request.method = 'POST'; request.url = '/api/control'; request.headers = { host: '127.0.0.1:5175', 'content-type': 'application/json' };
  const response = { writeHead(code) { this.code = code; }, end(value) { this.body = value; } };
  await server.listeners('request')[0](request, response);
  assert.equal(response.code, 200);
  assert.equal(JSON.parse(response.body).state.creation.source.characters, story.length);
  await experience.discussStep({ message: '从威尔逊上班那天开始。' });
  assert.equal(f.requests.at(-1).sourceMaterial.characters, story.length);
  assert(f.requests.at(-1).sourceContext.text.length < story.length);
});

test('provider literal paragraph breaks preserve reply text without inventing JSON fields', () => {
  const parsed = parseGeneratedJSON('{"reply":"第一段\n\n第二段\t继续","summary":"起点","ready":false}');
  assert.equal(parsed.value.reply, '第一段\n\n第二段\t继续'); assert.equal(parsed.adjustments.length, 3);
  assert.throws(() => parseGeneratedJSON('{"reply":"未完成\n'));
});

test('small semantic records compile the requested mixed places without inventing missing content', () => {
  const records = [
    { type: 'world', title: '测试海边起点', description: '只验证这两处。', weather: '海风', premise: '人物刚刚到来。', landscape: 'coast' },
    { type: 'place', id: 'room', name: '灯室', description: '室内。', space: 'room', grid: [-1, 0], landmark: 'none' },
    { type: 'place', id: 'yard', name: '空地', description: '屋外。', space: 'outdoor', grid: [0, 0], landmark: 'trees' },
    { type: 'actor', id: 'keeper', name: '守灯人', role: '守灯人', goal: '留意灯室。', background: '在此居住。', location: 'room', fatigue: 0 },
    { type: 'connection', from: 'room', to: 'yard' },
    { type: 'memory', actorId: 'keeper', text: '昨晚住在这里。' },
  ];
  const raw = records.map(r => JSON.stringify(r)).join('\n');
  const compiled = parseGenesisOutput(raw).value;
  assert.equal(checkWorldCandidate(compiled).ok, true);
  assert.equal(compiled.world.places.length, 2); assert.equal(compiled.scene.objects.filter(o => o.kind === 'room').length, 1);
  assert.equal(compiled.scene.objects.filter(o => o.kind === 'tree').length, 2);
  assert.equal(compiled.world.processes.length, 0); assert.equal(compiled.world.story.conversations.length, 0);
  assert.throws(() => parseGenesisOutput(raw.slice(0, -1)), /未完整/);
  assert.throws(() => parseGenesisOutput(raw + '\n解释一下'), /非条目/);
  assert.throws(() => parseGenesisOutput(records.slice(1).map(r => JSON.stringify(r)).join('\n')), /世界说明/);
  const duplicate = structuredClone(records); duplicate[2].grid = [-1, 0];
  assert.throws(() => parseGenesisOutput(duplicate.map(r => JSON.stringify(r)).join('\n')), /相同位置/);
});

test('activity describes committed resource consequences; intentions and empty time are absent', () => {
  const simulation = new CampSimulation({ world: createGeneratedFixture().world });
  simulation.act({ type: 'perform', actionId: 'record-chart' }, { actorId: 'mira', source: 'resident' });
  simulation.advanceWorld(1);
  const feed = projectActivity(simulation.snapshot());
  assert.equal(feed.length, 3); assert.equal(new Set(feed.map(e => e.id)).size, 3);
  assert.match(feed[1].text, /米拉.*记录星图/); assert.match(feed[1].detail, /5 → 2/);
  assert.match(feed[2].text, /2 → 4/); assert.match(feed[2].detail, /海风/);
  assert.deepEqual(projectActivity(simulation.snapshot()), feed);
  const empty = createGeneratedFixture().world; empty.resources = []; empty.actions = []; empty.processes = [];
  const quiet = new CampSimulation({ world: empty }); quiet.advanceWorld(5);
  assert.equal(projectActivity(quiet.snapshot()).length, 1);
});

test('live event stream starts with current state and catches up without a model call', async t => {
  const f = fixture(t); const { server, experience } = createCampServer(f.options);
  t.after(() => experience.close()); server.address = () => ({ port: 5175 });
  class Reply extends EventEmitter {
    chunks = []; destroyed = false;
    writeHead(code, headers) { this.code = code; this.headers = headers; }
    flushHeaders() {}
    write(chunk) { this.chunks.push(chunk); return true; }
    end() { this.destroyed = true; this.emit('close'); }
  }
  const request = Readable.from([]); request.method = 'GET'; request.url = '/api/events'; request.headers = { host: '127.0.0.1:5175' };
  const first = new Reply(); await server.listeners('request')[0](request, first);
  assert.equal(first.code, 200); assert.match(first.headers['content-type'], /text\/event-stream/);
  const initial = JSON.parse(first.chunks[0].split('\ndata: ')[1]); assert.equal(initial.world, null);
  await experience.discussStep({ message: '一个海岛观测站。' });
  first.end();
  const second = new Reply(); await server.listeners('request')[0](request, second);
  const restored = JSON.parse(second.chunks[0].split('\ndata: ')[1]);
  assert.equal(restored.creation.dialogue.messages.length, 2); assert.equal(f.requests.length, 1); second.end();
});

const stageRecords = {
  places: [
    { type: 'world', title: '海边灯室', description: '一个小起点。', weather: '海风', premise: '守灯人开始值班。', landscape: 'coast' },
    { type: 'place', id: 'lamp-room', name: '灯室', description: '存放蓄电池。', space: 'room', grid: [0, 0], landmark: 'none' },
  ],
  people: [{ type: 'actor', id: 'keeper', name: '守灯人', role: '值班者', goal: '维持灯光。', background: '在此值班。', location: 'lamp-room', fatigue: 0 }],
  rules: [
    { type: 'resource', id: 'battery', name: '电量', unit: '格', location: 'lamp-room', quantity: 8, capacity: 20 },
    { type: 'process', id: 'wind', description: '风力充电', resourceId: 'battery', deltaPerMinute: 1, when: [] },
    { type: 'action', id: 'use-lamp', name: '使用灯光', description: '消耗电量', location: 'lamp-room', costs: [{ resourceId: 'battery', amount: 3 }], gains: [], requires: [{ resourceId: 'battery', op: 'gte', value: 6 }] },
  ],
};
const recordReply = records => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: records.map(r => JSON.stringify(r)).join('\n') }] }] });

test('generation assembles three small model steps using only their actual records', async t => {
  const f = fixture(t, input => recordReply([...stageRecords[input.step], { type: 'complete' }]));
  const result = await f.experience.worldStep({ description: '海边灯室，守灯人需要电量照明。' });
  assert.equal(result.ok, true); assert.deepEqual(f.requests.map(r => r.step), ['places', 'people', 'rules']);
  assert.deepEqual(f.requests[1].existingRecords, stageRecords.places);
  assert.deepEqual(f.requests[2].existingRecords, [...stageRecords.places, ...stageRecords.people]);
  assert.equal(result.state.world, null);
  const draft = result.state.creation.draft;
  assert.equal(draft.definition.world.actors[0].id, 'keeper');
  assert.equal(draft.definition.world.resources[0].quantity, 8);
  assert.equal(draft.definition.world.actions[0].requires[0].value, 6);
  assert.equal(f.reload().state().creation.draft.id, draft.id);
});

test('an incomplete stage stops subsequent calls and publishes no partial world', async t => {
  const f = fixture(t, input => recordReply(input.step === 'places' ? [...stageRecords.places, { type: 'complete' }] : [{ type: 'complete' }]));
  const result = await f.experience.worldStep({ description: '海边灯室。' });
  assert.equal(result.ok, false); assert.match(result.message, /人物/);
  assert.equal(f.requests.length, 2); assert.equal(result.state.creation.draft, null);
  assert.equal(result.state.world, null); assert.equal(result.state.model.pending, false);
  assert.equal(f.reload().state().creation.draft, null);
});

test('cancelling between generated steps cannot create or resume a partial origin', async t => {
  let entered; const second = new Promise(resolve => { entered = resolve; });
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = fixture(t, async input => {
    if (input.step === 'people') { entered(); await pending; }
    return recordReply([...stageRecords[input.step], { type: 'complete' }]);
  });
  const generating = f.experience.worldStep({ description: '海边灯室。' });
  await second; f.experience.cancelModel(); release();
  const result = await generating;
  assert.equal(result.reason, 'cancelled'); assert.equal(f.requests.length, 2);
  assert.equal(result.state.creation.draft, null); assert.equal(result.state.world, null);
  assert.equal(f.reload().state().model.pending, false);
});

test('explicit generation recovery resumes durable steps; changed basis requires a fresh origin', async t => {
  let fail = true;
  const f = fixture(t, input => input.step === 'rules' && fail ? recordReply([{ type: 'complete', broken: true }]) : recordReply([...stageRecords[input.step], { type: 'complete' }]));
  const description = '海边灯室。';
  const first = await f.experience.worldStep({ description });
  assert.equal(first.ok, false); assert.equal(f.requests.length, 3);
  const generation = first.state.creation.generation;
  assert.deepEqual(generation.completedStages, ['places', 'people']);
  fail = false;
  const e = f.reload();
  assert.equal(f.requests.length, 3, 'restart cannot make a model request');
  const recovered = await e.worldStep({ description, retryGenerationId: generation.id });
  assert.equal(recovered.ok, true);
  assert.deepEqual(f.requests.map(r => r.step), ['places', 'people', 'rules', 'rules']);
  assert.equal(recovered.state.creation.generation.timings.calls.length, 4);
  assert.equal(recovered.state.creation.generation.outcome, 'ready');
  assert.equal((await e.worldStep({ description, retryGenerationId: generation.id })).reason, 'stale-basis');
});
