import { validateSceneDocument, validateSpatialLayout } from './geometry/scene-document.js';

export const GENERATED_SCENARIO = 'generated-world-v1';
export const GENERATED_LIMITS = Object.freeze({ actors: 8, places: 12, resources: 24, processes: 32, actions: 24, conditions: 24, initialMemories: 32, quantity: 1e9, rate: 1e6 });
export const GENERATED_ACTION_FIELDS = Object.freeze({ moveTo: ['location'], perform: ['actionId'], rest: [], observe: [], speak: ['text'], inspect: ['clueId'] });
const clone = (value) => structuredClone(value);
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const text = (value, max = 2000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const id = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value);
const point = (value) => Array.isArray(value) && value.length === 3 && value.every((n) => finite(n, -10000, 10000));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const fail = (reason, message = reason) => ({ result: { ok: false, reason, message } });
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

function diagnostics() {
  const errors = [];
  const add = (path, code, message) => errors.push({ path, code, message, nodeId: path, operationId: 'validate-world', requirementId: code });
  const shape = (value, keys, path) => {
    if (!record(value)) { add(path, 'object', 'Expected an object.'); return false; }
    for (const key of Object.keys(value)) if (!keys.includes(key)) add(`${path}.${key}`, 'unknown-field', 'Unsupported field.');
    for (const key of keys) if (!Object.hasOwn(value, key)) add(`${path}.${key}`, 'required', 'Required field.');
    return true;
  };
  const list = (value, min, max, path) => {
    if (!Array.isArray(value) || value.length < min || value.length > max) { add(path, 'collection-size', `Expected ${min}..${max} entries.`); return []; }
    return value;
  };
  return { errors, add, shape, list };
}

function checkWorld(world, d) {
  const { add, shape, list } = d;
  if (!shape(world, ['profile', 'title', 'description', 'environment', 'places', 'actors', 'resources', 'processes', 'actions', ...(Object.hasOwn(world || {}, 'story') ? ['story'] : [])], 'world')) return;
  if (world.profile !== 'generated-world') add('world.profile', 'profile', 'Expected generated-world.');
  for (const key of ['title', 'description']) if (!text(world[key])) add(`world.${key}`, 'text', 'Expected nonempty bounded text.');
  if (shape(world.environment, ['weather'], 'world.environment') && !text(world.environment.weather, 500)) add('world.environment.weather', 'text', 'Expected weather text.');
  const places = list(world.places, 1, GENERATED_LIMITS.places, 'world.places');
  const actors = list(world.actors, 1, GENERATED_LIMITS.actors, 'world.actors');
  const resources = list(world.resources, 0, GENERATED_LIMITS.resources, 'world.resources');
  const processes = list(world.processes, 0, GENERATED_LIMITS.processes, 'world.processes');
  const actions = list(world.actions, 0, GENERATED_LIMITS.actions, 'world.actions');
  const identities = (entries, path) => {
    const ids = new Set();
    entries.forEach((entry, i) => {
      if (!id(entry?.id) || ids.has(entry.id)) add(`${path}[${i}].id`, 'identity', 'Invalid or duplicate id.');
      else ids.add(entry.id);
    });
    return ids;
  };
  const placeIds = identities(places, 'world.places');
  const actorIds = identities(actors, 'world.actors'); const resourceIds = identities(resources, 'world.resources');
  identities(processes, 'world.processes'); identities(actions, 'world.actions');
  const reference = (value, ids, path) => { if (!ids.has(value)) add(path, 'reference', 'Unknown reference.'); };
  const strings = (entry, keys, path) => { for (const key of keys) if (!text(entry[key])) add(`${path}.${key}`, 'text', 'Expected nonempty bounded text.'); };
  places.forEach((place, i) => {
    const p = `world.places[${i}]`;
    if (!shape(place, ['id', 'name', 'description', 'position', 'visibleFrom', ...(Object.hasOwn(place || {}, 'roomId') ? ['roomId'] : [])], p)) return;
    if (Object.hasOwn(place, 'roomId') && !id(place.roomId)) add(`${p}.roomId`, 'identity', 'Invalid room id.');
    strings(place, ['name', 'description'], p);
    if (!point(place.position)) add(`${p}.position`, 'position', 'Expected finite [x,y,z].');
    const visible = list(place.visibleFrom, 0, GENERATED_LIMITS.places, `${p}.visibleFrom`);
    visible.forEach((v, j) => reference(v, placeIds, `${p}.visibleFrom[${j}]`));
    if (new Set(visible).size !== visible.length) add(`${p}.visibleFrom`, 'duplicate-reference', 'Duplicate visibility reference.');
  });
  actors.forEach((actor, i) => {
    const p = `world.actors[${i}]`;
    if (!shape(actor, ['id', 'name', 'role', 'goal', 'background', 'location', 'fatigue'], p)) return;
    strings(actor, ['name', 'role', 'goal', 'background'], p);
    reference(actor.location, placeIds, `${p}.location`);
    if (!finite(actor.fatigue, 0, 100)) add(`${p}.fatigue`, 'fatigue', 'Expected fatigue 0..100.');
  });
  resources.forEach((resource, i) => {
    const p = `world.resources[${i}]`;
    if (!shape(resource, ['id', 'name', 'unit', 'location', 'quantity', 'capacity', ...(Object.hasOwn(resource || {}, 'visibility') ? ['visibility'] : [])], p)) return;
    strings(resource, ['name', 'unit'], p); reference(resource.location, placeIds, `${p}.location`);
    if (!finite(resource.capacity, 0, GENERATED_LIMITS.quantity) || !finite(resource.quantity, 0, resource.capacity)) add(p, 'resource-range', 'Expected 0 <= quantity <= capacity <= 1e9.');
  });
  const conditions = (value, path, location = null) => {
    list(value, 0, GENERATED_LIMITS.conditions, path).forEach((condition, i) => {
      const p = `${path}[${i}]`;
      if (!shape(condition, ['resourceId', 'op', 'value'], p)) return;
      reference(condition.resourceId, resourceIds, `${p}.resourceId`);
      if (!['gte', 'lte'].includes(condition.op)) add(`${p}.op`, 'condition-op', 'Expected gte or lte.');
      const resource = resources.find((r) => r?.id === condition.resourceId);
      if (!finite(condition.value, 0, resource?.capacity ?? GENERATED_LIMITS.quantity)) add(`${p}.value`, 'condition-range', 'Expected a finite threshold within 0..resource capacity.');
      if (location !== null && resource && resource.location !== location) add(`${p}.resourceId`, 'resource-location', 'Action requirements must reference resources at its location.');
    });
  };
  processes.forEach((process, i) => {
    const p = `world.processes[${i}]`;
    if (!shape(process, ['id', 'description', 'resourceId', 'deltaPerMinute', ...(Object.hasOwn(process || {}, 'when') ? ['when'] : [])], p)) return;
    strings(process, ['description'], p); reference(process.resourceId, resourceIds, `${p}.resourceId`);
    if (!finite(process.deltaPerMinute, -GENERATED_LIMITS.rate, GENERATED_LIMITS.rate)) add(`${p}.deltaPerMinute`, 'rate', 'Expected finite signed rate within +/-1e6.');
    if (Object.hasOwn(process, 'when')) conditions(process.when, `${p}.when`);
  });
  actions.forEach((action, i) => {
    const p = `world.actions[${i}]`;
    if (!shape(action, ['id', 'name', 'description', 'location', 'costs', 'gains', ...(Object.hasOwn(action || {}, 'requires') ? ['requires'] : []),
      ...(Object.hasOwn(action || {}, 'visibility') ? ['visibility'] : []), ...(Object.hasOwn(action || {}, 'performers') ? ['performers'] : [])], p)) return;
    strings(action, ['name', 'description'], p); reference(action.location, placeIds, `${p}.location`);
    if (Object.hasOwn(action, 'requires')) conditions(action.requires, `${p}.requires`, action.location);
    for (const key of ['costs', 'gains']) {
      const effects = list(action[key], 0, GENERATED_LIMITS.resources, `${p}.${key}`);
      const seen = new Set();
      effects.forEach((effect, j) => {
        const e = `${p}.${key}[${j}]`;
        if (!shape(effect, ['resourceId', 'amount'], e)) return;
        reference(effect.resourceId, resourceIds, `${e}.resourceId`);
        if (seen.has(effect.resourceId)) add(`${e}.resourceId`, 'duplicate-effect', 'Use one amount per resource per costs/gains list.');
        seen.add(effect.resourceId);
        if (!finite(effect.amount, Number.MIN_VALUE, GENERATED_LIMITS.quantity)) add(`${e}.amount`, 'amount', 'Expected positive finite amount <= 1e9.');
        const resource = resources.find((r) => r?.id === effect.resourceId);
        if (resource && resource.location !== action.location) add(e, 'resource-location', 'Action resources must be at its location.');
      });
    }
  });
  if (Object.hasOwn(world, 'story')) checkStory(world, d);
  const clueIds = new Set((world.story?.clues ?? []).map((clue) => clue?.id));
  const checkVisibility = (value, path) => {
    if (!shape(value, ['actors', 'clues'], path)) return;
    const allowedActors = list(value.actors, 0, GENERATED_LIMITS.actors, `${path}.actors`);
    const revealingClues = list(value.clues, 0, 32, `${path}.clues`);
    if (!allowedActors.length && !revealingClues.length) add(path, 'visibility-target', 'Visibility must name an actor or a revealing clue.');
    if (new Set(allowedActors).size !== allowedActors.length) add(`${path}.actors`, 'duplicate-reference', 'Duplicate visibility actor.');
    if (new Set(revealingClues).size !== revealingClues.length) add(`${path}.clues`, 'duplicate-reference', 'Duplicate revealing clue.');
    allowedActors.forEach((actorId, j) => { if (!actorIds.has(actorId)) add(`${path}.actors[${j}]`, 'reference', 'Unknown visibility actor.'); });
    revealingClues.forEach((clueId, j) => { if (!clueIds.has(clueId)) add(`${path}.clues[${j}]`, 'reference', 'Unknown revealing clue.'); });
  };
  for (const [entries, path] of [[resources, 'world.resources'], [actions, 'world.actions']]) {
    entries.forEach((entry, i) => { if (Object.hasOwn(entry ?? {}, 'visibility')) checkVisibility(entry.visibility, `${path}[${i}].visibility`); });
  }
  actions.forEach((action, i) => {
    if (!Object.hasOwn(action ?? {}, 'performers')) return;
    const performers = list(action.performers, 1, GENERATED_LIMITS.actors, `world.actions[${i}].performers`);
    if (new Set(performers).size !== performers.length) d.add(`world.actions[${i}].performers`, 'duplicate-reference', 'Duplicate action performer.');
    performers.forEach((actorId, j) => { if (!actorIds.has(actorId)) d.add(`world.actions[${i}].performers[${j}]`, 'reference', 'Unknown action performer.'); });
  });
}

function checkStory(world, d) {
  const {shape,list,add}=d, story=world.story;
  if (!shape(story,['premise','connections','facts','clues','conversations'],'world.story')) return;
  if (!text(story.premise)) add('world.story.premise','text','Expected a bounded opening premise.');
  const actors=new Set((Array.isArray(world.actors)?world.actors:[]).map(a=>a?.id)), places=new Set((Array.isArray(world.places)?world.places:[]).map(p=>p?.id));
  const actorList=(value,path)=>{const entries=list(value,0,8,path);if(new Set(entries).size!==entries.length||entries.some(v=>!actors.has(v)))add(path,'reference','Expected unique existing actor ids.');};
  const ids=new Set();
  const identity=(value,path)=>{if(!id(value)||ids.has(value))add(path,'identity','Invalid or duplicate story id.');else ids.add(value);};
  const connections=list(story.connections,0,66,'world.story.connections'),edges=new Set();
  connections.forEach((c,i)=>{const p=`world.story.connections[${i}]`;if(!shape(c,['from','to'],p))return;const key=[c.from,c.to].sort().join('|');if(!places.has(c.from)||!places.has(c.to)||c.from===c.to||edges.has(key))add(p,'connection','Expected a unique connection between different existing places.');edges.add(key);});
  if(places.size){const reached=new Set([places.values().next().value]);for(let i=0;i<places.size;i++)for(const c of connections)if(record(c)&&(reached.has(c.from)||reached.has(c.to))){reached.add(c.from);reached.add(c.to);}if([...places].some(p=>!reached.has(p)))add('world.story.connections','unreachable-room','Every room must be reachable.');}
  list(story.facts,0,40,'world.story.facts').forEach((f,i)=>{const p=`world.story.facts[${i}]`;if(!shape(f,['id','text','knownBy'],p))return;identity(f.id,p+'.id');if(!text(f.text))add(p+'.text','text','Expected fact text.');actorList(f.knownBy,p+'.knownBy');});
  list(story.clues,0,32,'world.story.clues').forEach((c,i)=>{const p=`world.story.clues[${i}]`;if(!shape(c,['id','name','location','detail','discoveredBy'],p))return;identity(c.id,p+'.id');if(!text(c.name)||!text(c.detail))add(p,'text','Expected clue name and detail.');if(!places.has(c.location))add(p+'.location','reference','Unknown clue place.');actorList(c.discoveredBy,p+'.discoveredBy');});
  // Runtime testimony is durable history; it is not a list of objective facts.
  if(!Array.isArray(story.conversations)){add('world.story.conversations','collection','Expected conversations.');return;}
  story.conversations.forEach((s,i)=>{const p=`world.story.conversations[${i}]`;if(!shape(s,['id','speakerId','location','minute','text','listeners'],p))return;identity(s.id,p+'.id');if(!actors.has(s.speakerId)||!places.has(s.location))add(p,'reference','Unknown speaker or place.');if(!Number.isSafeInteger(s.minute)||s.minute<0||!text(s.text,500))add(p,'statement','Expected timestamp and bounded speech.');actorList(s.listeners,p+'.listeners');if(Array.isArray(s.listeners)&&s.listeners.includes(s.speakerId))add(p+'.listeners','speaker','Listeners must exclude the speaker.');});
}

export function validateGeneratedWorld(world) {
  const d = diagnostics(); checkWorld(world, d); return d.errors;
}

// The scene stays the standard SceneDocument. Reject extensions that would pretend
// to install code or unsupported rules, including extensions nested inside objects.
function checkSceneFields(scene, d) {
  const optionalShape = (value, required, optional, path) => {
    if (!record(value)) { d.add(path, 'object', 'Expected an object.'); return; }
    for (const key of Object.keys(value)) if (![...required, ...optional].includes(key)) d.add(`${path}.${key}`, 'unknown-field', 'Unsupported scene field.');
    for (const key of required) if (!Object.hasOwn(value, key)) d.add(`${path}.${key}`, 'required', 'Required scene field.');
  };
  optionalShape(scene, ['schemaVersion', 'profile', 'id', 'title', 'style', 'regions', 'objects'], [], 'scene');
  if (!record(scene)) return;
  optionalShape(scene.style, ['palette', 'voxelUnit', 'seed'], [], 'scene.style');
  const regions = d.list(scene.regions, 1, 12, 'scene.regions');
  regions.forEach((region, i) => optionalShape(region, ['id', 'kind', 'center', 'elevation', ...(region?.kind === 'water' ? ['size'] : ['radius', 'irregularity'])], [], `scene.regions[${i}]`));
  const fields = {
    library: ['transform', 'bounds', 'roof', 'entrance', 'windows', 'parts', 'attachments'],
    house: ['transform', 'bounds', 'roof', 'entrance', 'windows', 'parts', 'attachments'],
    porch: ['transform', 'bounds', 'attachments'], bridge: ['from', 'to', 'width', 'arch', 'segments', 'attachments'],
    room: ['transform', 'bounds'],
    tree: ['position', 'scale', 'seed'], path: ['points', 'width'], character: ['position', 'route', 'speed'],
  };
  const objects = d.list(scene.objects, 1, 80, 'scene.objects');
  objects.forEach((node, i) => {
    const p = `scene.objects[${i}]`;
    optionalShape(node, ['id', 'kind'], ['name', ...(fields[node?.kind] ?? [])], p);
    if (!record(node)) return;
    for (const [key, keys] of Object.entries({ transform: ['position', 'rotation'], bounds: ['width', 'depth', 'wallHeight', 'floor'], roof: ['kind', 'rise', 'overhang'], entrance: ['wall', 'width', 'height'], from: ['region', 'point'], to: ['region', 'point'] })) {
      if (Object.hasOwn(node, key)) optionalShape(node[key], [], keys, `${p}.${key}`);
    }
    for (const [key, keys] of [['windows', ['wall', 'offset']], ['attachments', ['target', 'relation']]]) {
      if (Array.isArray(node[key])) node[key].forEach((entry, j) => optionalShape(entry, keys, [], `${p}.${key}[${j}]`));
    }
    if (node.parts !== undefined && (!Array.isArray(node.parts) || !node.parts.every((v) => typeof v === 'string' && ['walls', 'roof', 'bookshelves', 'reading-table', 'lamp'].includes(v)))) d.add(`${p}.parts`, 'parts', 'Unsupported building parts.');
  });
}

export function validateWorldDefinition(definition) {
  const d = diagnostics();
  if (!d.shape(definition, ['schemaVersion', 'world', 'scene', 'initialMemories'], 'definition')) return d.errors;
  if (definition.schemaVersion !== 1) d.add('schemaVersion', 'version', 'Expected schemaVersion 1.');
  checkWorld(definition.world, d);
  if (definition.world?.story?.conversations?.length) d.add('world.story.conversations', 'invented-history', 'A new world must not contain already-played conversations.');
  const beforeScene = d.errors.length;
  checkSceneFields(definition.scene, d);
  if (definition.scene?.profile !== 'world') d.add('scene.profile', 'profile', 'Expected world scene profile.');
  // Geometry owns its structural and spatial validation; malformed input is data,
  // never an exception escaping the generation validation boundary.
  try {
    if (d.errors.length === beforeScene) {
      const errors = validateSceneDocument(definition.scene);
      d.errors.push(...errors);
      if (!errors.length) d.errors.push(...validateSpatialLayout(definition.scene));
    }
  } catch {
    d.add('scene', 'scene-shape', 'Malformed scene document.');
  }
  const actors = Array.isArray(definition.world?.actors) ? definition.world.actors.filter(record) : [];
  const places = Array.isArray(definition.world?.places) ? definition.world.places.filter(record) : [];
  const objects = Array.isArray(definition.scene?.objects) ? definition.scene.objects.filter(record) : [];
  const characters = objects.filter((o) => o.kind === 'character');
  for (const actor of actors) {
    const matching = characters.filter((o) => o.id === actor.id);
    const place = places.find((p) => p.id === actor.location);
    if (matching.length !== 1 || !point(matching[0]?.position) || !point(place?.position) || matching[0].position.some((v, i) => v !== place.position[i])) d.add(`scene.${actor.id}`, 'actor-position', 'Exactly one character must match each actor id and initial place position.');
  }
  if (characters.some((character) => !actors.some((actor) => actor.id === character.id))) d.add('scene.objects', 'unknown-actor', 'Every character must reference a world actor.');
  const memories = d.list(definition.initialMemories, 0, GENERATED_LIMITS.initialMemories, 'initialMemories');
  memories.forEach((memory, i) => {
    const p = `initialMemories[${i}]`;
    if (!d.shape(memory, ['actorId', 'text'], p)) return;
    if (!actors.some((actor) => actor.id === memory.actorId)) d.add(`${p}.actorId`, 'reference', 'Unknown actor.');
    if (!text(memory.text)) d.add(`${p}.text`, 'text', 'Expected bounded nonempty memory.');
  });
  return d.errors;
}

const conditionMet = (condition, resource) => Boolean(resource) && (condition.op === 'gte'
  ? resource.quantity >= condition.value : condition.op === 'lte' && resource.quantity <= condition.value);

function conditionMessage(condition, resource) {
  const lower = condition.op === 'gte';
  return `${resource.name}当前为 ${resource.quantity} ${resource.unit}，需${lower ? '至少' : '至多'} ${condition.value} ${resource.unit}（${lower ? '还缺' : '超出'} ${Math.abs(resource.quantity - condition.value)} ${resource.unit}）`;
}

function generatedVisibility(world, actor) {
  // visibleFrom belongs to the target place; visibility is direct and directional.
  const adjacent = world.story?.connections.flatMap((c) => c.from === actor.location ? [c.to] : c.to === actor.location ? [c.from] : []) ?? [];
  const places = world.places.filter((p) => p.id === actor.location || (world.story ? adjacent.includes(p.id) : p.visibleFrom.includes(actor.location)));
  return { places, visible: new Set(world.story ? [actor.location] : places.map((p) => p.id)) };
}

function itemVisibility(item, actorId, world) {
  const visibility = item?.visibility;
  if (!visibility) return true;
  return visibility.actors.includes(actorId)
    || visibility.clues.some((clueId) => world.story?.clues.some((clue) => clue.id === clueId && clue.discoveredBy.includes(actorId)));
}

function visibleResource(world, resource, actorId, visibleLocations) {
  return visibleLocations.has(resource.location) && itemVisibility(resource, actorId, world);
}

function visibleAction(world, action, actorId, visibleLocations) {
  if (!visibleLocations.has(action.location) || !itemVisibility(action, actorId, world)) return false;
  return true;
}

function executableAction(action, actorId) {
  return !Object.hasOwn(action, 'performers') || action.performers.includes(actorId);
}

// Supply only visible resources for resident-facing checks. Missing dependencies
// remain unknown, regardless of their hidden quantity or whether they are satisfied.
function actionAvailability(action, resources) {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const unmetRequirements = [];
  let unknown = false;
  for (const condition of action.requires ?? []) {
    const resource = byId.get(condition.resourceId);
    if (!resource) unknown = true;
    else if (!conditionMet(condition, resource)) unmetRequirements.push({ reason: 'requirements-not-met', resourceId: resource.id, message: conditionMessage(condition, resource) });
  }
  for (const cost of action.costs) {
    const resource = byId.get(cost.resourceId);
    if (!resource) unknown = true;
    else if (resource.quantity < cost.amount) unmetRequirements.push({ reason: 'insufficient-resource', resourceId: resource.id,
      message: `${resource.name}当前为 ${resource.quantity} ${resource.unit}，需消耗 ${cost.amount} ${resource.unit}，还缺 ${cost.amount - resource.quantity} ${resource.unit}` });
  }
  for (const gain of action.gains) {
    const resource = byId.get(gain.resourceId);
    if (!resource) { unknown = true; continue; }
    const cost = action.costs.find((c) => c.resourceId === gain.resourceId)?.amount ?? 0;
    const excess = resource.quantity - cost + gain.amount - resource.capacity;
    if (excess > 0) unmetRequirements.push({ reason: 'resource-capacity', resourceId: resource.id,
      message: `${resource.name}当前为 ${resource.quantity} ${resource.unit}，容量为 ${resource.capacity} ${resource.unit}，本次净增加 ${gain.amount - cost} ${resource.unit} 所需的空间还缺 ${excess} ${resource.unit}` });
  }
  const executable = unmetRequirements.length ? false : unknown ? null : true;
  if (unknown) unmetRequirements.push({ reason: 'requirements-not-visible', message: '部分行动条件当前不可见，无法确认是否能执行' });
  return { requires: (action.requires ?? []).filter((c) => byId.has(c.resourceId)).map(clone), executable, unmetRequirements };
}

export function stepGeneratedWorld(world) {
  const errors = validateGeneratedWorld(world);
  if (errors.length) throw new Error(`invalid-generated-world:${errors[0].path}`);
  const startingResources = new Map(world.resources.map((r) => [r.id, r]));
  // Resolve every gate against the same minute-start state before any settlement.
  const processes = [...world.processes].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map((process) => {
    const conditions = process.when ?? [];
    const unmet = conditions.filter((c) => !conditionMet(c, startingResources.get(c.resourceId)));
    const active = unmet.length === 0;
    return { id: process.id, resourceId: process.resourceId, active, requestedDelta: active ? process.deltaPerMinute : 0,
      reason: !conditions.length ? 'unconditional' : active ? 'conditions-met' : 'conditions-not-met',
      message: active ? (conditions.length ? '分钟开始时所有运行条件均已满足。' : '未设置运行条件，持续运行。')
        : `${unmet.map((c) => conditionMessage(c, startingResources.get(c.resourceId))).join('；')}，本分钟未运行。` };
  });
  const next = clone(world);
  const settlements = next.resources.map((resource) => {
    const requestedDelta = processes.filter((p) => p.resourceId === resource.id).reduce((sum, p) => sum + p.requestedDelta, 0);
    const before = resource.quantity;
    const desired = before + requestedDelta;
    resource.quantity = clamp(desired, 0, resource.capacity);
    return { resourceId: resource.id, before, requestedDelta, appliedDelta: resource.quantity - before, after: resource.quantity,
      overflow: Math.max(0, desired - resource.capacity), unmetDemand: Math.max(0, -desired) };
  });
  return { world: next, event: { type: 'continuous_step', settlements, processes } };
}

export function applyGeneratedAction(world, action, { actorId = null, source = 'author', decisionId = null, worldMinute = 0 } = {}) {
  const actor = world.actors.find((a) => a.id === actorId);
  const who = actor?.name ?? '居民';
  if (!record(action) || !Object.hasOwn(GENERATED_ACTION_FIELDS, action.type)) return fail('unsupported-action', `${who}未能行动：这个世界不支持所请求的行动。`);
  if (!exact(action, ['type', ...GENERATED_ACTION_FIELDS[action.type]])) return fail('invalid-action-fields', `${who}未能行动：行动参数不符合规定。`);
  if (!actor) return fail(actorId === null ? 'actor-required' : 'unknown-actor', actorId === null ? '行动未执行：需要指定一位居民。' : '行动未执行：找不到这位居民。');
  if (action.type === 'moveTo' && !world.places.some((p) => p.id === action.location)) return fail('invalid-location', `${who}未能移动：目的地不存在。`);
  const story=world.story;
  if (story && action.type === 'moveTo' && action.location!==actor.location && !story.connections.some(c=>(c.from===actor.location&&c.to===action.location)||(c.to===actor.location&&c.from===action.location))) return fail('room-not-connected', `${who}未能移动：当前位置与目的地没有直接相连的通路。`);
  if (['speak','inspect'].includes(action.type) && !story) return fail('story-required', `${who}未能${action.type === 'speak' ? '发言' : '检查线索'}：这个世界尚未定义相应的信息规则。`);
  if (action.type==='speak' && !text(action.text,500)) return fail('invalid-speech', `${who}未能发言：需要一段非空且不超过500字的文字。`);
  const clue=action.type==='inspect'?story.clues.find(c=>c.id===action.clueId):null;
  if (action.type==='inspect' && (!clue || clue.location!==actor.location)) return fail('clue-not-present', `${who}未能检查线索：当前位置没有这件可检查的线索。`);
  const selected = action.type === 'perform' ? world.actions.find((a) => a.id === action.actionId) : null;
  if (action.type === 'perform' && (!selected || !executableAction(selected, actorId))) return fail('action-unavailable', `${who}未能执行行动：当前无法确认这项行动可执行。`);
  // A failed attempt never moves the actor, changes fatigue or touches resources.
  if (selected) {
    const { visible } = generatedVisibility(world, actor);
    if (!visibleAction(world, selected, actorId, visible)) return fail('action-unavailable', `${who}未能执行行动：当前无法确认这项行动可执行。`);
    const visibleResources = world.resources.filter((resource) => visibleResource(world, resource, actorId, visible));
    const availability = actionAvailability(selected, visibleResources);
    if (availability.executable !== true) return fail(availability.unmetRequirements[0].reason,
      `${who}未能完成「${selected.name}」：${availability.unmetRequirements.map((r) => r.message).join('；')}。`);
  }
  const next = clone(world);
  const nextActor = next.actors.find((a) => a.id === actorId);
  const effects = { resources: [] };
  if (selected) {
    const before = new Map(next.resources.map((r) => [r.id, r.quantity]));
    for (const cost of selected.costs) next.resources.find((r) => r.id === cost.resourceId).quantity -= cost.amount;
    for (const gain of selected.gains) next.resources.find((r) => r.id === gain.resourceId).quantity += gain.amount;
    effects.resources = next.resources.filter((r) => r.quantity !== before.get(r.id)).map((r) => ({ resourceId: r.id, before: before.get(r.id), after: r.quantity }));
    nextActor.location = selected.location;
  }
  if (action.type === 'moveTo') nextActor.location = action.location;
  if (action.type==='speak') {
    const statement={id:`statement-${next.story.conversations.length+1}`,speakerId:actorId,location:actor.location,minute:worldMinute,text:action.text.trim(),listeners:world.actors.filter(a=>a.id!==actorId&&a.location===actor.location).map(a=>a.id)};
    next.story.conversations.push(statement);effects.statement=clone(statement);
  }
  if (action.type==='inspect') {
    const found=next.story.clues.find(c=>c.id===action.clueId);
    if(!found.discoveredBy.includes(actorId))found.discoveredBy.push(actorId);
    effects.discovery={clueId:found.id,actorId,detail:found.detail};
  }
  nextActor.fatigue = clamp(nextActor.fatigue + ({ rest: -12, observe: 0, moveTo: 1, perform: 2, speak:0, inspect:1 }[action.type]), 0, 100);
  const placeName = (location) => world.places.find((p) => p.id === location).name;
  let message;
  switch (action.type) {
    case 'perform': {
      const changes = effects.resources.map((effect) => {
        const resource = world.resources.find((r) => r.id === effect.resourceId);
        return `${resource.name} ${effect.before} → ${effect.after} ${resource.unit}`;
      });
      message = `${who}在${placeName(nextActor.location)}完成了「${selected.name}」${changes.length ? `：${changes.join('；')}` : ''}。`;
      break;
    }
    case 'moveTo': message = actor.location === nextActor.location ? `${who}留在${placeName(actor.location)}。` : `${who}从${placeName(actor.location)}前往${placeName(nextActor.location)}。`; break;
    case 'rest': message = `${who}在${placeName(actor.location)}休息，疲劳 ${actor.fatigue} → ${nextActor.fatigue}。`; break;
    case 'observe': message = `${who}在${placeName(actor.location)}观察了周围。`; break;
    case 'speak': message = `${who}在${placeName(actor.location)}发言。`; break;
    // The public result identifies the act, never the private discovery's detail.
    case 'inspect': message = `${who}在${placeName(actor.location)}检查了「${clue.name}」。`; break;
  }
  const result = { ok: true, message };
  return { world: next, result, event: { ...clone(action), actorId, source, decisionId, result: clone(result), effects } };
}

export function observeGeneratedResident(snapshot, actorId) {
  const { world, worldMinute } = snapshot;
  const actor = world.actors.find((a) => a.id === actorId);
  if (!actor) throw new Error('unknown-resident');
  const { places, visible } = generatedVisibility(world, actor);
  const resources = world.resources.filter((r) => visibleResource(world, r, actorId, visible));
  const resourceIds = new Set(resources.map((r) => r.id));
  return {
    profile: 'generated-world', worldMinute, actorId: actor.id, name: actor.name, role: actor.role, goal: actor.goal,
    background: actor.background, location: actor.location, fatigue: actor.fatigue,
    environment: { weather: world.environment.weather },
    // Place descriptions and the opening premise are author-facing prose. They
    // may summarize hidden dramatic context, so resident prompts receive only
    // stable place identity and position. Public facts belong in story.facts.
    places: places.map((p) => ({ id: p.id, name: p.name, ...(world.story ? {} : { description: p.description }), position: clone(p.position) })),
    resources: resources.map((r) => ({ id: r.id, name: r.name, unit: r.unit, location: r.location, quantity: r.quantity, capacity: r.capacity })),
    availableActions: world.actions.filter((a) => visibleAction(world, a, actorId, visible) && executableAction(a, actorId)).map((a) => ({ id: a.id, name: a.name, description: a.description, location: a.location,
      costs: a.costs.filter((e) => resourceIds.has(e.resourceId)).map((e) => ({ resourceId: e.resourceId, amount: e.amount })),
      gains: a.gains.filter((e) => resourceIds.has(e.resourceId)).map((e) => ({ resourceId: e.resourceId, amount: e.amount })),
      ...(Object.hasOwn(a, 'requires') ? actionAvailability(a, resources) : {}) })),
    neighbors: world.actors.filter((a) => a.id !== actorId && visible.has(a.location)).map((a) => ({ id: a.id, name: a.name, role: a.role, location: a.location })),
    ...(world.story ? {story:{
      knownFacts:world.story.facts.filter(f=>f.knownBy.includes(actorId)).map(f=>({id:f.id,text:f.text})),
      visibleClues:world.story.clues.filter(c=>c.location===actor.location).map(c=>({id:c.id,name:c.name,location:c.location})),
      knownClues:world.story.clues.filter(c=>c.discoveredBy.includes(actorId)).map(c=>({id:c.id,name:c.name,location:c.location,detail:c.detail})),
      statements:world.story.conversations.filter(s=>s.speakerId===actorId||s.listeners.includes(actorId)).slice(-20).map(clone)
    }} : {}),
  };
}

// Public deterministic example for injected tests and generation prompts. It is
// never selected as a substitute for missing/invalid model-generated output.
export function createGeneratedFixture() {
  const places = [
    { id: 'observatory', name: '潮汐观测台', description: '记录海雾中的星光。', position: [-4, 0.8, 3], visibleFrom: ['harbor'] },
    { id: 'harbor', name: '风帆码头', description: '海风驱动蓄能装置。', position: [4, 0.8, 3], visibleFrom: ['observatory'] },
    { id: 'archive', name: '地下星图库', description: '从外面看不见的星图保管处。', position: [0, 0.8, -5], visibleFrom: [] },
  ];
  return {
    schemaVersion: 1,
    world: {
      profile: 'generated-world', title: '雾海星图站', description: '一座依靠海风蓄能、记录星图的海岛观测站。', environment: { weather: '海雾与持续海风' }, places,
      actors: [
        { id: 'mira', name: '米拉', role: '观星员', goal: '在能量耗尽前留下星图。', background: '曾在雾中迷航，依靠星图找到归途。', location: 'observatory', fatigue: 15 },
        { id: 'sen', name: '森', role: '守档员', goal: '保管未公开的旧航线。', background: '独自守着地下档案。', location: 'archive', fatigue: 8 },
      ],
      resources: [
        { id: 'charge', name: '风能电池', unit: '格', location: 'observatory', quantity: 5, capacity: 12 },
        { id: 'charts', name: '星图', unit: '张', location: 'observatory', quantity: 0, capacity: 20 },
        { id: 'seals', name: '档案封签', unit: '枚', location: 'archive', quantity: 3, capacity: 10 },
      ],
      processes: [{ id: 'wind-charge', description: '海风每分钟补充两格电能。', resourceId: 'charge', deltaPerMinute: 2 }],
      actions: [{ id: 'record-chart', name: '记录星图', description: '消耗三格电能绘制一张星图。', location: 'observatory', costs: [{ resourceId: 'charge', amount: 3 }], gains: [{ resourceId: 'charts', amount: 1 }] }],
    },
    scene: {
      schemaVersion: 1, profile: 'world', id: 'mist-observatory', title: '雾海星图站', style: { palette: 'wetland-sage', voxelUnit: 0.42, seed: 83 },
      regions: [
        { id: 'water', kind: 'water', center: [0, 0], size: [200, 200], elevation: -0.43 },
        { id: 'island', kind: 'island', center: [0, 0], radius: 16, elevation: 0.8, irregularity: 0.04 },
      ],
      objects: [
        { id: 'archive-building', kind: 'house', name: '星图库', transform: { position: [0, 0, -8], rotation: 0 }, bounds: { width: 5, depth: 4, wallHeight: 3, floor: 0.8 }, roof: { kind: 'gable', rise: 1.3, overhang: 0.4 }, entrance: { wall: 'front', width: 1.5, height: 2.3 } },
        { id: 'observatory-path', kind: 'path', name: '观星步道', points: [[-4, 3], [4, 3]], width: 1 },
        { id: 'harbor-tree', kind: 'tree', position: [9, 0.8, -2], scale: 0.3, seed: 5 },
        { id: 'mira', kind: 'character', name: '米拉', position: clone(places[0].position) },
        { id: 'sen', kind: 'character', name: '森', position: clone(places[2].position) },
      ],
    },
    initialMemories: [{ actorId: 'mira', text: '上次海雾散开时，东方曾露出一颗明亮的星。' }, { actorId: 'sen', text: '旧航线还没有获准公开。' }],
  };
}
