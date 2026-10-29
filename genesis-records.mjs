import { parseGeneratedJSON } from './model/generated-json.mjs';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim() && value.length <= 2000;
function exact(value, fields, optional = []) {
  if (!object(value) || Object.keys(value).some(key => !fields.includes(key) && !optional.includes(key))
    || fields.some(f => !Object.hasOwn(value, f))) throw Error(`生成条目 ${value?.type ?? 'unknown'} 的字段不完整或包含未支持字段。`);
}

// Frame complete JSON objects, including strings containing paragraph breaks.
// A missing closing delimiter is never guessed; all records must be complete.
export function parseGenesisOutput(content, { partial = false } = {}) {
  try {
    const legacy = parseGeneratedJSON(content);
    if (legacy.value?.schemaVersion !== undefined) return legacy;
  } catch {}
  let input = content.trim();
  const fence = /^```(?:jsonl|ndjson|json)?\s*\n?([\s\S]*?)\n?```$/i.exec(input);
  if (fence) input = fence[1].trim();
  let depth = 0, start = -1, quoted = false, escaped = false;
  const records = [], adjustments = [];
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (start < 0) {
      if (/\s/.test(c)) continue;
      if (c !== '{') throw Error('生成结果中出现了非条目文字，请继续讨论后重新生成。');
      start = i; depth = 1; continue;
    }
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
    if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const parsed = parseGeneratedJSON(input.slice(start, i + 1));
        const record = parsed.value;
        if (['resource', 'action'].includes(record?.type) && object(record.visibility)) {
          for (const [missing, supplied] of [['clues','actors'],['actors','clues']]) {
            if (!Object.hasOwn(record.visibility, missing) && Array.isArray(record.visibility[supplied]) && record.visibility[supplied].length) {
              record.visibility[missing] = [];
              adjustments.push(`${record.type} ${record.id} 的 visibility.${missing} 未提供，按无额外可见对象整理为空数组`);
            }
          }
        }
        records.push(record); adjustments.push(...parsed.adjustments);
        if (records.length > 80) throw Error('这一片起点包含过多条目，请缩小范围。');
        start = -1;
      }
    }
  }
  if (start >= 0 || records.length === 0) throw Error('生成条目尚未完整结束，没有建立世界。');
  return partial ? { records, adjustments } : { value: compileGenesisRecords(records), adjustments };
}

export const GENESIS_STAGES = [
  { id: 'places', label: '正在整理地点', types: ['world', 'place', 'connection'] },
  { id: 'people', label: '正在安排人物与前史', types: ['actor', 'memory', 'fact', 'clue'] },
  { id: 'rules', label: '正在落实运行规律', types: ['resource', 'process', 'action'] },
];

export function readGenesisStage(records, stage, previous = []) {
  if (!Array.isArray(records) || !records.length || records.at(-1)?.type !== 'complete' || Object.keys(records.at(-1)).length !== 1) throw Error('这一步尚未完整结束，没有建立世界。');
  const content = records.slice(0, -1);
  if (content.some(r => !object(r) || !stage.types.includes(r.type))) throw Error('这一步包含了其他步骤的条目，没有采用。');
  const of = type => content.filter(r => r.type === type);
  if (stage.id === 'places' && (of('world').length !== 1 || of('place').length < 1 || of('place').length > 4)) throw Error('这一片起点需要一份世界说明和1至4处地点。');
  if (stage.id === 'people') {
    if (of('actor').length < 1 || of('actor').length > 4) throw Error('这一片起点需要1至4位人物。');
    const placeIds = new Set(previous.filter(r => r.type === 'place').map(r => r.id));
    if (of('actor').some(a => !placeIds.has(a.location))) throw Error('人物的起始地点不在已生成的地点中。');
  }
  return content;
}

export function compileGenesisRecords(records) {
  const allowed = new Set(['world', 'place', 'actor', 'resource', 'process', 'action', 'connection', 'fact', 'clue', 'memory']);
  if (records.some(r => !object(r) || !allowed.has(r.type))) throw Error('生成包含未支持的条目类型。');
  const group = type => records.filter(r => r.type === type).map(({ type, ...value }) => value);
  const metas = group('world');
  if (metas.length !== 1) throw Error('起点必须有且只有一份世界说明。');
  const meta = metas[0]; exact(meta, ['title', 'description', 'weather', 'premise', 'landscape']);
  if (![meta.title, meta.description, meta.weather, meta.premise].every(nonempty) || !['coast', 'inland'].includes(meta.landscape)) throw Error('世界说明或地形选择不完整。');
  const spaces = group('place');
  if (spaces.length < 1 || spaces.length > 4) throw Error('先确认1至4处地点作为起点，之后再讨论扩大。');
  const used = new Set(), objects = [];
  const places = spaces.map(space => {
    exact(space, ['id', 'name', 'description', 'space', 'grid', 'landmark']);
    if (!['room', 'outdoor'].includes(space.space) || !['none', 'house', 'trees'].includes(space.landmark)
      || !Array.isArray(space.grid) || space.grid.length !== 2 || !space.grid.every(n => Number.isInteger(n) && Math.abs(n) <= 2)) throw Error(`地点 ${space.name ?? space.id} 的空间定义无效。`);
    if (used.has(space.grid.join(','))) throw Error(`地点 ${space.name ?? space.id} 与另一处占据相同位置。`);
    used.add(space.grid.join(','));
    const [x, z] = space.grid.map(n => n * 10);
    const place = { id: space.id, name: space.name, description: space.description, position: [x, 0.8, z], visibleFrom: [] };
    if (space.space === 'room') {
      if (space.landmark !== 'none') throw Error('室内地点不应另附户外建筑或树丛。');
      place.roomId = `space-${space.id}`;
      objects.push({ id: place.roomId, kind: 'room', name: space.name, transform: { position: [x, 0, z], rotation: 0 }, bounds: { width: 7, depth: 7, wallHeight: 2.8, floor: 0.8 } });
    } else if (space.landmark === 'house') {
      objects.push({ id: `landmark-${space.id}`, kind: 'house', name: space.name, transform: { position: [x, 0, z - 4], rotation: 0 },
        bounds: { width: 5, depth: 4, wallHeight: 3, floor: 0.8 }, roof: { kind: 'gable', rise: 1.3, overhang: 0.4 }, entrance: { wall: 'front', width: 1.5, height: 2.3 } });
    } else if (space.landmark === 'trees') {
      for (const offset of [-3, 3]) objects.push({ id: `tree-${space.id}-${offset < 0 ? 'a' : 'b'}`, kind: 'tree', position: [x + offset, 0.8, z - 3], scale: 0.3, seed: offset + 4 });
    }
    return place;
  });
  const actors = group('actor');
  if (actors.length < 1 || actors.length > 4) throw Error('这一片起点先容纳1至4位人物。');
  for (const actor of actors) {
    const place = places.find(p => p.id === actor.location);
    if (!place) throw Error(`人物 ${actor.name ?? actor.id} 的起始地点不存在。`);
    objects.push({ id: actor.id, kind: 'character', name: actor.name, position: [...place.position] });
  }
  const world = { profile: 'generated-world', title: meta.title, description: meta.description, environment: { weather: meta.weather }, places, actors,
    resources: group('resource'), processes: group('process'), actions: group('action'),
    story: { premise: meta.premise, connections: group('connection'), facts: group('fact'), clues: group('clue'), conversations: [] } };
  const radius = Math.max(9, ...places.map(p => Math.hypot(p.position[0], p.position[2]) + 8));
  const scene = { schemaVersion: 1, profile: 'world', id: 'generated-origin', title: meta.title,
    style: { palette: 'wetland-sage', voxelUnit: 0.6, seed: 73 },
    regions: [
      ...(meta.landscape === 'coast' ? [{ id: 'sea', kind: 'water', center: [0, 0], size: [100, 100], elevation: -0.4 }] : []),
      { id: 'ground', kind: 'island', center: [0, 0], radius, elevation: 0.8, irregularity: 0 },
    ], objects };
  return { schemaVersion: 1, world, scene, initialMemories: group('memory') };
}
