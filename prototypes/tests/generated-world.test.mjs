import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CampSimulation, createCampWorld, validateWorld, step } from '../core.mjs';
import { createGeneratedFixture, validateWorldDefinition, validateGeneratedWorld, GENERATED_LIMITS } from '../world-definition.mjs';
import { observeResident, verifyDecision, createLedgers, ledgerView, buildResidentMessages } from '../actor.mjs';

const actor = { actorId: 'mira', source: 'resident', decisionId: 'test-decision' };
const resource = (sim, id) => sim.view(0).world.resources.find((r) => r.id === id).quantity;
const decision = (observation, action) => ({ observationMinute: observation.worldMinute, action, reason: '根据眼前条件尝试。', memory: '先观察结果再判断。' });
function greenhouse() {
  return {
    schemaVersion: 1,
    world: {
      profile: 'generated-world', title: '沙洲育苗园', description: '在沙洲上用蓄水培育幼苗。', environment: { weather: '晴热干燥' },
      places: [
        { id: 'nursery', name: '育苗台', description: '在此培育幼苗。', position: [0, 0.8, 3], visibleFrom: ['well'] },
        { id: 'well', name: '渗水井', description: '潮水渗入的浅井。', position: [4, 0.8, 3], visibleFrom: ['nursery'] },
      ],
      actors: [{ id: 'aya', name: '阿芽', role: '育苗员', goal: '让幼苗渡过旱季。', background: '从故乡带来最后一袋种子。', location: 'nursery', fatigue: 30 }],
      resources: [
        { id: 'water', name: '育苗用水', unit: '升', location: 'nursery', quantity: 6, capacity: 10 },
        { id: 'seeds', name: '种子', unit: '粒', location: 'nursery', quantity: 4, capacity: 8 },
        { id: 'sprouts', name: '幼苗', unit: '株', location: 'nursery', quantity: 0, capacity: 6 },
        { id: 'well-water', name: '井水', unit: '升', location: 'well', quantity: 2, capacity: 5 },
      ],
      processes: [
        { id: 'evaporation', description: '育苗用水每分钟蒸发半升。', resourceId: 'water', deltaPerMinute: -0.5 },
        { id: 'seepage', description: '井水每分钟增加四分之一升。', resourceId: 'well-water', deltaPerMinute: 0.25 },
      ],
      actions: [
        { id: 'plant', name: '育苗', description: '一粒种子和两升水培育一株幼苗。', location: 'nursery', costs: [{ resourceId: 'water', amount: 2 }, { resourceId: 'seeds', amount: 1 }], gains: [{ resourceId: 'sprouts', amount: 1 }] },
        { id: 'clear-well', name: '清理井口', description: '清理井口，增加半升井水。', location: 'well', costs: [], gains: [{ resourceId: 'well-water', amount: 0.5 }] },
      ],
    },
    scene: {
      schemaVersion: 1, profile: 'world', id: 'sandbar-nursery', title: '沙洲育苗园', style: { palette: 'wetland-sage', voxelUnit: 0.5, seed: 201 },
      regions: [
        { id: 'sea', kind: 'water', center: [0, 0], size: [100, 100], elevation: -0.4 },
        { id: 'sandbar', kind: 'island', center: [0, 0], radius: 10, elevation: 0.8, irregularity: 0 },
      ],
      objects: [
        { id: 'aya', name: '阿芽', kind: 'character', position: [0, 0.8, 3] },
        { id: 'well-path', kind: 'path', points: [[0, 3], [4, 3]], width: 1 },
      ],
    },
    initialMemories: [{ actorId: 'aya', text: '上次清井后渗水增加了。' }],
  };
}

test('two unrelated themes define independent actors, places, resources, rates, actions and scenes', () => {
  const star = createGeneratedFixture(); const garden = greenhouse();
  assert.deepEqual(validateWorldDefinition(star), []);
  assert.deepEqual(validateWorldDefinition(garden), []);
  assert.notDeepEqual(star.world.actors.map((a) => a.id), garden.world.actors.map((a) => a.id));
  assert.deepEqual([star.world.actors.length, star.world.places.length, star.world.resources.length, star.world.processes.length, star.world.actions.length], [2, 3, 3, 1, 1]);
  assert.deepEqual([garden.world.actors.length, garden.world.places.length, garden.world.resources.length, garden.world.processes.length, garden.world.actions.length], [1, 2, 4, 2, 2]);
  const a = new CampSimulation({ world: star.world }); const b = new CampSimulation({ world: garden.world });
  assert.equal(a.snapshot().scenario, 'generated-world-v1');
  a.advanceWorld(2); b.advanceWorld(2);
  assert.equal(resource(a, 'charge'), 9); assert.equal(resource(b, 'water'), 5); assert.equal(resource(b, 'well-water'), 2.5);
  assert.equal(b.act({ type: 'perform', actionId: 'plant' }, { actorId: 'aya' }).ok, true);
  assert.equal(resource(b, 'water'), 3); assert.equal(resource(b, 'sprouts'), 1); assert.equal(resource(b, 'seeds'), 3);
  assert.equal(resource(a, 'charts'), 0);
});

test('a world definition with one land region and no water is valid', () => {
  const definition = greenhouse();
  definition.scene.regions = definition.scene.regions.filter((region) => region.kind !== 'water');
  assert.equal(definition.scene.regions.length, 1);
  assert.deepEqual(validateWorldDefinition(definition), []);
});

test('validator handles malformed JSON data without throwing and reports exact unknown paths', () => {
  for (const value of [null, undefined, false, [], 1, 'broken {', {}, { world: null }, { world: { actors: [null] }, scene: null }]) {
    assert.doesNotThrow(() => validateWorldDefinition(value)); assert.ok(validateWorldDefinition(value).length);
  }
  for (const change of [
    (d) => { d.script = 'throw new Error()'; },
    (d) => { d.world.laws = [{ javascript: 'fetch()' }]; },
    (d) => { d.world.processes[0].script = 'process.exit()'; },
    (d) => { d.world.environment.temperature = 9; },
    (d) => { d.world.actions[0].gains[0].callback = 'eval()'; },
    (d) => { d.world.actors[0].private = { secret: 'hidden' }; },
    (d) => { d.initialMemories[0].source = 'pretend'; },
    (d) => { d.scene.objects[0].script = 'execute()'; },
    (d) => { d.scene.objects[0].transform.rotationY = 3; },
    (d) => { d.scene.style.script = 'execute()'; },
  ]) {
    const d = createGeneratedFixture(); change(d);
    const errors = validateWorldDefinition(d);
    assert.ok(errors.some((e) => e.code === 'unknown-field'));
    assert.ok(errors.every((e) => typeof e.message === 'string'));
  }
});

test('references, duplicate ids, physical bounds and character identities are enforced', () => {
  const changes = [
    (d) => { d.world.actors[0].location = 'missing'; },
    (d) => { d.world.places[0].visibleFrom.push('missing'); },
    (d) => { d.world.processes[0].resourceId = 'missing'; },
    (d) => { d.world.actions[0].costs[0].resourceId = 'missing'; },
    (d) => { d.world.actions[0].location = 'missing'; },
    (d) => { d.initialMemories[0].actorId = 'missing'; },
    (d) => { d.world.resources[0].quantity = -1; },
    (d) => { d.world.resources[0].quantity = 13; },
    (d) => { d.world.resources[0].capacity = Infinity; },
    (d) => { d.world.processes[0].deltaPerMinute = NaN; },
    (d) => { d.world.processes[0].deltaPerMinute = GENERATED_LIMITS.rate + 1; },
    (d) => { d.world.actions[0].costs[0].amount = 0; },
    (d) => { d.world.actions[0].costs.push({ ...d.world.actions[0].costs[0] }); },
    (d) => { d.world.actors[1].id = d.world.actors[0].id; },
    (d) => { d.world.actors[0].fatigue = 101; },
    (d) => { d.scene.objects.find((o) => o.id === 'mira').position[0] += 0.1; },
    (d) => { d.scene.objects.find((o) => o.id === 'mira').id = 'unbound'; },
  ];
  for (const change of changes) { const d = createGeneratedFixture(); change(d); assert.ok(validateWorldDefinition(d).length); }
});

test('one through eight actors, empty optional mechanics, no hardcoded slots', () => {
  const d = greenhouse(); d.world.resources = []; d.world.actions = []; d.world.processes = [];
  assert.deepEqual(validateWorldDefinition(d), []);
  const template = d.world.actors[0]; const visual = d.scene.objects[0];
  for (let i = 1; i < 8; i++) {
    d.world.actors.push({ ...template, id: `resident-${i}`, name: `居民${i}` });
    d.scene.objects.push({ ...visual, id: `resident-${i}`, name: `居民${i}` });
  }
  assert.deepEqual(validateWorldDefinition(d), []);
  d.world.actors.push({ ...template, id: 'ninth' }); assert.ok(validateWorldDefinition(d).length);
  d.world.actors = []; assert.ok(validateWorldDefinition(d).length);
});

test('deterministic minute settlement clamps capacities and drains, records conservation', () => {
  const d = createGeneratedFixture(); d.world.processes.push({ id: 'archive-use', description: '封签消耗', resourceId: 'seals', deltaPerMinute: -5 });
  const a = new CampSimulation({ world: d.world }); const b = a.copy();
  const before = structuredClone(d.world); const one = step(d.world);
  assert.deepEqual(d.world, before);
  assert.equal(one.world.resources.find((r) => r.id === 'seals').quantity, 0);
  assert.deepEqual(one.event.settlements.find((r) => r.resourceId === 'seals'), { resourceId: 'seals', before: 3, requestedDelta: -5, appliedDelta: -3, after: 0, overflow: 0, unmetDemand: 2 });
  a.advanceWorld(7); for (let i = 0; i < 7; i++) b.advanceWorld(1);
  assert.deepEqual(a.snapshot().history, b.snapshot().history); assert.equal(resource(a, 'charge'), 12);
  for (const entry of a.snapshot().history.slice(1)) for (const s of entry.event.settlements) {
    assert.equal(s.after - s.before, s.appliedDelta);
    assert.equal(s.requestedDelta, s.appliedDelta + s.overflow - s.unmetDemand);
  }
});

test('simultaneous rates are deterministic independent of process collection order', () => {
  const d = createGeneratedFixture(); d.world.processes.push({ id: 'lamp', description: '照明耗能', resourceId: 'charge', deltaPerMinute: -1.5 });
  const a = new CampSimulation({ world: d.world }); d.world.processes.reverse(); const b = new CampSimulation({ world: d.world });
  a.advanceWorld(1); b.advanceWorld(1);
  assert.equal(resource(a, 'charge'), 5.5); assert.equal(resource(b, 'charge'), 5.5);
  assert.deepEqual(a.snapshot().history.at(-1).event, b.snapshot().history.at(-1).event);
});

test('successful actions settle costs before gains, move after validation and do not advance time', () => {
  const sim = new CampSimulation({ world: createGeneratedFixture().world });
  assert.equal(sim.act({ type: 'moveTo', location: 'harbor' }, actor).ok, true);
  assert.equal(sim.act({ type: 'perform', actionId: 'record-chart' }, actor).ok, true);
  assert.equal(resource(sim, 'charge'), 2); assert.equal(resource(sim, 'charts'), 1);
  assert.equal(sim.snapshot().world.actors[0].location, 'observatory'); assert.equal(sim.snapshot().world.actors[0].fatigue, 18);
  assert.equal(sim.snapshot().worldMinute, 0);
  sim.advanceWorld(1); assert.equal(resource(sim, 'charge'), 4); assert.equal(sim.snapshot().worldMinute, 1);
  sim.act({ type: 'rest' }, actor); assert.equal(sim.snapshot().world.actors[0].fatigue, 6);
  const before = sim.snapshot().world; sim.act({ type: 'observe' }, actor); assert.deepEqual(sim.snapshot().world, before);
});

test('insufficient costs and full gains reject atomically without movement, audit or fatigue mutation', () => {
  for (const kind of ['cost', 'capacity', 'late-cost']) {
    const d = createGeneratedFixture();
    if (kind === 'cost') d.world.resources[0].quantity = 1;
    if (kind === 'capacity') d.world.resources[1].quantity = d.world.resources[1].capacity;
    if (kind === 'late-cost') d.world.actions[0].costs.push({ resourceId: 'charts', amount: 1 });
    const sim = new CampSimulation({ world: d.world }); sim.act({ type: 'moveTo', location: 'harbor' }, actor);
    const before = sim.snapshot(); const result = sim.act({ type: 'perform', actionId: 'record-chart' }, actor);
    assert.equal(result.ok, false); assert.deepEqual(sim.snapshot(), before);
  }
});

test('a gain cannot fund its own missing cost; a cost can make room for same-resource gain', () => {
  const d = createGeneratedFixture(); const action = d.world.actions[0];
  action.costs = [{ resourceId: 'charge', amount: 6 }]; action.gains = [{ resourceId: 'charge', amount: 7 }];
  const sim = new CampSimulation({ world: d.world }); const before = sim.snapshot();
  assert.equal(sim.act({ type: 'perform', actionId: action.id }, actor).reason, 'insufficient-resource'); assert.deepEqual(sim.snapshot(), before);
  d.world.resources[0].quantity = 12; action.costs[0].amount = 3; action.gains[0].amount = 2;
  const full = new CampSimulation({ world: d.world }); assert.equal(full.act({ type: 'perform', actionId: action.id }, actor).ok, true); assert.equal(resource(full, 'charge'), 11);
});

test('generic author and resident reject legacy campwork and unsupported fields/references without mutation', () => {
  const sim = new CampSimulation({ world: createGeneratedFixture().world }); const before = sim.snapshot();
  for (const action of [{ type: 'waterPlants', liters: 1 }, { type: 'setWalking', walking: false }, { type: 'setWeather', mode: 'rain' }, { type: 'moveTo', location: 'missing' }, { type: 'perform', actionId: 'missing' }, { type: 'perform', actionId: 'record-chart', script: 'x' }, { type: 'rest', actorId: 'sen' }, null]) {
    assert.equal(sim.act(action, actor).ok, false); assert.deepEqual(sim.snapshot(), before);
    assert.equal(sim.act(action).ok, false); assert.deepEqual(sim.snapshot(), before);
  }
});

test('observations are direct, directional and exclude hidden resources and other private facts', () => {
  const d = createGeneratedFixture(); const sim = new CampSimulation({ world: d.world }); const snapshot = sim.snapshot();
  snapshot.world.unknown = 'WORLD-SECRET'; snapshot.world.actors[1].privateMemory = 'OTHER-MEMORY';
  snapshot.world.resources[0].unknown = 'RESOURCE-SECRET'; snapshot.world.places[0].unknown = 'PLACE-SECRET';
  snapshot.world.actions[0].unknown = 'ACTION-SECRET';
  const obs = observeResident(snapshot, 'mira'); const data = JSON.stringify(obs);
  assert.equal(obs.profile, 'generated-world'); assert.equal(obs.background, d.world.actors[0].background);
  assert.deepEqual(obs.places.map((p) => p.id), ['observatory', 'harbor']); assert.deepEqual(obs.resources.map((r) => r.id), ['charge', 'charts']);
  assert.equal(obs.neighbors.length, 0);
  for (const secret of [d.world.actors[1].goal, d.world.actors[1].background, 'WORLD-SECRET', 'OTHER-MEMORY', 'RESOURCE-SECRET', 'PLACE-SECRET', 'ACTION-SECRET', 'seals']) assert.equal(data.includes(secret), false);
  snapshot.world.places[2].visibleFrom = ['harbor'];
  assert.equal(observeResident(snapshot, 'mira').places.some((p) => p.id === 'archive'), false);
  snapshot.world.places[2].visibleFrom = ['observatory'];
  const visible = observeResident(snapshot, 'mira'); assert.equal(visible.neighbors[0].id, 'sen');
  assert.deepEqual(Object.keys(visible.neighbors[0]).sort(), ['id', 'name', 'role', 'location'].sort());
  assert.equal(JSON.stringify(visible.neighbors).includes(d.world.actors[1].background), false);
});

test('decisions accept only generated actions grounded in the visible observation and current minute', () => {
  const obs = observeResident(new CampSimulation({ world: createGeneratedFixture().world }).snapshot(), 'mira');
  for (const action of [{ type: 'moveTo', location: 'harbor' }, { type: 'perform', actionId: 'record-chart' }, { type: 'rest' }, { type: 'observe' }]) assert.equal(verifyDecision(decision(obs, action), obs).ok, true);
  for (const action of [{ type: 'moveTo', location: 'archive' }, { type: 'perform', actionId: 'invisible' }, { type: 'waterPlants', liters: 1 }, { type: 'perform', actionId: 'record-chart', actorId: 'sen' }]) assert.equal(verifyDecision(decision(obs, action), obs).ok, false);
  const stale = decision(obs, { type: 'rest' }); stale.observationMinute++; assert.equal(verifyDecision(stale, obs).ok, false);
});

test('genesis stays outside ledgers; messages include only own background, seeds and experiences', () => {
  const d = createGeneratedFixture(); const sim = new CampSimulation({ world: d.world }); const snapshot = sim.snapshot();
  const ledgers = createLedgers(snapshot.world); assert.deepEqual(ledgerView(ledgers).mira, { entries: [], totalMemories: 0, lastDecision: null });
  const own = observeResident(snapshot, 'mira'); const other = observeResident(snapshot, 'sen');
  const entry = { id: 'own', actorId: 'mira', observation: own, after: own, decision: decision(own, { type: 'observe' }), outcome: { ok: true }, source: { toMinute: 0 } };
  ledgers.mira.entries.push(entry, { ...entry, id: 'other', actorId: 'sen', observation: other, after: other }, { ...entry, id: 'future', source: { toMinute: 99 } });
  const messages = buildResidentMessages(snapshot, 'mira', ledgers, { initialMemories: d.initialMemories });
  const input = JSON.parse(messages.at(-1).content);
  assert.deepEqual(input.initialMemories, [{ ...d.initialMemories[0], source: 'genesis' }]);
  assert.equal(input.memories.length, 1); assert.equal(input.memories[0].id, 'own');
  assert.equal(input.observation.background, d.world.actors[0].background);
  assert.equal(JSON.stringify(messages).includes(d.initialMemories[1].text), false);
  assert.equal(JSON.stringify(messages).includes(d.world.actors[1].background), false);
  assert.deepEqual(JSON.parse(buildResidentMessages(snapshot, 'mira', ledgers).at(-1).content).initialMemories, []);
  assert.equal(ledgers.mira.entries.length, 3);
});

test('copy/save/load preserve generic history, fractional clock, scene and genesis without offline time', () => {
  const base = resolve('.tmp/prototype'); mkdirSync(base, { recursive: true }); const dir = mkdtempSync(join(base, 'generated-test-'));
  try {
    const d = createGeneratedFixture(); const sim = new CampSimulation({ world: d.world, speed: 60 });
    sim.act({ type: 'perform', actionId: 'record-chart' }, actor); sim.sampleWall(100); sim.sampleWall(600);
    const copy = sim.copy(); copy.advanceWorld(2); assert.equal(sim.snapshot().worldMinute, 0);
    sim.advanceWorld(3); sim.pause();
    const experience = { genesis: { initialMemories: d.initialMemories }, ledgers: createLedgers(d.world), scene: d.scene };
    const file = join(dir, 'state.json'); sim.save(file, { experience }); const loaded = CampSimulation.load(file);
    assert.deepEqual(loaded.snapshot(), sim.snapshot()); assert.equal(loaded.snapshot().fractionalMinutes, 0.5);
    loaded.resume(); assert.equal(loaded.sampleWall(1e10).advancedMinutes, 0); assert.equal(loaded.snapshot().worldMinute, 3);
    const data = JSON.parse(readFileSync(file, 'utf8')); data.scenario = 'beast-camp-v1'; writeFileSync(file, JSON.stringify(data));
    assert.throws(() => CampSimulation.load(file), /scenario/);
    data.scenario = 'generated-world-v1'; data.history[0].world = createCampWorld(); writeFileSync(file, JSON.stringify(data));
    assert.throws(() => CampSimulation.load(file), /scenario/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy camp factory, decisions, observations, clock and scenario remain compatible', () => {
  const sim = new CampSimulation(); assert.equal(sim.snapshot().scenario, 'beast-camp-v1'); validateWorld(createCampWorld());
  const obs = observeResident(sim.snapshot(), 'ihe'); assert.equal(obs.waterL, 12);
  assert.equal(verifyDecision(decision(obs, { type: 'secureCargo' }), obs).ok, true);
  assert.equal(sim.act({ type: 'secureCargo' }, { actorId: 'ihe', source: 'resident' }).ok, true);
  assert.equal(sim.view(0).world.camp.cargoSecured, true); sim.advanceWorld(1); assert.equal(sim.view(0).worldMinute, 1);
  const messages = buildResidentMessages(sim.snapshot(), 'ihe', createLedgers(sim.view(0).world), { initialMemories: [{ actorId: 'ihe', text: 'generic seed' }] });
  assert.equal(Object.hasOwn(JSON.parse(messages.at(-1).content), 'initialMemories'), false);
  assert.deepEqual(validateGeneratedWorld(greenhouse().world), []);
});
