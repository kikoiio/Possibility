import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CampSimulation } from '../core.mjs';
import { GENERATED_LIMITS, applyGeneratedAction, createGeneratedFixture, stepGeneratedWorld, validateGeneratedWorld, validateWorldDefinition } from '../world-definition.mjs';
import { buildResidentMessages, createLedgers, observeResident, verifyDecision } from '../actor.mjs';
import { createMansionFixture } from '../fixtures/mansion-fixture.mjs';
import { createCampExperience } from '../server.mjs';

const actor = { actorId: 'mira', source: 'resident', decisionId: 'conditional-test' };
const resource = (world, id) => world.resources.find((r) => r.id === id);
const condition = (resourceId, op, value) => ({ resourceId, op, value });
const perform = (actionId) => ({ type: 'perform', actionId });
const propose = (observation, action) => ({ observationMinute: observation.worldMinute, action, reason: '根据当前条件尝试。', memory: '以实际结果为准。' });
const observe = (world, actorId = 'mira') => observeResident({ world, worldMinute: 0 }, actorId);

function conditionalFixture(open = 0) {
  const definition = createGeneratedFixture();
  const { world } = definition;
  world.resources.push({ id: 'gate', name: '蓄能开关', unit: '档', location: 'observatory', quantity: open, capacity: 1 });
  world.processes[0].when = [condition('gate', 'gte', 1)];
  world.actions[0].requires = [condition('gate', 'gte', 1)];
  world.actions.push(
    { id: 'open-gate', name: '打开蓄能开关', description: '把开关设为开启。', location: 'observatory', costs: [], gains: [{ resourceId: 'gate', amount: 1 }], requires: [condition('gate', 'lte', 0)] },
    { id: 'close-gate', name: '关闭蓄能开关', description: '把开关设为关闭。', location: 'observatory', costs: [{ resourceId: 'gate', amount: 1 }], gains: [], requires: [condition('gate', 'gte', 1)] },
  );
  return definition;
}

test('optional conditions accept empty lists, inclusive bounds and cross-place process gates', () => {
  const definition = createGeneratedFixture();
  assert.deepEqual(validateWorldDefinition(definition), []);
  definition.world.processes[0].when = [];
  definition.world.actions[0].requires = [];
  assert.deepEqual(validateWorldDefinition(definition), []);
  definition.world.processes[0].when = [condition('seals', 'gte', 0), condition('seals', 'lte', 10)];
  definition.world.actions[0].requires = [condition('charge', 'gte', 0), condition('charge', 'lte', 12)];
  assert.deepEqual(validateWorldDefinition(definition), []);
  definition.world.actions[0].requires = [condition('seals', 'gte', 1)];
  assert.ok(validateGeneratedWorld(definition.world).some((e) => e.path === 'world.actions[0].requires[0].resourceId' && e.code === 'resource-location'));
});

test('condition fields, resource references, finite thresholds and collection bounds are strict', () => {
  const badConditions = [
    [null, '', 'collection-size'], [undefined, '', 'collection-size'], [{}, '', 'collection-size'],
    [Array.from({ length: GENERATED_LIMITS.conditions + 1 }, () => condition('charge', 'gte', 1)), '', 'collection-size'],
    [[null], '[0]', 'object'], [[[]], '[0]', 'object'],
    [[condition('missing', 'gte', 1)], '[0].resourceId', 'reference'],
    [[condition('charge', 'gt', 1)], '[0].op', 'condition-op'],
    [[{ resourceId: 'charge', op: 'gte' }], '[0].value', 'required'],
    [[{ resourceId: 'charge', value: 1 }], '[0].op', 'required'],
    [[{ op: 'gte', value: 1 }], '[0].resourceId', 'required'],
    [[{ ...condition('charge', 'gte', 1), script: 'invented()' }], '[0].script', 'unknown-field'],
    ...[NaN, Infinity, -Infinity, -1, 13, '1', null].map((value) => [[condition('charge', 'gte', value)], '[0].value', 'condition-range']),
  ];
  for (const [collection, key] of [['processes', 'when'], ['actions', 'requires']]) {
    for (const [value, suffix, code] of badConditions) {
      const { world } = createGeneratedFixture();
      world[collection][0][key] = value;
      assert.ok(validateGeneratedWorld(world).some((e) => e.path === `world.${collection}[0].${key}${suffix}` && e.code === code), `${collection}.${key}${suffix}: ${code}`);
    }
  }
});

test('identical time origins with different switches cause different minute settlements', () => {
  const offWorld = conditionalFixture(0).world;
  const onWorld = conditionalFixture(1).world;
  const before = structuredClone(offWorld);
  const off = new CampSimulation({ world: offWorld });
  const on = new CampSimulation({ world: onWorld });
  off.advanceWorld(1); on.advanceWorld(1);
  assert.equal(off.view(0).worldMinute, on.view(0).worldMinute);
  assert.equal(resource(off.view(0).world, 'charge').quantity, 5);
  assert.equal(resource(on.view(0).world, 'charge').quantity, 7);
  const stopped = off.view(1).history.at(-1).event;
  assert.deepEqual(stopped.settlements.find((s) => s.resourceId === 'charge'), { resourceId: 'charge', before: 5, requestedDelta: 0, appliedDelta: 0, after: 5, overflow: 0, unmetDemand: 0 });
  assert.equal(stopped.processes[0].active, false);
  assert.equal(stopped.processes[0].requestedDelta, 0);
  assert.match(stopped.processes[0].message, /蓄能开关.*0.*1/);
  assert.equal(on.view(1).history.at(-1).event.processes[0].active, true);
  assert.deepEqual(offWorld, before);
});

test('an action changes the next process step and later available choices', () => {
  const sim = new CampSimulation({ world: conditionalFixture().world });
  const ready = () => observeResident(sim.view(0), 'mira').availableActions.find((a) => a.id === 'record-chart').executable;
  assert.equal(ready(), false);
  assert.equal(sim.act(perform('open-gate'), actor).ok, true);
  assert.equal(sim.view(0).worldMinute, 0);
  assert.equal(resource(sim.view(0).world, 'charge').quantity, 5);
  assert.equal(ready(), true);
  sim.advanceWorld(1);
  assert.equal(resource(sim.view(0).world, 'charge').quantity, 7);
  assert.equal(sim.act(perform('close-gate'), actor).ok, true);
  assert.equal(ready(), false);
  sim.advanceWorld(1);
  assert.equal(resource(sim.view(0).world, 'charge').quantity, 7);
  assert.equal(sim.view(1).history.at(-1).event.processes[0].active, false);
});

test('all gates read the minute start even when other processes change their resources', () => {
  for (const [start, rate, expected] of [[0, 1, [5, 7]], [1, -1, [7, 7]]]) {
    let canonical;
    for (const reverseResources of [false, true]) for (const reverseProcesses of [false, true]) {
      const { world } = conditionalFixture(start);
      world.processes.push({ id: 'switch-change', description: '开关状态按分钟改变。', resourceId: 'gate', deltaPerMinute: rate });
      if (reverseResources) world.resources.reverse();
      if (reverseProcesses) world.processes.reverse();
      const one = stepGeneratedWorld(world);
      const two = stepGeneratedWorld(one.world);
      assert.deepEqual([resource(one.world, 'charge').quantity, resource(two.world, 'charge').quantity], expected);
      const evidence = { processes: one.event.processes, settlements: [...one.event.settlements].sort((a, b) => a.resourceId.localeCompare(b.resourceId)) };
      if (canonical) assert.deepEqual(evidence, canonical);
      else canonical = evidence;
    }
  }
});

test('all conditions are required, thresholds are inclusive and active deltas still clamp', () => {
  const { world } = conditionalFixture(1);
  world.processes[0].when.push(condition('charts', 'lte', 1));
  resource(world, 'charts').quantity = 1;
  resource(world, 'charge').quantity = 11;
  const active = stepGeneratedWorld(world);
  assert.deepEqual(active.event.settlements.find((s) => s.resourceId === 'charge'), { resourceId: 'charge', before: 11, requestedDelta: 2, appliedDelta: 1, after: 12, overflow: 1, unmetDemand: 0 });
  resource(world, 'charts').quantity = 2;
  assert.equal(resource(stepGeneratedWorld(world).world, 'charge').quantity, 11);
  world.actions[0].requires.push(condition('charts', 'lte', 1));
  assert.equal(applyGeneratedAction(world, perform('record-chart'), actor).result.reason, 'requirements-not-met');
  resource(world, 'charts').quantity = 1;
  assert.equal(applyGeneratedAction(world, perform('record-chart'), actor).result.ok, true);
});

test('requirements reject before costs and cause zero movement, fatigue, history or time change', () => {
  const { world } = conditionalFixture();
  resource(world, 'charge').quantity = 1;
  world.actors[0].location = 'harbor';
  const sim = new CampSimulation({ world });
  const before = sim.snapshot();
  const result = sim.act(perform('record-chart'), actor);
  assert.equal(result.reason, 'requirements-not-met');
  assert.match(result.message, /米拉.*记录星图.*蓄能开关.*0.*1/);
  assert.deepEqual(sim.snapshot(), before);
  const direct = applyGeneratedAction(world, perform('record-chart'), actor);
  assert.deepEqual(Object.keys(direct), ['result']);
  assert.deepEqual(world, before.world);
  const allowed = conditionalFixture(1).world;
  allowed.actions[0].requires.push(condition('charge', 'gte', 5));
  const done = applyGeneratedAction(allowed, perform('record-chart'), actor);
  assert.equal(done.result.ok, true);
  assert.equal(resource(done.world, 'charge').quantity, 2);
});

test('conditional action observation explains resource and capacity blockers without changing decision shape', () => {
  const { world } = conditionalFixture(1);
  let observation = observe(world);
  let action = observation.availableActions[0];
  assert.deepEqual(action.requires, [condition('gate', 'gte', 1)]);
  assert.equal(action.executable, true);
  assert.deepEqual(action.unmetRequirements, []);
  action.requires[0].value = 0;
  assert.equal(world.actions[0].requires[0].value, 1);
  resource(world, 'charge').quantity = 1;
  observation = observe(world); action = observation.availableActions[0];
  assert.equal(action.executable, false);
  assert.equal(action.unmetRequirements[0].reason, 'insufficient-resource');
  assert.match(action.unmetRequirements[0].message, /1.*3.*2/);
  assert.equal(verifyDecision(propose(observation, perform(action.id)), observation).ok, true);
  assert.equal(applyGeneratedAction(world, perform(action.id), actor).result.reason, 'insufficient-resource');
  resource(world, 'charge').quantity = 5;
  resource(world, 'charts').quantity = 20;
  action = observe(world).availableActions[0];
  assert.equal(action.executable, false);
  assert.equal(action.unmetRequirements[0].reason, 'resource-capacity');
  assert.equal(applyGeneratedAction(world, perform(action.id), actor).result.reason, 'resource-capacity');
  world.actions[0].costs = [{ resourceId: 'charge', amount: 3 }];
  world.actions[0].gains = [{ resourceId: 'charge', amount: 2 }];
  resource(world, 'charge').quantity = 12;
  assert.equal(observe(world).availableActions[0].executable, true);
  assert.equal(resource(applyGeneratedAction(world, perform(action.id), actor).world, 'charge').quantity, 11);
});

test('cross-place processes run without sending hidden controls or process descriptions to residents', () => {
  const { world } = createGeneratedFixture();
  world.processes[0].when = [condition('seals', 'gte', 4)];
  world.processes[0].description = 'REMOTE-PROCESS-SECRET';
  const before = observe(world);
  assert.deepEqual(validateGeneratedWorld(world), []);
  assert.equal(resource(stepGeneratedWorld(world).world, 'charge').quantity, 5);
  resource(world, 'seals').quantity = 4;
  assert.equal(resource(stepGeneratedWorld(world).world, 'charge').quantity, 7);
  assert.deepEqual(observe(world), before);
  const messages = buildResidentMessages({ world, worldMinute: 0 }, 'mira', createLedgers(world));
  const input = messages.at(-1).content;
  for (const hidden of ['seals', '档案封签', 'REMOTE-PROCESS-SECRET', 'wind-charge', '"processes"']) assert.equal(input.includes(hidden), false);
});

test('unseen requirements stay unknown and reveal neither predicates nor hidden quantities', () => {
  const { world } = createGeneratedFixture();
  world.actions[0].requires = [condition('seals', 'gte', 3)];
  // Defense at the observation boundary, even for a malformed cross-place action.
  assert.ok(validateGeneratedWorld(world).some((e) => e.code === 'resource-location'));
  const hidden = resource(world, 'seals');
  hidden.name = 'HIDDEN-RESOURCE-NAME';
  hidden.quantity = 1;
  const blocked = observe(world);
  const failure = applyGeneratedAction(world, perform('record-chart'), actor).result;
  hidden.quantity = 9;
  world.actions[0].requires = [condition('seals', 'lte', 9), condition('seals', 'gte', 7)];
  const satisfied = observe(world);
  assert.deepEqual(satisfied, blocked);
  assert.deepEqual(applyGeneratedAction(world, perform('record-chart'), actor).result, failure);
  assert.deepEqual(satisfied.availableActions[0].requires, []);
  assert.equal(satisfied.availableActions[0].executable, null);
  assert.equal(satisfied.availableActions[0].unmetRequirements.length, 1);
  assert.equal(satisfied.availableActions[0].unmetRequirements[0].reason, 'requirements-not-visible');
  const input = JSON.stringify(buildResidentMessages({ world, worldMinute: 0 }, 'mira', createLedgers(world)));
  for (const hiddenValue of ['seals', 'HIDDEN-RESOURCE-NAME', '"op":"lte"']) assert.equal(input.includes(hiddenValue), false);
  world.actions.push({ id: 'hidden-action', name: 'PRIVATE-ACTION-NAME', description: 'PRIVATE-ACTION-DESCRIPTION', location: 'archive', costs: [], gains: [], requires: [condition('seals', 'gte', 10)] });
  const remote = applyGeneratedAction(world, perform('hidden-action'), actor).result;
  assert.equal(remote.ok, false);
  assert.equal(remote.message.includes('PRIVATE-'), false);
  assert.equal(remote.message.includes(hidden.name), false);
});

test('successful messages describe only actual resource effects and identify the resident action', () => {
  const { world } = conditionalFixture(1);
  const done = applyGeneratedAction(world, perform('record-chart'), actor);
  assert.match(done.result.message, /米拉.*潮汐观测台.*记录星图/);
  assert.match(done.result.message, /风能电池 5 → 2 格/);
  assert.match(done.result.message, /星图 0 → 1 张/);
  assert.equal(done.result.message.includes('蓄能开关'), false);
  assert.equal(done.result.message.includes('下一分钟'), false);
  assert.deepEqual(done.event.effects.resources, [{ resourceId: 'charge', before: 5, after: 2 }, { resourceId: 'charts', before: 0, after: 1 }]);
  assert.deepEqual(done.event.result, done.result);
  const rest = applyGeneratedAction(world, { type: 'rest' }, actor);
  assert.match(rest.result.message, /米拉.*休息.*15 → 3/);
  const moved = applyGeneratedAction(world, { type: 'moveTo', location: 'harbor' }, actor);
  assert.match(moved.result.message, /米拉.*潮汐观测台.*风帆码头/);
  assert.match(applyGeneratedAction(world, { type: 'observe' }, actor).result.message, /米拉.*观察/);
  world.actions[0].gains = [{ resourceId: 'charge', amount: 3 }];
  const unchanged = applyGeneratedAction(world, perform('record-chart'), actor);
  assert.deepEqual(unchanged.event.effects.resources, []);
  assert.equal(unchanged.result.message.includes('→'), false);
});

test('story observations preserve local privacy, inspection messages hide details and speech keeps real text', () => {
  const { world } = createMansionFixture();
  world.resources.push(
    { id: 'hall-gate', name: '会客厅开关', unit: '档', location: 'hall', quantity: 0, capacity: 1 },
    { id: 'study-gate', name: '书房秘密开关', unit: '档', location: 'study', quantity: 1, capacity: 1 },
  );
  world.actions.push(
    { id: 'hall-work', name: '整理会客厅', description: '整理眼前桌面。', location: 'hall', costs: [], gains: [], requires: [condition('hall-gate', 'gte', 1)] },
    { id: 'study-work', name: '整理书房', description: '整理书桌。', location: 'study', costs: [], gains: [], requires: [condition('study-gate', 'gte', 1)] },
  );
  const lin = observe(world, 'lin');
  assert.ok(lin.places.some((p) => p.id === 'study'));
  assert.deepEqual(lin.availableActions.map((a) => a.id), ['hall-work']);
  assert.equal(JSON.stringify(lin).includes('study-gate'), false);
  assert.equal(lin.availableActions[0].executable, false);
  const inspected = applyGeneratedAction(world, { type: 'inspect', clueId: 'folded-note' }, { actorId: 'lin' });
  const detail = world.story.clues[0].detail;
  assert.match(inspected.result.message, /林岑.*检查.*折叠的便签/);
  assert.equal(inspected.result.message.includes(detail), false);
  assert.equal(inspected.event.effects.discovery.detail, detail);
  assert.equal(observe(inspected.world, 'lin').story.knownClues[0].detail, detail);
  assert.equal(JSON.stringify(observe(inspected.world, 'xu')).includes(detail), false);
  const remote = applyGeneratedAction(world, { type: 'inspect', clueId: 'empty-folder' }, { actorId: 'lin' }).result;
  assert.equal(remote.reason, 'clue-not-present');
  assert.equal(remote.message.includes('蓝色文件夹'), false);
  const spoken = applyGeneratedAction(inspected.world, { type: 'speak', text: ' 我想在这里休息一会儿。 ' }, { actorId: 'lin', worldMinute: 7 });
  assert.match(spoken.result.message, /林岑.*发言/);
  assert.equal(spoken.event.effects.statement.text, '我想在这里休息一会儿。');
  assert.deepEqual(spoken.event.effects.statement.listeners, ['xu']);
  assert.equal(spoken.event.effects.statement.minute, 7);
  assert.equal(observe(spoken.world, 'wen').story.statements.length, 0);
  const system = buildResidentMessages({ world, worldMinute: 0 }, 'lin', createLedgers(world))[0].content;
  assert.equal(system.includes('封闭山庄'), false);
  assert.match(system, /资源会随世界时间/);
  assert.match(system, /近期 memories.*outcome/);
});

// The old fixture's complete observation, including property order and lack of
// availability fields. This is also the payload in the synthetic legacy save.
const legacyObservation = {
  profile: 'generated-world', worldMinute: 0, actorId: 'mira', name: '米拉', role: '观星员', goal: '在能量耗尽前留下星图。',
  background: '曾在雾中迷航，依靠星图找到归途。', location: 'observatory', fatigue: 15,
  environment: { weather: '海雾与持续海风' },
  places: [
    { id: 'observatory', name: '潮汐观测台', description: '记录海雾中的星光。', position: [-4, 0.8, 3] },
    { id: 'harbor', name: '风帆码头', description: '海风驱动蓄能装置。', position: [4, 0.8, 3] },
  ],
  resources: [
    { id: 'charge', name: '风能电池', unit: '格', location: 'observatory', quantity: 5, capacity: 12 },
    { id: 'charts', name: '星图', unit: '张', location: 'observatory', quantity: 0, capacity: 20 },
  ],
  availableActions: [{ id: 'record-chart', name: '记录星图', description: '消耗三格电能绘制一张星图。', location: 'observatory', costs: [{ resourceId: 'charge', amount: 3 }], gains: [{ resourceId: 'charts', amount: 1 }] }],
  neighbors: [],
};

test('actions without requires retain the exact old serialized observation', () => {
  const { world } = createGeneratedFixture();
  assert.equal(JSON.stringify(observe(world)), JSON.stringify(legacyObservation));
  world.processes[0].when = [condition('seals', 'gte', 2)];
  assert.equal(JSON.stringify(observe(world)), JSON.stringify(legacyObservation));
  assert.equal(verifyDecision(propose(legacyObservation, perform('record-chart')), legacyObservation).ok, true);
  world.actions[0].requires = [];
  assert.deepEqual(observe(world).availableActions[0], { ...legacyObservation.availableActions[0], requires: [], executable: true, unmetRequirements: [] });
});

function temporarySave(run) {
  const base = resolve('.tmp/prototype');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'conditional-test-'));
  try { run(join(directory, 'synthetic-state.json')); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}

test('legacy synthetic save and memory restore through the existing strict validator', () => temporarySave((path) => {
  const definition = createGeneratedFixture();
  const sim = new CampSimulation({ world: definition.world });
  const before = sim.snapshot();
  sim.act(perform('record-chart'), actor);
  sim.advanceWorld(1); sim.pause();
  const saved = sim.snapshot();
  const after = structuredClone(legacyObservation);
  after.worldMinute = 1; after.fatigue = 17;
  after.resources[0].quantity = 4; after.resources[1].quantity = 1;
  const entry = { id: 'legacy-memory', actorId: 'mira', observation: structuredClone(legacyObservation),
    decision: propose(legacyObservation, perform('record-chart')), outcome: { ok: true, reason: null, message: '行动已完成。' }, after,
    source: { instanceId: before.instanceId, fromRevision: 0, toRevision: 2, fromMinute: 0, toMinute: 1 } };
  const ledgers = createLedgers(definition.world);
  ledgers.mira.entries.push(entry); ledgers.mira.lastDecision = entry;
  for (const frame of saved.history) {
    if (frame.event.type === 'continuous_step') delete frame.event.processes;
    if (frame.event.result) frame.event.result.message = '行动已完成。';
  }
  for (const audit of saved.audit) if (audit.kind === 'action') audit.message = '行动已完成。';
  saved.experience = { ledgers, autonomy: { enabled: false, waitingReason: null, nextActorId: 'mira' },
    genesis: { initialMemories: definition.initialMemories, scene: definition.scene },
    scene: { document: definition.scene, revision: 0, draft: null, lastResult: null } };
  writeFileSync(path, `${JSON.stringify(saved)}\n`);
  assert.deepEqual(CampSimulation.load(path).snapshot(), saved);
  let experience;
  try {
    experience = createCampExperience({ stateFile: path, configLoader: () => { throw new Error('No config/model calls in this test.'); }, fetchImpl: () => { throw new Error('No network in this test.'); } });
    const restored = experience.state();
    assert.equal(restored.autonomy.waitingReason, null);
    assert.equal(restored.actors.mira.totalMemories, 1);
    assert.deepEqual(restored.actors.mira.entries[0], entry);
    assert.deepEqual(restored.observations.mira, after);
  } finally { experience?.close(); }
}));

test('conditional worlds round-trip their rules and process evidence without offline advancement', () => temporarySave((path) => {
  const sim = new CampSimulation({ world: conditionalFixture().world });
  sim.act(perform('open-gate'), actor); sim.advanceWorld(1);
  sim.save(path);
  const loaded = CampSimulation.load(path);
  assert.deepEqual(loaded.snapshot(), sim.snapshot());
  assert.equal(loaded.view(0).worldMinute, 1);
  assert.equal(loaded.view(1).history.at(-1).event.processes[0].active, true);
  assert.equal(loaded.act(perform('close-gate'), actor).ok, true);
  loaded.advanceWorld(1);
  assert.equal(resource(loaded.view(0).world, 'charge').quantity, 7);
}));
