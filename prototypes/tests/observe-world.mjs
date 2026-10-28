import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { CampSimulation, createCampWorld } from '../core.mjs';

// Offline, small behavioral observations. No server, configuration loader or model imports.
// Run: node prototypes/tests/observe-world.mjs
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(root, '.tmp/prototype');
mkdirSync(output, { recursive: true });
const observations = [];
const trace = [];
let current;
const context = { actorId: 'ihe', source: 'resident', decisionId: 'observation-1' };
const worldOf = (sim) => sim.view(0).world;
const person = (snapshot, actorId = 'ihe') => ({ worldMinute: snapshot.worldMinute, ...snapshot.world.actors.find((a) => a.id === actorId) });

function check(label, actual, expected = true) {
  const ok = isDeepStrictEqual(actual, expected);
  current.checks.push({ label, ok, actual, expected });
  return ok;
}

function near(label, actual, expected) {
  const tolerance = 1e-9;
  current.checks.push({ label, ok: Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, actual, expected, tolerance });
}

function throws(label, fn) {
  let rejected = false;
  try { fn(); } catch { rejected = true; }
  check(label, rejected);
}

function observe(name, fn) {
  current = { name, checks: [], evidence: {} };
  observations.push(current);
  try { fn(); } catch (error) { current.checks.push({ label: 'observation completed', ok: false, message: error.stack }); }
}

function rememberTrace(sim, scenario) {
  for (const entry of sim.snapshot().history) trace.push({ scenario, ...entry });
}

observe('initial contract and independent worlds', () => {
  const world = createCampWorld();
  const sim = new CampSimulation();
  const state = sim.snapshot();
  check('factory shape', world, {
    beast: { name: '苔背', walking: true, distanceKm: 0, phase: 0, rollDeg: 0, region: '雾杉谷' },
    weather: { mode: 'drizzle', rainMmPerMinute: 0.25, windKph: 12, temperatureC: 18 },
    camp: { canopyOpen: false, collectorOpen: true, cargoSecured: false, waterL: 12, waterCapacityL: 40, deckWetness: 24, deckIntegrity: 88, soilMoisture: 42, plantHealth: 82, timber: 4 },
    actors: [
      { id: 'ihe', name: '伊禾', role: '修补匠', goal: '照料营地，让住处安全舒适。', location: 'terrace', fatigue: 18 },
      { id: 'loran', name: '洛岚', role: '旅人', goal: '寻找适合落脚的地方，同时照料眼下的住处。', location: 'lookout', fatigue: 12 },
    ],
  });
  check('initial state fields', Object.keys(state).sort(), ['schemaVersion', 'scenario', 'instanceId', 'worldMinute', 'revision', 'world', 'paused', 'waiting', 'speed', 'fractionalMinutes', 'history', 'audit'].sort());
  check('initial state values', [state.schemaVersion, state.scenario, state.worldMinute, state.revision, state.paused, state.waiting, state.speed, state.fractionalMinutes], [1, 'beast-camp-v1', 0, 0, false, null, 24, 0]);
  check('UUID identity', /^[0-9a-f-]{36}$/.test(state.instanceId));
  check('distinct new identities', state.instanceId !== new CampSimulation().view().instanceId);
  check('view includes identity', sim.view().instanceId, state.instanceId);
  check('origin is exact', state.history, [{ revision: 0, worldMinute: 0, event: { type: 'origin' }, world }]);
  world.camp.waterL = 0;
  check('factory worlds are independent', createCampWorld().camp.waterL, 12);
  check('simulation owns initial world', worldOf(sim).camp.waterL, 12);
});

observe('rain collector open versus closed', () => {
  const open = new CampSimulation();
  open.act({ type: 'setWalking', walking: false });
  const closed = open.copy();
  closed.act({ type: 'setCollector', open: false });
  open.advanceWorld(30); closed.advanceWorld(30);
  near('open gains six liters in thirty minutes', worldOf(open).camp.waterL, 18);
  near('closed gains no water', worldOf(closed).camp.waterL, 12);
  for (const sim of [open, closed]) {
    const history = sim.snapshot().history;
    check('tank mass balance at every minute', history.every((entry, i) => entry.event.type !== 'continuous_step'
      || Math.abs(entry.world.camp.waterL - (history[i - 1].world.camp.waterL + entry.event.collectedL - entry.event.overflowL - entry.event.spilledL)) < 1e-9));
  }
  const fullWorld = createCampWorld(); fullWorld.camp.waterL = 39.9; fullWorld.beast.walking = false;
  const full = new CampSimulation({ world: fullWorld }); full.advanceWorld(1);
  near('capacity respected', worldOf(full).camp.waterL, 40);
  near('overflow explicitly lost', full.snapshot().history.at(-1).event.overflowL, 0.1);
  current.evidence = { minutes: 30, openL: worldOf(open).camp.waterL, closedL: worldOf(closed).camp.waterL };
  rememberTrace(open, current.name);
});

observe('secured tank versus motion spills', () => {
  const loose = new CampSimulation(); loose.act({ type: 'setWeather', mode: 'clear' });
  const secured = loose.copy(); secured.act({ type: 'secureCargo' });
  loose.advanceWorld(60); secured.advanceWorld(60);
  near('secured tank retains all water', worldOf(secured).camp.waterL, 12);
  check('unsecured tank spills', worldOf(loose).camp.waterL < 12);
  const steps = loose.snapshot().history.filter((entry) => entry.event.type === 'continuous_step');
  near('all missing water is recorded spill', 12 - worldOf(loose).camp.waterL, steps.reduce((sum, entry) => sum + entry.event.spilledL, 0));
  near('first spill follows sine formula', steps[0].event.spilledL, 12 * Math.abs(Math.sin(0.65)) * 0.006);
  near('walking distance', worldOf(loose).beast.distanceKm, 2.4);
  near('walking phase', worldOf(loose).beast.phase, 39);
  near('roll uses current phase', worldOf(loose).beast.rollDeg, 7 * Math.sin(worldOf(loose).beast.phase));
  const before = worldOf(loose).beast;
  loose.act({ type: 'setWalking', walking: false }); loose.advanceWorld(5);
  check('stopping freezes phase distance and roll', worldOf(loose).beast, { ...before, walking: false });
  near('stopped tank no longer spills', worldOf(loose).camp.waterL, steps.at(-1).world.camp.waterL);
  const regions = new CampSimulation();
  regions.advanceWorld(80); check('wind ridge', worldOf(regions).beast.region, '风脊');
  regions.advanceWorld(75); check('shallow stream', worldOf(regions).beast.region, '浅溪');
  regions.advanceWorld(75); check('region loop', worldOf(regions).beast.region, '雾杉谷');
  current.evidence = { minutes: 60, looseL: steps.at(-1).world.camp.waterL, securedL: worldOf(secured).camp.waterL, spilledL: steps.reduce((sum, entry) => sum + entry.event.spilledL, 0) };
  rememberTrace(secured, current.name);
});

observe('canopy exposure sunshine and plant water budget', () => {
  const exposed = new CampSimulation(); exposed.act({ type: 'setWalking', walking: false });
  const sheltered = exposed.copy(); sheltered.act({ type: 'setCanopy', open: true });
  exposed.advanceWorld(30); sheltered.advanceWorld(30);
  near('exposed wetness', worldOf(exposed).camp.deckWetness, 65.4);
  near('sheltered wetness', worldOf(sheltered).camp.deckWetness, 27.15);
  near('exposed soil', worldOf(exposed).camp.soilMoisture, 68.04);
  near('sheltered soil', worldOf(sheltered).camp.soilMoisture, 42.54);
  check('canopy does not cover separate collector', worldOf(exposed).camp.waterL, worldOf(sheltered).camp.waterL);
  const sunny = new CampSimulation(); sunny.act({ type: 'setWalking', walking: false }); sunny.act({ type: 'setWeather', mode: 'clear' });
  sunny.advanceWorld(30);
  near('sun dries deck', worldOf(sunny).camp.deckWetness, 0);
  near('plants and soil consume six moisture points', worldOf(sunny).camp.soilMoisture, 36);
  near('plants do not silently irrigate from tank', worldOf(sunny).camp.waterL, 12);
  const history = exposed.snapshot().history;
  check('soil mass balance at every minute', history.every((entry, i) => entry.event.type !== 'continuous_step'
    || Math.abs(entry.world.camp.soilMoisture / 8 - (history[i - 1].world.camp.soilMoisture / 8 + entry.event.gardenRainL - entry.event.soilOverflowL - entry.event.evaporationL - entry.event.plantUseL)) < 1e-9));
  const dryWorld = createCampWorld(); dryWorld.camp.soilMoisture = 0;
  const dry = new CampSimulation({ world: dryWorld }); dry.act({ type: 'setWeather', mode: 'clear' }); dry.advanceWorld(30);
  near('empty soil stays nonnegative', worldOf(dry).camp.soilMoisture, 0);
  near('dry plants lose health', worldOf(dry).camp.plantHealth, 79.6);
  current.evidence = { minutes: 30, exposed: worldOf(exposed).camp, sheltered: worldOf(sheltered).camp, sunny: worldOf(sunny).camp, dry: worldOf(dry).camp };
});

observe('actor stations and action conservation', () => {
  const tasks = [
    [{ type: 'moveTo', location: 'tank' }, 'tank'], [{ type: 'waterPlants', liters: 2 }, 'garden'],
    [{ type: 'setCanopy', open: true }, 'terrace'], [{ type: 'setCollector', open: false }, 'tank'],
    [{ type: 'secureCargo' }, 'tank'], [{ type: 'repairDeck' }, 'terrace'],
    [{ type: 'rest' }, 'cabin'], [{ type: 'observe' }, 'lookout'],
  ];
  for (const [action, station] of tasks) {
    const sim = new CampSimulation();
    const before = sim.snapshot();
    check(`${action.type} accepted`, sim.act(action, context).ok);
    const after = sim.snapshot();
    check(`${action.type} station`, person(after).location, station);
    check(`${action.type} leaves other actor alone`, person(after, 'loran'), person(before, 'loran'));
    check(`${action.type} is one event at same minute`, [after.revision, after.worldMinute], [1, 0]);
    check(`${action.type} snapshot reflects exact committed world`, after.history.at(-1).world, after.world);
    check(`${action.type} source recorded`, [after.history.at(-1).event.actorId, after.history.at(-1).event.source, after.history.at(-1).event.decisionId], ['ihe', 'resident', 'observation-1']);
    if (action.type === 'waterPlants') {
      check('two liters deducted', after.world.camp.waterL, 10);
      check('two liters become sixteen soil points', after.world.camp.soilMoisture, 58);
    }
    if (action.type === 'repairDeck') check('one timber restores twelve integrity', [after.world.camp.timber, after.world.camp.deckIntegrity], [3, 100]);
    if (action.type === 'rest') check('rest restores twelve fatigue', person(after).fatigue, 6);
  }
  for (const location of ['cabin', 'terrace', 'garden', 'tank', 'lookout']) {
    const sim = new CampSimulation(); check(`legal move ${location}`, sim.act({ type: 'moveTo', location }, context).ok);
  }
  const wet = createCampWorld(); wet.camp.soilMoisture = 99;
  const overflow = new CampSimulation({ world: wet }); overflow.act({ type: 'waterPlants', liters: 4 }, context);
  const event = overflow.snapshot().history.at(-1).event;
  check('watering clamps soil', worldOf(overflow).camp.soilMoisture, 100);
  near('watering runoff recorded', event.effects.runoffL, 3.875);
  near('watering mass balance', event.effects.withdrawnL, event.effects.absorbedL + event.effects.runoffL);
  const safe = new CampSimulation(); safe.act({ type: 'setWeather', mode: 'rain' });
  check('author rain preset', worldOf(safe).weather, { mode: 'rain', rainMmPerMinute: 0.8, windKph: 22, temperatureC: 15 });
  current.evidence = { stations: Object.fromEntries(tasks.map(([a, station]) => [a.type, station])), wateringOverflow: event.effects };
});

observe('failures never move or consume resources', () => {
  const failures = [];
  const reject = (sim, action, ctx, reason) => {
    const before = sim.snapshot(); const outcome = sim.act(action, ctx);
    check(`reject ${JSON.stringify(action)}: ${reason}`, outcome.reason, reason);
    check('failed action has no state changes, including position fatigue inventory history', sim.snapshot(), before);
    failures.push({ actorId: ctx?.actorId ?? null, action, outcome }); // Example runtime-owned failure memory.
  };
  const sim = new CampSimulation();
  reject(sim, { type: 'waterPlants', liters: 20 }, context, 'insufficient-water');
  const emptyWorld = createCampWorld(); emptyWorld.camp.timber = 0; emptyWorld.actors[0].location = 'garden';
  reject(new CampSimulation({ world: emptyWorld }), { type: 'repairDeck' }, context, 'insufficient-timber');
  const slipperyWorld = createCampWorld(); slipperyWorld.camp.deckWetness = 90; slipperyWorld.beast.phase = Math.PI / 2; slipperyWorld.beast.rollDeg = 7;
  const slippery = new CampSimulation({ world: slipperyWorld });
  for (const action of [{ type: 'moveTo', location: 'cabin' }, { type: 'waterPlants', liters: 1 }, { type: 'setCollector', open: false }, { type: 'secureCargo' }, { type: 'rest' }, { type: 'observe' }]) {
    reject(slippery, action, context, 'unsafe-movement');
  }
  check('can work at existing station despite unsafe movement', slippery.act({ type: 'repairDeck' }, context).ok);
  reject(slippery, { type: 'repairDeck' }, context, 'deck-intact');
  const malformed = [null, [], {}, { type: ['rest'] }, { type: 'fly' },
    { type: 'moveTo', location: 'moon' }, { type: 'moveTo' },
    { type: 'waterPlants', liters: 0 }, { type: 'waterPlants', liters: -1 }, { type: 'waterPlants', liters: '2' },
    { type: 'waterPlants', liters: NaN }, { type: 'waterPlants', liters: Infinity },
    { type: 'setCanopy', open: 1 }, { type: 'setCollector', open: 'false' },
    { type: 'secureCargo', extra: true }, { type: 'rest', fatigue: 0 }, { type: 'observe', payload: {} },
    { type: 'setWeather', mode: 'snow' }, { type: 'setWeather', mode: ['clear'] }, { type: 'setWalking', walking: 0 }];
  for (const action of malformed) {
    const before = sim.snapshot(); check(`malformed ${JSON.stringify(action)} rejected`, sim.act(action, context).ok, false);
    check('malformed action unchanged', sim.snapshot(), before);
  }
  reject(sim, { type: 'setWeather', mode: 'clear' }, context, 'author-only');
  reject(sim, { type: 'setWalking', walking: false }, { actorId: 'ihe' }, 'author-only');
  reject(sim, { type: 'observe' }, { actorId: 'ghost', source: 'resident' }, 'unknown-actor');
  reject(sim, { type: 'observe' }, { source: 'resident' }, 'actor-required');
  reject(sim, { type: 'moveTo', location: 'garden' }, {}, 'actor-required');
  reject(sim, { type: 'rest' }, {}, 'actor-required');
  current.evidence = { failureRecording: 'act only returns outcome; runtime stores actorId/action/outcome and then may advance one natural minute', failures };
});

observe('pause resume wait and 24x fractional clock', () => {
  const sim = new CampSimulation();
  check('first sample only anchors', sim.sampleWall(0).advancedMinutes, 0);
  sim.sampleWall(1000); near('one real second = .4 world minutes', sim.snapshot().fractionalMinutes, 0.4);
  sim.pause(); sim.sampleWall(50000); sim.sampleWall(90000);
  check('paused world does not advance', sim.view().worldMinute, 0);
  near('pause retains fraction', sim.snapshot().fractionalMinutes, 0.4);
  check('explicit advancement blocked while paused', sim.advanceWorld(1).reason, 'blocked');
  sim.resume(); check('resume anchors without catching up', sim.sampleWall(100000).advancedMinutes, 0);
  check('fraction plus next 1.5 real seconds gives one minute', sim.sampleWall(101500).advancedMinutes, 1);
  near('fraction consumed', sim.snapshot().fractionalMinutes, 0);
  sim.wait('actor:observation'); sim.sampleWall(900000);
  check('waiting blocks explicit advance', sim.advanceWorld(1).reason, 'blocked');
  sim.pause(); sim.retry();
  check('retry does not unpause', sim.view().paused);
  check('retry only clears wait', sim.view().waiting, null);
  sim.resume(); sim.sampleWall(1000000); check('one minute at 24x = 2500 ms', sim.sampleWall(1002500).advancedMinutes, 1);
  const before = sim.snapshot(); check('backwards clock rejected', sim.sampleWall(1002400).reason, 'clock-went-backwards'); check('backwards sample unchanged', sim.snapshot(), before);
  check('backwards sample did not move anchor', sim.sampleWall(1005000).advancedMinutes, 1);
  for (const speed of [1, 24, 60, 120, 0.5, 1440]) {
    sim.setSpeed(speed); check(`speed ${speed} stored`, sim.view().speed, speed);
    check('speed change discards old anchor', sim.sampleWall(2000000).advancedMinutes, 0);
    check('speed settles one minute at matching interval', sim.sampleWall(2000000 + 60000 / speed).advancedMinutes, 1);
  }
  for (const speed of [0, -1, 1441, NaN, Infinity, '24']) {
    const state = sim.snapshot(); throws(`invalid speed ${speed}`, () => sim.setSpeed(speed)); check('invalid speed unchanged', sim.snapshot(), state);
  }
  for (const duration of [-1, 0.1, 1441, NaN, Infinity, '1']) check(`invalid duration ${duration}`, sim.advanceWorld(duration).reason, 'invalid-duration');
  check('zero minutes accepted', sim.advanceWorld(0).advancedMinutes, 0);
  const gap = new CampSimulation(); gap.sampleWall(0);
  check('oversized wall gap rejected', gap.sampleWall(4000000).reason, 'clock-range-exceeded');
  check('oversized gap does not add history', gap.view().worldMinute, 0);
  check('oversized gap visibly waiting', gap.view().waiting, 'clock-range-exceeded');
  gap.retry(); check('retry establishes fresh anchor', gap.sampleWall(5000000).advancedMinutes, 0);
  check('invalid wall sample rejected', gap.sampleWall(NaN).reason, 'invalid-wall-time');
  current.evidence = { pausedWorldMinute: 0, resumedWorldMinuteAfter1500ms: 1, speedRange: '0 < speed <= 1440', maximumMinutesPerAdvanceOrSample: 1440 };
});

observe('copy isolation bounded views and deterministic stepping', () => {
  const sim = new CampSimulation(); sim.sampleWall(0); sim.sampleWall(1000);
  const copy = sim.copy(); check('copy has equal saved state', copy.snapshot(), sim.snapshot());
  check('copy retains world identity', copy.view().instanceId, sim.view().instanceId);
  check('copy has no wall anchor', copy.sampleWall(900000).advancedMinutes, 0);
  const before = sim.snapshot(); copy.act({ type: 'waterPlants', liters: 2 }, context); copy.advanceWorld(10);
  check('copy action and time do not mutate original', sim.snapshot(), before);
  const snapshot = sim.snapshot(); snapshot.world.camp.waterL = -100; snapshot.history[0].world.actors[0].fatigue = -100;
  const view = sim.view(); view.world.actors[0].location = 'moon';
  check('snapshots and views are isolated', sim.snapshot(), before);
  const batched = new CampSimulation(); const incremental = batched.copy();
  batched.advanceWorld(130); for (let i = 0; i < 130; i++) incremental.advanceWorld(1);
  check('same world independent of batching', worldOf(batched), worldOf(incremental));
  check('same event snapshots independent of batching', batched.snapshot().history, incremental.snapshot().history);
  check('default view retains recent 120', batched.view().history.length, 120);
  check('view slice uses full revisions', batched.view(2).history.map((e) => e.revision), [129, 130]);
  check('snapshot retains complete history', batched.snapshot().history.length, 131);
  check('zero limit is empty', batched.view(0).history, []);
  for (const limit of [-1, 1.5, '2']) throws('invalid view limit', () => sim.view(limit));
});

observe('atomic world plus experience and history restoration', () => {
  const path = resolve(output, 'world-with-experience.json');
  const sim = new CampSimulation(); const entries = [];
  for (const [index, action] of [{ type: 'waterPlants', liters: 2 }, { type: 'waterPlants', liters: 39 }].entries()) {
    const from = sim.snapshot(); const outcome = sim.act(action, { ...context, decisionId: `round-${index}` });
    sim.advanceWorld(1); const to = sim.snapshot();
    entries.push({ actorId: 'ihe', observation: person(from), action, outcome, after: person(to),
      source: { instanceId: from.instanceId, fromRevision: from.revision, toRevision: to.revision, fromMinute: from.worldMinute, toMinute: to.worldMinute } });
    check('each resident round advances exactly one minute', to.worldMinute - from.worldMinute, 1);
    check('success adds action + step, failure adds only step', to.revision - from.revision, outcome.ok ? 2 : 1);
  }
  sim.sampleWall(0); sim.sampleWall(1000);
  const experience = { ledgers: { ihe: { entries }, loran: { entries: [] } }, autonomy: { enabled: false } };
  check('save succeeds', sim.save(path, { experience }).ok);
  const loaded = CampSimulation.load(path);
  check('all state and experience round-trip', loaded.snapshot(), sim.snapshot());
  check('snapshot preserves experience', loaded.snapshot().experience, experience);
  check('view omits experience', Object.hasOwn(loaded.view(), 'experience'), false);
  check('view still includes identity', loaded.view().instanceId, sim.snapshot().instanceId);
  check('copy also preserves experience', loaded.copy().snapshot().experience, experience);
  check('origin retains fatigue before any natural step', person(loaded.snapshot().history[0]).fatigue, 18);
  const saved = loaded.snapshot();
  for (const entry of saved.experience.ledgers.ihe.entries) {
    const from = saved.history[entry.source.fromRevision]; const to = saved.history[entry.source.toRevision];
    check('source identity survives restore', entry.source.instanceId, saved.instanceId);
    check('fromRevision recovers exact observation including fatigue', person(from), entry.observation);
    check('toRevision recovers exact after observation including fatigue', person(to), entry.after);
    check('history range is exactly one natural minute', [from.worldMinute, to.worldMinute], [entry.source.fromMinute, entry.source.fromMinute + 1]);
  }
  experience.ledgers.ihe.entries[0].outcome.ok = false;
  check('caller cannot mutate saved memory', loaded.snapshot().experience.ledgers.ihe.entries[0].outcome.ok);
  check('reload does not add offline time', loaded.sampleWall(1e9).advancedMinutes, 0);
  near('reload preserves partial minute', loaded.snapshot().fractionalMinutes, 0.4);
  check('reload next sample completes fraction normally', loaded.sampleWall(1e9 + 1500).advancedMinutes, 1);
  check('save replaces existing world and experience together', loaded.save(path, { experience: { generation: 2 } }).ok);
  const replaced = CampSimulation.load(path);
  check('replacement includes current world and new memory', [replaced.view().worldMinute, replaced.snapshot().experience], [3, { generation: 2 }]);
  const previousText = readFileSync(path, 'utf8');
  throws('non-JSON experience rejected before replacing file', () => replaced.save(path, { experience: { tokens: 1n } }));
  check('failed save preserves previous file', readFileSync(path, 'utf8'), previousText);
  throws('lossy experience rejected', () => replaced.save(path, { experience: { missing: undefined } }));
  check('no temporary save files remain', readdirSync(output).filter((name) => name.endsWith('.tmp')), []);
  const badPath = resolve(output, 'invalid-save.json');
  for (const [label, mutate] of [
    ['version', (s) => { s.schemaVersion = 2; }], ['identity', (s) => { s.instanceId = 'bad'; }],
    ['negative inventory', (s) => { s.world.camp.waterL = -1; }], ['history mismatch', (s) => { s.history.at(-1).world.actors[0].fatigue = 99; }],
    ['fraction', (s) => { s.fractionalMinutes = 1; }], ['history minute', (s) => { s.history.at(-1).worldMinute++; }],
  ]) {
    const invalid = JSON.parse(previousText); mutate(invalid); writeFileSync(badPath, JSON.stringify(invalid));
    throws(`invalid save ${label}`, () => CampSimulation.load(badPath));
  }
  const savedEntries = saved.experience.ledgers.ihe.entries;
  current.evidence = { path, sourceRanges: savedEntries.map((e) => e.source), firstOutcome: savedEntries[0].outcome, secondOutcome: savedEntries[1].outcome,
    limitations: 'Same-directory rename is atomic visibility, not an fsync/crash-durability guarantee; history structure is validated, not cryptographically authenticated.' };
  rememberTrace(sim, current.name);
});

observe('one-day bounds and deterministic natural actor fatigue', () => {
  const sim = new CampSimulation(); check('maximum duration accepted', sim.advanceWorld(1440).advancedMinutes, 1440);
  const state = sim.snapshot();
  check('all minute snapshots remain within numeric budgets', state.history.every(({ world }) => {
    const c = world.camp;
    return c.waterL >= 0 && c.waterL <= 40 && c.timber >= 0
      && ['deckWetness', 'deckIntegrity', 'soilMoisture', 'plantHealth'].every((key) => c[key] >= 0 && c[key] <= 100)
      && Math.abs(world.beast.rollDeg) <= 7 && world.actors.every((a) => a.fatigue >= 0 && a.fatigue <= 100);
  }));
  check('every step has one world minute and one revision', state.history.every((entry, i) => entry.worldMinute === i && entry.revision === i));
  near('walking actor accumulates .02 fatigue per minute', person(state).fatigue, 46.8);
  check('latest history fatigue equals visible world fatigue', person(state.history.at(-1)), person(sim.view()));
  const cabin = new CampSimulation(); cabin.act({ type: 'rest' }, context); cabin.advanceWorld(100);
  check('cabin recovers fatigue without underflow', person(cabin.view()).fatigue, 0);
  current.evidence = { minutes: state.worldMinute, finalWorld: state.world, historyEntries: state.history.length };
});

const checks = observations.flatMap((entry) => entry.checks);
const passed = checks.filter((entry) => entry.ok).length;
const report = {
  scenario: 'beast-camp-v1', observations: observations.length, checks: checks.length, passed, failed: checks.length - passed,
  scope: 'Only deterministic core behavior; no config, model, network, GUI, old tests, installation or build.',
  formulas: {
    motion: 'walking: distance += .04 km/min, phase += .65 rad/min; roll = 7*sin(phase); region = floor(distance/3)%3',
    tank: 'collected = rain*.8 when collector open; overflow=max(0,water+collected-40); spill=postCollectionWater*abs(sin(phase))*.006 when walking and unsecured',
    canopy: 'exposure=.15 if canopy open, else 1; wetness=clamp(wetness+rain*exposure*6-(clear?.8:.12),0,100)',
    soil: 'soilL=moisture/8; rainL=rain*.5*exposure; capacity=12.5L; evaporation=min(soilL,clear?.0125:.004); plantUse=min(remaining,.0125)',
    health: 'after soil settlement, +.02/min for moisture [30,80], -.08 below, -.05 above; clamp [0,100]',
    deck: 'walking wear=.002+.006*abs(sin(phase)); stopped wear=0; repair uses 1 timber to restore up to 12 points',
    actors: 'per minute: cabin fatigue -.08, elsewhere walking +.02 / stopped +.01; actions: work +2, move +1, rest -12, observe 0; clamp [0,100]',
    movement: 'cross-station move rejected when deckWetness>=70 AND abs(rollDeg)>=5; existing-station work allowed',
    clock: 'worldMinutes = elapsedMs*speed/60000 + carriedFraction; pause/wait/resume/retry/speed/copy/load reset wall anchor',
  },
  limitations: ['Authored toy laws; wind and temperature are descriptive weather values, not a coupled physics model.',
    'Actions are instantaneous; no pathfinding, animation, model decisions, actor runtime or UI verification.',
    'Snapshot/save retain complete in-memory history and audit; view bounds both. Long-running retention is not implemented.',
    'Failed actions only return outcomes; caller must keep actor/source/decision context with those outcomes.',
    'Atomic rename does not provide fsync crash durability. Load validates save structure and head, not authentic historical causality.'],
  results: observations,
};
writeFileSync(resolve(output, 'observations.json'), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(resolve(output, 'trace.jsonl'), trace.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
writeFileSync(resolve(output, 'observations.md'), [
  '# 巨兽营地确定性观测', '', `${passed}/${checks.length} checks passed across ${observations.length} observations.`, '',
  ...observations.map((entry) => `- ${entry.checks.every((c) => c.ok) ? 'PASS' : 'FAIL'} ${entry.name} (${entry.checks.filter((c) => c.ok).length}/${entry.checks.length})`),
  '', '## 人为公式', '', ...Object.entries(report.formulas).map(([name, formula]) => `- ${name}: ${formula}`),
  '', '## 结果', '', ...observations.map((entry) => `### ${entry.name}\n\n\`\`\`json\n${JSON.stringify(entry.evidence, null, 2)}\n\`\`\`\n`),
  '## 限制', '', ...report.limitations.map((text) => `- ${text}`), '',
].join('\n'));
for (const entry of observations) console.log(`${entry.checks.every((c) => c.ok) ? 'PASS' : 'FAIL'} ${entry.name}`);
console.log(`${passed}/${checks.length} checks; report: ${resolve(output, 'observations.json')}`);
for (const entry of checks.filter((c) => !c.ok)) console.error(JSON.stringify(entry));
if (passed !== checks.length) process.exitCode = 1;
