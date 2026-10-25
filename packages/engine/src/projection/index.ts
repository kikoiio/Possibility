import type { Entity, Minutes, RendererView, ViewCharacter, ViewNode, WorldState } from '@wispiva/contract';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
export type SceneStyle = { palette: string; voxelUnit: number; seed: number };
export type WaterRegion = { id: string; kind: 'water'; center: Vec2; size: Vec2; elevation: number };
export type IslandRegion = { id: string; kind: 'island'; center: Vec2; radius: number; elevation: number; irregularity: number };
export type SceneRegion = WaterRegion | IslandRegion;
export type SceneTransform = { position: Vec3; rotation: number };
export type SceneBounds = { width: number; depth: number; floor: number; wallHeight?: number };
export type SceneRoof = { kind: 'gable'; rise: number; overhang: number };
export type SceneEntrance = { wall: 'front'; width: number; height: number };
export type SceneWindow = { wall: 'front'; offset: number };
export type SceneAttachment = { target: string; relation: string };
export type LibraryObject = { id: string; kind: 'library'; name: string; transform: SceneTransform; bounds: SceneBounds & { wallHeight: number }; roof: SceneRoof; entrance: SceneEntrance; windows: SceneWindow[]; parts: string[]; attachments: SceneAttachment[] };
export type HouseObject = { id: string; kind: 'house'; name: string; transform: SceneTransform; bounds: SceneBounds & { wallHeight: number }; roof: SceneRoof; entrance: SceneEntrance; windows?: SceneWindow[] };
export type PorchObject = { id: string; kind: 'porch'; name: string; transform: SceneTransform; bounds: SceneBounds; attachments: SceneAttachment[] };
export type BridgeObject = { id: string; kind: 'bridge'; name: string; from: { region: string; point: Vec3 }; to: { region: string; point: Vec3 }; width: number; arch: number; segments: number };
export type TreeObject = { id: string; kind: 'tree'; name: string; position: Vec3; scale: number; seed: number };
export type PathObject = { id: string; kind: 'path'; name: string; points: Vec2[]; width: number };
export type CharacterObject = { id: string; kind: 'character'; name: string; position: Vec3; route?: Vec2[]; speed?: number };
export type SceneObject = LibraryObject | HouseObject | PorchObject | BridgeObject | TreeObject | PathObject | CharacterObject;
export type SceneDocument = { schemaVersion: 1; id: string; title: string; style: SceneStyle; regions: SceneRegion[]; objects: SceneObject[] };

const placeKinds = new Set(['place', 'library', 'house', 'porch', 'bridge', 'water', 'island']);
const finite = (value: unknown, fallback: number): number => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const tuple = (value: unknown, length: 2 | 3): number[] | null => Array.isArray(value) && value.length >= length && value.slice(0, length).every(item => typeof item === 'number' && Number.isFinite(item)) ? value.slice(0, length) as number[] : null;
const vec2 = (value: unknown, fallback: Vec2): Vec2 => (tuple(value, 2) ?? fallback) as Vec2;
const vec3 = (value: unknown, fallback: Vec3): Vec3 => (tuple(value, 3) ?? fallback) as Vec3;
const entries = (world: WorldState): [string, Entity][] => Object.entries(world.entities ?? {});
const entityPosition = (entity: Entity): Vec3 => {
  const p = tuple(entity.position, 3);
  return p ? p as Vec3 : [finite(entity.x, 0), finite(entity.y, 0.8), finite(entity.z, 0)];
};

function viewNode(id: string, entity: Entity): ViewNode {
  const position = entityPosition(entity);
  return {
    id, kind: entity.kind, name: typeof entity.name === 'string' ? entity.name : id,
    x: finite(entity.x, position[0]), z: finite(entity.z, position[2]),
    width: finite(entity.width, entity.kind === 'character' ? 0.8 : 1),
    depth: finite(entity.depth, entity.kind === 'character' ? 0.8 : 1),
    height: finite(entity.height, entity.kind === 'character' ? 1.7 : 1),
  };
}

function regionEntries(items: [string, Entity][]): SceneRegion[] {
  const regions: SceneRegion[] = [];
  for (const [id, entity] of items) {
    const extra = record(entity.region);
    if (entity.kind === 'water') regions.push({ id, kind: 'water', center: vec2(extra.center ?? entity.center, [finite(entity.x, 0), finite(entity.z, 0)]), size: vec2(extra.size ?? entity.size, [Math.max(1, finite(entity.width, 200)), Math.max(1, finite(entity.depth, 200))]), elevation: finite(extra.elevation ?? entity.elevation, finite(entity.height, -0.43)) });
    if (entity.kind === 'island') regions.push({ id, kind: 'island', center: vec2(extra.center ?? entity.center, [finite(entity.x, 0), finite(entity.z, 0)]), radius: finite(extra.radius ?? entity.radius, Math.max(1, finite(entity.width, 24) / 2)), elevation: finite(extra.elevation ?? entity.elevation, finite(entity.height, 0.8)), irregularity: finite(extra.irregularity ?? entity.irregularity, 0.04) });
  }
  if (!regions.some(region => region.kind === 'water')) regions.unshift({ id: 'water', kind: 'water', center: [0, 0], size: [2000, 2000], elevation: -0.43 });
  if (!regions.some(region => region.kind === 'island')) regions.push({ id: 'island', kind: 'island', center: [0, 0], radius: 30, elevation: 0.8, irregularity: 0.04 });
  return regions;
}

function sceneObjects(items: [string, Entity][], regions: SceneRegion[]): SceneObject[] {
  const objects: SceneObject[] = [];
  const islandIds = regions.filter((region): region is IslandRegion => region.kind === 'island').map(region => region.id);
  const island = islandIds[0] ?? 'island';
  const landing = islandIds[1] ?? island;
  for (const [id, entity] of items) {
    const kind = entity.kind === 'place' ? 'library' : entity.kind;
    const extra = record(entity);
    const transformValue = record(extra.transform);
    const position = vec3(transformValue.position ?? extra.position, [finite(extra.x, 0), finite(extra.y, 0), finite(extra.z, 0)]);
    const rotation = finite(transformValue.rotation ?? extra.rotation, 0);
    const boundsValue = record(extra.bounds);
    const bounds = {
      width: finite(boundsValue.width ?? extra.width, kind === 'porch' ? 6.5 : kind === 'library' ? 9 : 4.6),
      depth: finite(boundsValue.depth ?? extra.depth, kind === 'porch' ? 2.6 : kind === 'library' ? 7 : 3.6),
      floor: finite(boundsValue.floor, kind === 'porch' ? 1.32 : kind === 'library' ? 1.48 : 1.1),
    };
    const name = typeof extra.name === 'string' ? extra.name : id;
    if (kind === 'library' || kind === 'house') {
      const roof = record(extra.roof), entrance = record(extra.entrance);
      const building = {
        id, name, transform: { position, rotation },
        bounds: { ...bounds, wallHeight: finite(boundsValue.wallHeight ?? extra.height, kind === 'library' ? 4.7 : 3.1) },
        roof: { kind: 'gable' as const, rise: finite(roof.rise, 1.3), overhang: finite(roof.overhang, 0.4) },
        entrance: { wall: 'front' as const, width: finite(entrance.width, kind === 'library' ? 2.6 : 1.5), height: finite(entrance.height, kind === 'library' ? 3.8 : 2.3) },
      };
      if (kind === 'library') objects.push({ ...building, kind, windows: Array.isArray(extra.windows) ? extra.windows as SceneWindow[] : [], parts: ['walls', 'roof', 'bookshelves', 'reading-table', 'lamp'], attachments: [{ target: 'porch', relation: 'front-door' }] });
      else objects.push({ ...building, kind, ...(Array.isArray(extra.windows) ? { windows: extra.windows as SceneWindow[] } : {}) });
    } else if (kind === 'porch') objects.push({ id, kind, name, transform: { position, rotation }, bounds, attachments: [{ target: 'library', relation: 'entrance' }] });
    else if (kind === 'bridge') {
      const fromValue = record(extra.from), toValue = record(extra.to);
      const route = Array.isArray(extra.route) ? extra.route : [];
      const first = tuple(fromValue.point, 3) ?? (tuple(route[0], 3) ?? [finite(extra.x, 7), 0.9, finite(extra.z, 4.5)]);
      const last = tuple(toValue.point, 3) ?? (tuple(route[1], 3) ?? [16.5, 0.9, 6]);
      objects.push({ id, kind, name, from: { region: typeof fromValue.region === 'string' ? fromValue.region : island, point: first as Vec3 }, to: { region: typeof toValue.region === 'string' ? toValue.region : landing, point: last as Vec3 }, width: finite(extra.width, 2.25), arch: finite(extra.arch, 1.25), segments: Math.max(2, Math.floor(finite(extra.segments, 23))) });
    } else if (kind === 'tree') objects.push({ id, kind, name, position: vec3(extra.position, [finite(extra.x, 0), finite(extra.y, 0.8), finite(extra.z, 0)]), scale: finite(extra.scale, 0.35), seed: finite(extra.seed, 83) });
    else if (kind === 'path') {
      const rawPoints = Array.isArray(extra.points) ? extra.points : Array.isArray(extra.route) ? extra.route : [[finite(extra.x, 0), finite(extra.z, 0)], [finite(extra.x, 0) + 1, finite(extra.z, 0)]];
      const points = rawPoints.map(point => vec2(point, [0, 0]));
      objects.push({ id, kind, name, points, width: finite(extra.width, 1) });
    } else if (kind === 'character') {
      const route = Array.isArray(extra.route) ? extra.route.map(point => vec2(point, [0, 0])) : undefined;
      objects.push({ id, kind, name, position: entityPosition(entity), ...(route ? { route } : {}), ...(typeof extra.speed === 'number' ? { speed: extra.speed } : {}) });
    }
  }
  if (!objects.some(object => object.kind === 'library')) objects.push({ id: 'library', kind: 'library', name: '书院', transform: { position: [-3, 0, 0], rotation: 0 }, bounds: { width: 9, depth: 7, floor: 1.48, wallHeight: 4.7 }, roof: { kind: 'gable', rise: 2.65, overhang: 0.65 }, entrance: { wall: 'front', width: 2.6, height: 3.8 }, windows: [], parts: ['walls', 'roof', 'bookshelves', 'reading-table', 'lamp'], attachments: [{ target: 'porch', relation: 'front-door' }] });
  const hasPorch = objects.some(object => object.kind === 'porch');
  if (!hasPorch) objects.push({ id: 'porch', kind: 'porch', name: '门廊', transform: { position: [-3, 0, 4.8], rotation: 0 }, bounds: { width: 6.5, depth: 2.6, floor: 1.32 }, attachments: [{ target: 'library', relation: 'entrance' }] });
  if (!objects.some(object => object.kind === 'bridge')) objects.push({ id: 'bridge', kind: 'bridge', name: '木桥', from: { region: island, point: [7.2, 0.8, 4.5] }, to: { region: landing, point: [16.5, 0.8, 6] }, width: 2.25, arch: 1.25, segments: 23 });
  const library = objects.find((object): object is LibraryObject => object.kind === 'library')!;
  const porch = objects.find((object): object is PorchObject => object.kind === 'porch')!;
  if (!hasPorch) {
    const [x, y, z] = library.transform.position;
    const offset = library.bounds.depth / 2 + porch.bounds.depth / 2;
    porch.transform.position = [x + Math.sin(library.transform.rotation) * offset, y, z + Math.cos(library.transform.rotation) * offset];
    porch.transform.rotation = library.transform.rotation;
  }
  library.attachments = [{ target: porch.id, relation: 'front-door' }];
  porch.attachments = [{ target: library.id, relation: 'entrance' }];
  return objects;
}

export function projectWorld(world: WorldState, worldTimeMinutes: Minutes, revisionId: string, recentText: string | null): { scene: SceneDocument; view: RendererView } {
  const items = entries(world);
  const places: ViewNode[] = [];
  const characters: ViewCharacter[] = [];
  const others: ViewNode[] = [];
  for (const [id, entity] of items) {
    const node = viewNode(id, entity);
    if (entity.kind === 'character') {
      characters.push({ ...node, locationId: typeof entity.location === 'string' && world.entities[entity.location] ? entity.location : null });
    } else if (placeKinds.has(entity.kind)) places.push(node);
    else if (entity.kind !== 'path') others.push(node);
  }
  const regions = regionEntries(items);
  const scene: SceneDocument = {
    schemaVersion: 1, id: `scene-${revisionId}`, title: typeof world.name === 'string' ? world.name : 'Wispiva',
    style: { palette: 'wetland-sage', voxelUnit: 0.42, seed: 83 }, regions,
    objects: sceneObjects(items, regions),
  };
  const lineId = typeof world.lineId === 'string' ? world.lineId : 'line_alpha';
  return { scene, view: { lineId, revisionId, worldTimeMinutes, places, characters, others, recentText } };
}
