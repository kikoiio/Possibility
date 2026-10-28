import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { GENERATED_SCENARIO, GENERATED_ACTION_FIELDS, validateGeneratedWorld, stepGeneratedWorld, applyGeneratedAction } from './world-definition.mjs';

const SCENARIO = 'beast-camp-v1';
const MAX_MINUTES = 1440;
const LOCATIONS = ['cabin', 'terrace', 'garden', 'tank', 'lookout'];
const REGIONS = ['雾杉谷', '风脊', '浅溪'];
const WEATHER = {
  clear: { mode: 'clear', rainMmPerMinute: 0, windKph: 8, temperatureC: 23 },
  drizzle: { mode: 'drizzle', rainMmPerMinute: 0.25, windKph: 12, temperatureC: 18 },
  rain: { mode: 'rain', rainMmPerMinute: 0.8, windKph: 22, temperatureC: 15 },
};
const ACTION_FIELDS = {
  moveTo: ['location'], waterPlants: ['liters'], setCanopy: ['open'],
  setCollector: ['open'], secureCargo: [], repairDeck: [], rest: [], observe: [],
  setWeather: ['mode'], setWalking: ['walking'],
};
const STATIONS = {
  waterPlants: 'garden', setCollector: 'tank', secureCargo: 'tank',
  setCanopy: 'terrace', repairDeck: 'terrace', rest: 'cabin', observe: 'lookout',
};
const clone = (value) => structuredClone(value);
const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const fail = (reason, message = reason) => ({ ok: false, reason, message });
const exactKeys = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());

export function createCampWorld() {
  return {
    beast: { name: '苔背', walking: true, distanceKm: 0, phase: 0, rollDeg: 0, region: '雾杉谷' },
    weather: clone(WEATHER.drizzle),
    camp: {
      canopyOpen: false, collectorOpen: true, cargoSecured: false,
      waterL: 12, waterCapacityL: 40, deckWetness: 24, deckIntegrity: 88,
      soilMoisture: 42, plantHealth: 82, timber: 4,
    },
    actors: [
      { id: 'ihe', name: '伊禾', role: '修补匠', goal: '照料营地，让住处安全舒适。', location: 'terrace', fatigue: 18 },
      { id: 'loran', name: '洛岚', role: '旅人', goal: '寻找适合落脚的地方，同时照料眼下的住处。', location: 'lookout', fatigue: 12 },
    ],
  };
}

export function validateWorld(world) {
  if (world?.profile === 'generated-world') {
    const errors = validateGeneratedWorld(world);
    if (errors.length) throw new Error(`invalid-generated-world:${errors[0].path}`);
    return;
  }
  const initial = createCampWorld();
  if (!exactKeys(world, Object.keys(initial))) throw new Error('invalid-world-shape');
  const { beast: b, weather: w, camp: c, actors } = world;
  if (!exactKeys(b, Object.keys(initial.beast)) || !nonempty(b.name)
    || typeof b.walking !== 'boolean' || !finite(b.distanceKm, 0, Number.MAX_SAFE_INTEGER)
    || !finite(b.phase, 0, Number.MAX_SAFE_INTEGER) || !finite(b.rollDeg, -7, 7)
    || !REGIONS.includes(b.region)) throw new Error('invalid-beast');
  if (!Object.hasOwn(WEATHER, w?.mode) || !isDeepStrictEqual(w, WEATHER[w.mode])) throw new Error('invalid-weather');
  if (!exactKeys(c, Object.keys(initial.camp))
    || !['canopyOpen', 'collectorOpen', 'cargoSecured'].every((key) => typeof c[key] === 'boolean')
    || c.waterCapacityL !== 40 || !finite(c.waterL, 0, c.waterCapacityL)
    || !['deckWetness', 'deckIntegrity', 'soilMoisture', 'plantHealth'].every((key) => finite(c[key], 0, 100))
    || !Number.isSafeInteger(c.timber) || c.timber < 0) throw new Error('invalid-camp');
  if (!Array.isArray(actors) || actors.length !== 2 || new Set(actors.map((a) => a?.id)).size !== 2
    || !actors.every((a) => exactKeys(a, Object.keys(initial.actors[0]))
      && ['ihe', 'loran'].includes(a.id) && ['name', 'role', 'goal'].every((key) => nonempty(a[key]))
      && LOCATIONS.includes(a.location) && finite(a.fatigue, 0, 100))) throw new Error('invalid-actors');
}

function validateSpeed(speed) {
  // 1/24/60/120 are convenient presets; fractional positive speeds up to 1440 are legal.
  if (!finite(speed, Number.MIN_VALUE, 1440)) throw new Error('invalid-speed:expected 0 < speed <= 1440');
}

export function step(world) {
  if (world?.profile === 'generated-world') return stepGeneratedWorld(world);
  const next = clone(world);
  const { beast: b, weather: w, camp: c } = next;
  // All laws below are authored toy rules, not physical simulation or random story events.
  // Phase is radians; each walking minute advances 0.04 km and 0.65 rad.
  b.distanceKm += b.walking ? 0.04 : 0;
  b.phase += b.walking ? 0.65 : 0;
  b.rollDeg = 7 * Math.sin(b.phase);
  b.region = REGIONS[Math.floor(b.distanceKm / 3) % REGIONS.length]; // 3 km per region, cyclic.

  // 1 mm over 1 m² = 1 L. Collector area = 0.8 m²; overflow leaves the system.
  const collectedL = c.collectorOpen ? w.rainMmPerMinute * 0.8 : 0;
  const overflowL = Math.max(0, c.waterL + collectedL - c.waterCapacityL);
  c.waterL = Math.min(c.waterCapacityL, c.waterL + collectedL);
  const sway = Math.abs(b.rollDeg) / 7;
  // An unsecured, moving tank loses at most 0.6% of its post-collection water per minute.
  const spilledL = b.walking && !c.cargoSecured ? c.waterL * sway * 0.006 : 0;
  c.waterL -= spilledL;

  const exposure = c.canopyOpen ? 0.15 : 1;
  const wetting = w.rainMmPerMinute * exposure * 6;
  const drying = w.mode === 'clear' ? 0.8 : 0.12;
  c.deckWetness = clamp(c.deckWetness + wetting - drying);

  // Soil stores 12.5 L at 100 moisture points (8 points/L). Rain area = 0.5 m².
  // Canopy blocks 85% of rain on both deck and plants, but not the separate collector.
  const gardenRainL = w.rainMmPerMinute * 0.5 * exposure;
  const soilOverflowL = Math.max(0, c.soilMoisture / 8 + gardenRainL - 12.5);
  let soilL = Math.min(12.5, c.soilMoisture / 8 + gardenRainL);
  const evaporationL = Math.min(soilL, w.mode === 'clear' ? 0.0125 : 0.004);
  soilL -= evaporationL;
  const plantUseL = Math.min(soilL, 0.0125);
  c.soilMoisture = (soilL - plantUseL) * 8;
  // Health changes after water settlement: +.02 in [30,80], -.08 below, -.05 above.
  const healthDelta = c.soilMoisture < 30 ? -0.08 : c.soilMoisture > 80 ? -0.05 : 0.02;
  c.plantHealth = clamp(c.plantHealth + healthDelta);
  const deckWear = b.walking ? 0.002 + 0.006 * sway : 0;
  c.deckIntegrity = clamp(c.deckIntegrity - deckWear);
  for (const actor of next.actors) {
    actor.fatigue = clamp(actor.fatigue + (actor.location === 'cabin' ? -0.08 : b.walking ? 0.02 : 0.01));
  }
  validateWorld(next);
  return {
    world: next,
    event: {
      type: 'continuous_step',
      collectedL, overflowL, spilledL, gardenRainL, soilOverflowL, evaporationL, plantUseL,
      wetting, drying, healthDelta, deckWear,
    },
  };
}

export class CampSimulation {
  #state;
  #wallMs = null;

  constructor({ world = createCampWorld(), speed = 24 } = {}) {
    validateWorld(world);
    validateSpeed(speed);
    this.#state = {
      schemaVersion: 1, scenario: world.profile === 'generated-world' ? GENERATED_SCENARIO : SCENARIO, instanceId: randomUUID(),
      worldMinute: 0, revision: 0, world: clone(world), paused: false, waiting: null,
      speed, fractionalMinutes: 0,
      history: [{ revision: 0, worldMinute: 0, event: { type: 'origin' }, world: clone(world) }],
      audit: [],
    };
  }

  snapshot() { return clone(this.#state); }

  view(limit = 120) {
    if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('invalid-view-limit');
    const { experience, history, audit, ...state } = this.#state;
    return clone({ ...state, history: limit === 0 ? [] : history.slice(-limit), audit: limit === 0 ? [] : audit.slice(-limit) });
  }

  copy() {
    const copy = new CampSimulation();
    copy.#state = clone(this.#state); // Same saved-world identity; no shared references or wall anchor.
    return copy;
  }

  #audit(kind, result, extra = {}) {
    this.#state.audit.push({ kind, revision: this.#state.revision, worldMinute: this.#state.worldMinute, ...clone(extra), ...clone(result) });
    return result;
  }

  #commit(world, event, worldMinute = this.#state.worldMinute) {
    if (this.#state.revision === Number.MAX_SAFE_INTEGER) throw new Error('revision-exhausted');
    this.#state.world = world;
    this.#state.worldMinute = worldMinute;
    this.#state.revision++;
    this.#state.history.push({ revision: this.#state.revision, worldMinute, event: clone(event), world: clone(world) });
  }

  act(action, { actorId = null, source = 'author', decisionId = null } = {}) {
    // Rejections only return an outcome. The caller/runtime must retain it with actorId,
    // source and decisionId in its memory. No revision, audit or world mutation on failure.
    if (!nonempty(source) || (actorId !== null && typeof actorId !== 'string')
      || (decisionId !== null && !nonempty(decisionId))) return fail('invalid-action-context');
    const actor = actorId === null ? null : this.#state.world.actors.find((a) => a.id === actorId);
    if (actorId !== null && !actor) return fail('unknown-actor');
    if (source !== 'author' && !actor) return fail('actor-required');
    if (this.#state.world.profile === 'generated-world') {
      const next = applyGeneratedAction(this.#state.world, action, { actorId, source, decisionId, worldMinute:this.#state.worldMinute });
      if (!next.result.ok) return next.result;
      validateWorld(next.world);
      this.#commit(next.world, next.event);
      return this.#audit('action', next.result, { action, actorId, source, decisionId });
    }
    if (!object(action) || typeof action.type !== 'string' || !Object.hasOwn(ACTION_FIELDS, action.type)) return fail('unsupported-action');
    if (!exactKeys(action, ['type', ...ACTION_FIELDS[action.type]])) return fail('invalid-action-fields');
    const { type } = action;
    if (['moveTo', 'rest'].includes(type) && actor === null) return fail('actor-required');
    if (['setWeather', 'setWalking'].includes(type) && (source !== 'author' || actor !== null)) return fail('author-only');
    if (type === 'moveTo' && !LOCATIONS.includes(action.location)) return fail('invalid-location');
    if (type === 'waterPlants' && !finite(action.liters, Number.MIN_VALUE, 40)) return fail('invalid-liters');
    if (['setCanopy', 'setCollector'].includes(type) && typeof action.open !== 'boolean') return fail('invalid-open');
    if (type === 'setWeather' && (typeof action.mode !== 'string' || !Object.hasOwn(WEATHER, action.mode))) return fail('invalid-weather-mode');
    if (type === 'setWalking' && typeof action.walking !== 'boolean') return fail('invalid-walking');

    const world = clone(this.#state.world);
    const c = world.camp;
    if (type === 'waterPlants' && action.liters > c.waterL) return fail('insufficient-water', '水箱存水不足。');
    if (type === 'repairDeck' && c.timber < 1) return fail('insufficient-timber', '没有可用木材。');
    if (type === 'repairDeck' && c.deckIntegrity === 100) return fail('deck-intact', '甲板无需修补。');
    const target = type === 'moveTo' ? action.location : STATIONS[type];
    if (actor && target && target !== actor.location && c.deckWetness >= 70 && Math.abs(world.beast.rollDeg) >= 5) {
      return fail('unsafe-movement', `露台湿滑且巨兽摇摆，无法安全前往 ${target}。`);
    }
    const effects = {};
    switch (type) {
      case 'waterPlants': {
        // Transfer requested liters out of tank; soil accepts up to capacity, excess drains away.
        const absorbedL = Math.min(action.liters, (100 - c.soilMoisture) / 8);
        c.waterL -= action.liters;
        c.soilMoisture = Math.min(100, c.soilMoisture + absorbedL * 8);
        Object.assign(effects, { withdrawnL: action.liters, absorbedL, runoffL: action.liters - absorbedL });
        break;
      }
      case 'setCanopy': c.canopyOpen = action.open; break;
      case 'setCollector': c.collectorOpen = action.open; break;
      case 'secureCargo': c.cargoSecured = true; break;
      case 'repairDeck':
        c.timber--;
        effects.restoredIntegrity = Math.min(12, 100 - c.deckIntegrity);
        c.deckIntegrity += effects.restoredIntegrity;
        break;
      case 'setWeather': world.weather = clone(WEATHER[action.mode]); break;
      case 'setWalking': world.beast.walking = action.walking; break;
      // Rest and observation never choose a future action or advance world time.
      case 'moveTo': case 'rest': case 'observe': break;
    }
    if (actor) {
      const nextActor = world.actors.find((a) => a.id === actor.id);
      if (target) nextActor.location = target;
      // Instant work costs 2 fatigue, movement 1, rest recovers 12, observation costs 0.
      nextActor.fatigue = clamp(nextActor.fatigue + (type === 'rest' ? -12 : type === 'observe' ? 0 : type === 'moveTo' ? 1 : 2));
    }
    validateWorld(world);
    const result = { ok: true, message: '行动已完成。' };
    this.#commit(world, { ...clone(action), actorId, source, decisionId, result, effects });
    return this.#audit('action', result, { action, actorId, source, decisionId });
  }

  advanceWorld(duration) {
    if (!Number.isSafeInteger(duration) || duration < 0 || duration > MAX_MINUTES) return fail('invalid-duration', '需要整数分钟 0..1440。');
    if (this.#state.paused || this.#state.waiting !== null) return fail('blocked', this.#state.waiting ?? 'paused');
    if (!Number.isSafeInteger(this.#state.worldMinute + duration)
      || !Number.isSafeInteger(this.#state.revision + duration)) return fail('time-range-exceeded');
    for (let i = 0; i < duration; i++) {
      const { world, event } = step(this.#state.world);
      this.#commit(world, event, this.#state.worldMinute + 1);
    }
    return this.#audit('advance', { ok: true, advancedMinutes: duration });
  }

  pause() {
    this.#state.paused = true;
    this.#wallMs = null;
    return this.#audit('pause', { ok: true });
  }

  resume() {
    this.#state.paused = false;
    this.#wallMs = null;
    return this.#audit('resume', { ok: true });
  }

  wait(reason) {
    if (!nonempty(reason)) throw new Error('waiting-reason-required');
    this.#state.waiting = reason;
    this.#wallMs = null;
    return this.#audit('wait', { ok: true }, { reason });
  }

  retry() {
    this.#state.waiting = null;
    this.#wallMs = null;
    return this.#audit('retry', { ok: true });
  }

  setSpeed(speed) {
    validateSpeed(speed);
    this.#state.speed = speed;
    this.#wallMs = null;
    return this.#audit('speed', { ok: true }, { speed });
  }

  sampleWall(performanceMs) {
    if (!finite(performanceMs, 0, Number.MAX_VALUE)) return fail('invalid-wall-time');
    const last = this.#wallMs;
    if (last !== null && performanceMs < last) return fail('clock-went-backwards');
    this.#wallMs = performanceMs;
    if (last === null || this.#state.paused || this.#state.waiting !== null) return { ok: true, advancedMinutes: 0 };
    // speed = world minutes / real minute. Controls reset anchors but preserve fractions.
    const total = this.#state.fractionalMinutes + (performanceMs - last) * this.#state.speed / 60000;
    const whole = Math.floor(total + 4 * Number.EPSILON * Math.max(1, total));
    if (!Number.isFinite(total) || whole > MAX_MINUTES) {
      this.wait('clock-range-exceeded'); // Discard the oversized interval; no silent catch-up.
      return fail('clock-range-exceeded');
    }
    if (whole === 0) {
      this.#state.fractionalMinutes = total;
      return { ok: true, advancedMinutes: 0 };
    }
    const result = this.advanceWorld(whole);
    if (result.ok) this.#state.fractionalMinutes = Math.max(0, total - whole);
    else this.wait(`clock:${result.reason}`);
    return result;
  }

  save(path, { experience } = {}) {
    if (!nonempty(path)) throw new Error('invalid-save-path');
    const saved = experience === undefined ? this.#state : { ...this.#state, experience: clone(experience) };
    const serialized = `${JSON.stringify(saved)}\n`;
    // Reject lossy/non-JSON experience rather than silently dropping memory fields.
    if (!isDeepStrictEqual(JSON.parse(serialized), saved)) throw new Error('non-json-save');
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameSync(temporary, path); // World and experience become visible together, in the same file.
    } finally {
      rmSync(temporary, { force: true });
    }
    if (experience !== undefined) this.#state = saved;
    return { ok: true, path };
  }

  static load(path) {
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    if (saved?.schemaVersion !== 1 || ![SCENARIO, GENERATED_SCENARIO].includes(saved.scenario)) throw new Error('unsupported-save');
    const generated = saved.scenario === GENERATED_SCENARIO;
    if (generated !== (saved.world?.profile === 'generated-world')) throw new Error('invalid-save-scenario');
    const actionFields = generated ? GENERATED_ACTION_FIELDS : ACTION_FIELDS;
    const required = ['schemaVersion', 'scenario', 'instanceId', 'worldMinute', 'revision', 'world', 'paused', 'waiting', 'speed', 'fractionalMinutes', 'history', 'audit'];
    if (!exactKeys(saved, Object.hasOwn(saved, 'experience') ? [...required, 'experience'] : required)
      || typeof saved.instanceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.instanceId)
      || !Number.isSafeInteger(saved.worldMinute) || saved.worldMinute < 0
      || !Number.isSafeInteger(saved.revision) || saved.revision < 0) throw new Error('invalid-save-head');
    if (typeof saved.paused !== 'boolean' || !(saved.waiting === null || nonempty(saved.waiting))
      || !finite(saved.fractionalMinutes, 0, 1) || saved.fractionalMinutes >= 1) throw new Error('invalid-save-control');
    validateSpeed(saved.speed);
    validateWorld(saved.world);
    if (!Array.isArray(saved.history) || saved.history.length !== saved.revision + 1
      || !Array.isArray(saved.audit) || !saved.audit.every(object)) throw new Error('invalid-save-history');
    for (let index = 0; index < saved.history.length; index++) {
      const entry = saved.history[index];
      if (!exactKeys(entry, ['revision', 'worldMinute', 'event', 'world']) || entry.revision !== index
        || !Number.isSafeInteger(entry.worldMinute) || entry.worldMinute < 0
        || !object(entry.event) || !nonempty(entry.event.type)) throw new Error('invalid-save-history');
      validateWorld(entry.world);
      if (generated !== (entry.world?.profile === 'generated-world')) throw new Error('invalid-save-scenario');
      if (index === 0) {
        if (entry.worldMinute !== 0 || entry.event.type !== 'origin') throw new Error('invalid-save-origin');
      } else {
        const previous = saved.history[index - 1];
        const delta = entry.event.type === 'continuous_step' ? 1 : 0;
        if (entry.worldMinute !== previous.worldMinute + delta
          || (delta === 0 && !Object.hasOwn(actionFields, entry.event.type))) throw new Error('invalid-save-time');
      }
    }
    const head = saved.history.at(-1);
    if (head.worldMinute !== saved.worldMinute || !isDeepStrictEqual(head.world, saved.world)) throw new Error('invalid-save-head');
    const simulation = new CampSimulation();
    simulation.#state = clone(saved);
    // No timestamps are read and no offline minutes are settled. First sample only anchors.
    return simulation;
  }
}
