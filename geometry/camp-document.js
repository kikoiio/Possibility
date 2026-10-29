// Persistent appearance only. World resources and station semantics are not editable here.
export const CAMP_LOCATIONS = Object.freeze({
  cabin: Object.freeze([0.55, 4.69, 0.66]), terrace: Object.freeze([-0.9, 4.69, 1.12]),
  garden: Object.freeze([0.3, 4.69, 1.16]), tank: Object.freeze([2.46, 4.69, -0.12]), lookout: Object.freeze([-2.5, 4.69, 0.35]),
});
export const CAMP_COLORS = Object.freeze({
  moss: '#8fa36c', belly: '#7c925e', face: '#a5b77d', foot: '#6e865b', mossDark: '#66854e',
  mossLight: '#a9ba7c', horn: '#d4cda7', eye: '#273f36', glint: '#fff4cf', blush: '#b9b283',
  wood: '#a78153', plank: '#bb9563', plankAlt: '#ae8858', rail: '#c8a777', darkWood: '#765e43',
  wall: '#b79564', roof: '#527d70', roofEdge: '#7b9b7d', iron: '#506e64', strap: '#dacb9e',
  lamp: '#ffda92', tank: '#90aaa1', water: '#60a9ad', tankGlass: '#c5ddd0', soil: '#67543e',
  leaves: '#688e4e', canopy: '#e0d3a1', skin: '#dfb990', ihe: '#507e82', loran: '#bc8154', hair: '#62533d', boots: '#435850',
});
const SPECS = [
  ['beast', 'beast', [0, 0, 0], ['moss', 'belly', 'face', 'foot', 'mossDark', 'mossLight', 'horn', 'eye', 'glint', 'blush', 'darkWood']],
  ['deck', 'deck', [0, 4.69, 0], ['wood', 'plank', 'plankAlt', 'rail', 'darkWood']],
  ['cabin', 'cabin', [0.55, 4.69, 0.66], ['wall', 'wood', 'iron', 'darkWood', 'lamp', 'roof', 'roofEdge']],
  ['lookout', 'lookout', [-2.5, 4.69, 0.35], ['darkWood', 'canopy']],
  ['canopy', 'canopy', [0, 6.04, 1.03], ['canopy', 'rail']],
  ['tank', 'tank', [2.32, 4.7, -0.9], ['tank', 'tankGlass', 'water', 'iron', 'darkWood', 'strap', 'canopy']],
  ['garden', 'garden', [1.22, 4.7, 1.13], ['wood', 'soil', 'leaves']],
  ['cargo', 'cargo', [2.55, 4.7, 0.65], ['wood', 'darkWood', 'strap']],
  ['timber', 'timber', [1.2, 4.81, -1.42], ['wood', 'plank']],
  ['lamps', 'lamps', [0, 0, 0], ['iron', 'lamp']],
  ['resident-ihe', 'resident', [0, 0, 0], ['boots', 'ihe', 'skin', 'strap']],
  ['resident-loran', 'resident', [0, 0, 0], ['boots', 'loran', 'skin', 'hair']],
];
export function createCampSceneDocument() {
  return {
    schemaVersion: 1, profile: 'beast-camp', id: 'beast-camp', title: '苔背上的日常',
    style: { palette: 'moss-camp' }, regions: [],
    objects: SPECS.map(([id, kind, position, colors]) => ({
      id, kind, position: [...position], colors: Object.fromEntries(colors.map(key => [key, CAMP_COLORS[key]])),
      ...(id === 'cabin' ? { roof: { kind: 'gable', rise: 0.61, overhang: 0.2 } } : {}),
    })),
  };
}
// Always returns structured diagnostics for JSON-shaped inputs, including null/primitives.
export function validateCampSceneDocument(document) {
  const errors = [];
  const fail = (id, req, message) => errors.push({ nodeId: id || 'document', operationId: 'validate-camp-document', requirementId: req, message });
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const keys = (value, allowed, id) => { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(id, 'camp.static-only', `不支持字段 ${key}；文档仅控制静态造型`); };
  if (!record(document)) { fail('document', 'document.shape', '场景必须是 JSON 对象'); return errors; }
  keys(document, ['schemaVersion', 'profile', 'id', 'title', 'style', 'regions', 'objects'], 'document');
  if (document.schemaVersion !== 1) fail('document', 'document.schemaVersion', '只支持 schemaVersion=1');
  if (document.profile !== 'beast-camp') fail('document', 'document.profile', '需要 beast-camp profile');
  if (typeof document.id !== 'string' || !document.id || document.id.length > 100) fail('document', 'document.id', '场景 id 无效');
  if (typeof document.title !== 'string' || !document.title.trim() || document.title.length > 120) fail('document', 'document.title', '标题须为 1 到 120 字符');
  if (!record(document.style) || document.style.palette !== 'moss-camp') fail('document', 'camp.style', '需要 moss-camp 调色板');
  else keys(document.style, ['palette'], 'document');
  if (!Array.isArray(document.regions) || document.regions.length !== 0) fail('document', 'camp.regions', '营地不允许生成世界区域');
  if (!Array.isArray(document.objects)) { fail('document', 'document.collections', 'objects 必须是数组'); return errors; }
  if (document.objects.length !== SPECS.length) fail('document', 'camp.objects', '必须保留全部固定营地物件');
  const seen = new Set();
  for (const node of document.objects) {
    if (!record(node)) { fail('document', 'node.shape', '物件必须是对象'); continue; }
    const spec = SPECS.find(([id]) => id === node.id);
    const id = typeof node.id === 'string' ? node.id : 'document';
    if (!spec || seen.has(id)) { fail(id, 'node.identity', '物件 id 未知或重复'); continue; }
    seen.add(id);
    const [, kind, position, colors] = spec;
    keys(node, ['id', 'kind', 'position', 'colors', ...(id === 'cabin' ? ['roof'] : [])], id);
    if (node.kind !== kind) fail(id, 'object.kind', '固定物件的 kind 不可更换');
    if (!Array.isArray(node.position) || node.position.length !== 3 || !position.every((v, i) => node.position[i] === v)) fail(id, 'camp.station.position', '固定站点位置不可更改');
    if (!record(node.colors)) fail(id, 'camp.colors', 'colors 必须是颜色对象');
    else {
      keys(node.colors, colors, id);
      for (const key of colors) if (typeof node.colors[key] !== 'string' || !/^#[\da-f]{6}$/i.test(node.colors[key])) fail(id, 'camp.color', `${key} 必须是 #RRGGBB 颜色`);
    }
    if (id === 'cabin') {
      const roof = node.roof;
      if (!record(roof)) fail(id, 'camp.roof', '需要 roof 对象');
      else {
        keys(roof, ['kind', 'rise', 'overhang'], id);
        if (!['gable', 'flat'].includes(roof.kind) || !Number.isFinite(roof.rise) || roof.rise < 0.2 || roof.rise > 0.9 || !Number.isFinite(roof.overhang) || roof.overhang < 0.05 || roof.overhang > 0.3) fail(id, 'camp.roof', '屋顶支持 gable/flat，rise 0.2–0.9，overhang 0.05–0.3');
      }
    }
  }
  for (const [id] of SPECS) if (!seen.has(id)) fail(id, 'camp.station.required', '缺少固定营地物件');
  return errors;
}
