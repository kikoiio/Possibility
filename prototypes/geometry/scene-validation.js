export const findRegion = (document, id) => document?.regions?.find(region => region?.id === id);
export const findObject = (document, id) => document?.objects?.find(object => object?.id === id);
export function sceneLayout(document) {
  const objects = Array.isArray(document?.objects) ? document.objects.filter(Boolean) : [];
  const regions = Array.isArray(document?.regions) ? document.regions.filter(Boolean) : [];
  const bridge = objects.find(o => o.kind === 'bridge');
  return {
    water: regions.find(r => r.kind === 'water'),
    island: regions.find(r => r.id === bridge?.from?.region) || regions.find(r => r.kind === 'island'),
    landing: regions.find(r => r.id === bridge?.to?.region), islands: regions.filter(r => r.kind === 'island'),
    library: objects.find(o => o.kind === 'library'), porch: objects.find(o => o.kind === 'porch'), bridge,
    trees: objects.filter(o => o.kind === 'tree'),
  };
}
export const diagnostic = (nodeId, operationId, requirementId, message) => ({ nodeId, operationId, requirementId, message });
export const formatDiagnostic = e => `${e.message} (nodeId=${e.nodeId}, operationId=${e.operationId}, requirementId=${e.requirementId})`;

export function validateSceneDocument(document) {
  if (document?.profile === 'beast-camp') return validateCampSceneDocument(document);
  const errors = [];
  const fail = (id, requirement, message) => errors.push(diagnostic(id || 'document', 'validate-document', requirement, message));
  const number = (v, min, max = Infinity) => Number.isFinite(v) && v >= min && v <= max;
  const point = (v, length) => Array.isArray(v) && v.length === length && v.every(n => number(n, -10000, 10000));
  const world = document?.profile === 'world';
  if (!world && document?.profile !== undefined) fail('document', 'document.profile', `不支持 profile=${document.profile}`);
  if (!document || document.schemaVersion !== 1) fail('document', 'document.schemaVersion', '只支持 schemaVersion=1');
  if (typeof document?.id !== 'string' || !document.id) fail('document', 'document.id', '缺少场景 id');
  if (!Array.isArray(document?.regions) || !Array.isArray(document?.objects)) {
    fail('document', 'document.collections', 'regions 与 objects 必须是数组'); return errors;
  }
  if (world && (document.regions.length > 9 || document.objects.length > 128)) {
    fail('document', 'world.count', '世界最多 9 个区域、128 个物件'); return errors;
  }
  if (!number(document.style?.voxelUnit, 0.2, 1)) fail('document', 'style.voxelUnit', '体素单位必须在 0.2 到 1 之间');
  const ids = new Set();
  for (const [collection, kinds] of [['regions', ['water', 'island']], ['objects', ['library', 'porch', 'bridge', 'tree', 'house', 'path', 'character', 'room']]]) {
    for (const [i, node] of document[collection].entries()) {
      const id = node?.id || `${collection}[${i}]`;
      if (!node || typeof node !== 'object') { fail(id, 'node.shape', '节点必须是对象'); continue; }
      if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) fail(id, 'node.identity', '节点 id 缺失或重复');
      ids.add(node.id);
      if (!kinds.includes(node.kind)) fail(id, collection === 'objects' ? 'object.kind' : 'region.kind', `不支持 kind=${node.kind}`);
      const check = (condition, requirement, message) => { if (!condition) fail(id, requirement, message); };
      if (node.kind === 'room') {
        check(world, 'room.profile', 'room 仅支持 generated-world 的 world 场景');
        check(typeof node.name === 'string' && node.name.trim().length > 0 && node.name.length <= 80, 'room.name', 'room 需要 1 到 80 个字符的名称');
        check(point(node.transform?.position, 3) && number(node.transform?.rotation, -Math.PI * 2, Math.PI * 2), 'room.transform', '房间坐标/旋转无效');
        for (const axis of ['width', 'depth']) check(number(node.bounds?.[axis], 1, 30), `room.${axis}`, `${axis} 须为 1 到 30`);
        check(number(node.bounds?.floor, 0, 100), 'room.floor', '房间地板高程无效');
        check(number(node.bounds?.wallHeight, 1.8, 15), 'room.height', '房间墙高须在 1.8 到 15 之间');
      }
      if (collection === 'regions') {
        check(point(node.center, 2) && number(node.elevation, -100, 100), 'region.transform', '区域中心/高程无效');
        if (node.kind === 'water') check(point(node.size, 2) && node.size.every(v => v > 0 && v <= 4000), 'water.bounds', '水域尺寸无效');
        if (node.kind === 'island') {
          check(number(node.radius, 1, 40), 'region.radius', '岛屿半径须在 1 到 40 之间');
          check(number(node.irregularity, 0, 0.2), 'region.irregularity', '岛屿不规则系数须在 0 到 0.2 之间');
        }
      } else {
        if (['library', 'porch', 'house'].includes(node.kind)) {
          check(point(node.transform?.position, 3) && number(node.transform?.rotation, -Math.PI * 2, Math.PI * 2), 'object.transform', '物件坐标/旋转无效');
          for (const axis of ['width', 'depth']) check(number(node.bounds?.[axis], 0.5, 30), `object.${axis}`, `${axis} 须为 0.5 到 30`);
          check(number(node.bounds?.floor, 0, 100), 'object.floor', '地板高程无效');
        }
        if (node.kind === 'library' || node.kind === 'house') {
          check(number(node.bounds?.wallHeight, 2, 15), 'library.height', '墙高须在 2 到 15 之间');
          check(node.entrance?.wall === 'front', 'entrance.wall', '实验仅支持 front 入口');
          check(node.windows === undefined || (Array.isArray(node.windows) && node.windows.every(w => w && w.wall === 'front' && Number.isFinite(w.offset))), 'window.shape', '窗户须是带 front 朝向和有限偏移的数组');
          check(number(node.entrance?.width, 0.1, 30) && number(node.entrance?.height, 0.1, 15), 'entrance.dimensions', '入口尺寸无效');
          check(node.roof?.kind === 'gable' && number(node.roof?.rise, 0.1, 10) && number(node.roof?.overhang, 0, 2), 'roof.dimensions', '仅支持有效尺寸的 gable 屋顶');
        }
        if (node.kind === 'bridge') {
          for (const end of ['from', 'to']) {
            check(point(node[end]?.point, 3), `bridge.endpoint.${end}`, '桥端点坐标无效');
            check(document.regions.some(r => r?.id === node[end]?.region && r.kind === 'island'), `bridge.region.${end}`, '桥端点必须引用岛屿');
          }
          check(number(node.width, 0.4, 10), 'bridge.width', '桥宽须在 0.4 到 10 之间');
          check(number(node.arch, 0, 8), 'bridge.arch', '桥拱高度无效');
          check(Number.isInteger(node.segments) && number(node.segments, 2, 128), 'bridge.segments', '桥段数须为 2 到 128 的整数');
        }
        if (node.kind === 'tree') {
          check(point(node.position, 3), 'tree.position', '树坐标无效');
          check(number(node.scale, 0.2, 3), 'tree.scale', '树缩放须在 0.2 到 3 之间');
        }
        if (node.kind === 'path') {
          check(Array.isArray(node.points) && node.points.length >= 2 && node.points.length <= 64 && node.points.every(p => point(p, 2)), 'path.points', '路径需要 2 到 64 个有效坐标点');
          check(number(node.width, 0.4, 4), 'path.width', '路径宽度须在 0.4 到 4 之间');
        }
        if (node.kind === 'character') {
          check(point(node.position, 3), 'character.position', '角色坐标无效');
          if (node.roomId !== undefined) check(typeof node.roomId === 'string' && document.objects.some(object => object?.id === node.roomId && object.kind === 'room'), 'character.room', '角色 roomId 必须引用现有房间');
          if (node.route !== undefined) check(Array.isArray(node.route) && node.route.length >= 2 && node.route.length <= 64 && node.route.every(p => point(p, 2)), 'character.route', '角色路线需要 2 到 64 个有效 [x,z] 点');
        }
        if (node.attachments !== undefined && !Array.isArray(node.attachments)) fail(id, 'attachment.shape', 'attachments 必须是数组');
      }
    }
  }
  for (const kind of world ? [] : ['library', 'porch', 'bridge']) if (document.objects.filter(n => n?.kind === kind).length !== 1) fail('document', `scene.${kind}`, `实验需要恰好一个 ${kind}`);
  if (!world && document.regions.filter(n => n?.kind === 'water').length !== 1) fail('document', 'scene.water', '实验需要恰好一个水域');
  for (const [kind, max] of [['house', 12], ['room', world ? 24 : 0], ['path', world ? 16 : 8], ['tree', 24], ['character', world ? 32 : 12]]) {
    if (document.objects.filter(n => n?.kind === kind).length > max) fail('document', `scene.${kind}`, `${kind} 数量不能超过 ${max}`);
  }
  for (const node of document.objects.filter(Boolean)) for (const a of Array.isArray(node.attachments) ? node.attachments : []) {
    if (!a || !document.objects.some(n => n?.id === a.target)) fail(node.id, 'attachment.target', '连接目标不存在');
  }
  const { library, porch } = sceneLayout(document);
  if (!world && library && porch) for (const [node, target] of [[library, porch], [porch, library]]) {
    if (!Array.isArray(node.attachments) || !node.attachments.some(a => a?.target === target.id)) fail(node.id, 'attachment.required', '建筑与门廊必须双向连接');
  }
  if (world) errors.push(...validateWorldStructure(document));
  return errors;
}
export function islandRadius(region, angle) {
  return region.radius * (1 + region.irregularity * (Math.sin(angle * 3) + Math.cos(angle * 5) * 0.45));
}
export function islandContains(region, x, z, margin = 0) {
  const dx = x - region.center[0], dz = z - region.center[1];
  return Math.hypot(dx, dz) + margin <= islandRadius(region, Math.atan2(dz, dx));
}
export function bridgePoint(bridge, t) {
  return bridge.from.point.map((v, i) => v + (bridge.to.point[i] - v) * t + (i === 1 ? Math.sin(Math.PI * t) * bridge.arch : 0));
}
export function localToWorld(object, x, z) {
  const [px, , pz] = object.transform.position, a = object.transform.rotation;
  return [px + x * Math.cos(a) + z * Math.sin(a), pz - x * Math.sin(a) + z * Math.cos(a)];
}
export function rectAxes(object) {
  const a = object.transform?.rotation ?? 0;
  return [[Math.cos(a), -Math.sin(a)], [Math.sin(a), Math.cos(a)]];
}
export function rectCorners(object, extra = 0) {
  return [-1, 1].flatMap(x => [-1, 1].map(z =>
    localToWorld(object, x * (object.bounds.width / 2 + extra), z * (object.bounds.depth / 2 + extra))));
}
export function pointSegmentDistance(px, pz, a, b) {
  const vx = b[0] - a[0], vz = b[2] - a[2];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (pz - a[2]) * vz) / (vx * vx + vz * vz || 1)));
  return Math.hypot(px - (a[0] + vx * t), pz - (a[2] + vz * t));
}
export function pointInRect(object, px, pz, margin = 0) {
  const dx = px - object.transform.position[0], dz = pz - object.transform.position[2];
  const a = object.transform?.rotation ?? 0;
  return Math.abs(dx * Math.cos(a) - dz * Math.sin(a)) <= object.bounds.width / 2 + margin &&
    Math.abs(dx * Math.sin(a) + dz * Math.cos(a)) <= object.bounds.depth / 2 + margin;
}
export function rectsSeparated(a, b, gap) {
  const dx = b.transform.position[0] - a.transform.position[0], dz = b.transform.position[2] - a.transform.position[2];
  for (const rect of [a, b]) for (const [ux, uz] of rectAxes(rect)) {
    const extent = r => {
      const [ax, az] = rectAxes(r);
      return (r.bounds.width / 2 + gap / 2) * Math.abs(ux * ax[0] + uz * ax[1]) +
        (r.bounds.depth / 2 + gap / 2) * Math.abs(ux * az[0] + uz * az[1]);
    };
    if (Math.abs(dx * ux + dz * uz) > extent(a) + extent(b)) return true;
  }
  return false;
}
function pathSamples(path) {
  const samples = [];
  for (let i = 0; i < path.points.length - 1; i++) {
    const [ax, az] = path.points[i], [bx, bz] = path.points[i + 1];
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 0.5));
    for (let s = 0; s <= steps; s++) samples.push([ax + (bx - ax) * s / steps, az + (bz - az) * s / steps]);
  }
  return samples;
}
export function validateSpatialLayout(document) {
  if (validateSceneDocument(document).length) return [];
  // Camp stations and their origins are fixed by the profile validator. Actual
  // deck support is probed against compiled surfaces in compiled-spatial.js.
  if (document.profile === 'beast-camp') return [];
  if (document.profile === 'world') return validateWorldSpatialLayout(document);
  const errors = [];
  const { library, porch, bridge, islands, water, trees } = sceneLayout(document);
  const houses = document.objects.filter(o => o?.kind === 'house');
  const paths = document.objects.filter(o => o?.kind === 'path');
  const buildings = [library, porch, ...houses];
  const fail = (node, op, req, message) => errors.push(diagnostic(node.id, op, req, message));
  const unit = document.style.voxelUnit, e = library.entrance, b = library.bounds;
  if (e.width < Math.max(0.9, unit * 3) || e.height < 1.8 || e.width > b.width - 0.8 || e.height > b.wallHeight - 0.2) fail(library, 'entrance-clearance', 'entrance.clearance', '入口净空不足或超出墙体');
  // Rear shelves and table/seats must leave side lanes and a front approach.
  if (b.width - 0.5 - Math.min(3.6, b.width * 0.4) < 1.8 || b.depth - 0.8 - Math.min(2.7, b.depth * 0.4) < 1.8) fail(library, 'interior-clearance', 'interior.clearance', '室内家具周围不足 0.9m 活动通道');
  const door = localToWorld(library, 0, b.depth / 2);
  const [px, , pz] = porch.transform.position, a = porch.transform.rotation;
  const dx = door[0] - px, dz = door[1] - pz;
  if (Math.abs(dx * Math.cos(a) - dz * Math.sin(a)) + e.width / 2 > porch.bounds.width / 2 || Math.abs(dx * Math.sin(a) + dz * Math.cos(a)) > porch.bounds.depth / 2 + 0.15 || Math.abs(library.transform.position[1] + b.floor - porch.transform.position[1] - porch.bounds.floor) > 0.3) fail(porch, 'entrance-connection', 'entrance.approach', '门廊未覆盖入口或高差过大');
  for (const object of buildings) {
    const extra = object.kind === 'porch' ? 0.2 : object.roof.overhang;
    if (!islands.some(r => rectCorners(object, extra).every(([x, z]) => islandContains(r, x, z, unit)))) fail(object, 'object-bounds', 'object.bounds', '物件占地超出岛屿');
  }
  for (let i = 0; i < buildings.length; i++) for (let j = i + 1; j < buildings.length; j++) {
    const [x, y] = [buildings[i], buildings[j]];
    if (x.kind === 'library' && y.kind === 'porch') continue; // 门廊贴着书院入口,允许搭接
    if (!rectsSeparated(x, y, 0.6)) fail(x, 'object-separation', 'object.separation', `建筑间距不足：${x.id} 与 ${y.id} 需留 0.6m 缝隙`);
  }
  for (const tree of trees) if (!islands.some(r => islandContains(r, tree.position[0], tree.position[2], 3.2 * tree.scale + unit))) fail(tree, 'object-bounds', 'object.bounds', '树冠超出岛屿');
  for (const region of islands) if (Math.abs(region.center[0] - water.center[0]) + region.radius * 1.3 > water.size[0] / 2 || Math.abs(region.center[1] - water.center[1]) + region.radius * 1.3 > water.size[1] / 2) fail(region, 'region-bounds', 'region.bounds', '岛屿超出水域');
  for (const end of ['from', 'to']) {
    const region = findRegion(document, bridge[end].region), p = bridge[end].point;
    if (!islandContains(region, p[0], p[2], bridge.width / 2 + unit / 2) || Math.abs(p[1] - region.elevation) > 0.5) fail(bridge, 'bridge-endpoint-check', `bridge.endpoint.${end}`, '桥端点未落入可着陆区域或高差过大');
  }
  const distance = Math.hypot(bridge.to.point[0] - bridge.from.point[0], bridge.to.point[2] - bridge.from.point[2]);
  if (distance < bridge.width || distance > 100) fail(bridge, 'bridge-continuity', 'bridge.path', '桥路径长度无效');
  // Keep trunks/crowns out of buildings and the bridge's character-height corridor.
  for (const tree of trees) {
    const [tx, ty, tz] = tree.position;
    for (const building of [library, ...houses]) {
      const [lx, ly, lz] = building.transform.position, angle = building.transform.rotation;
      const bb = building.bounds;
      const dx = tx - lx, dz = tz - lz;
      const x = dx * Math.cos(angle) - dz * Math.sin(angle), z = dx * Math.sin(angle) + dz * Math.cos(angle);
      const nearest = Math.hypot(Math.max(0, Math.abs(x) - bb.width / 2), Math.max(0, Math.abs(z) - bb.depth / 2));
      if (nearest < 3.2 * tree.scale && ty < ly + bb.floor + bb.wallHeight + (building.roof?.rise ?? 0) && ty + 8 * tree.scale > ly + bb.floor) {
        fail(tree, 'object-overlap', 'object.clearance', `树冠与建筑 ${building.id} 相交`); break;
      }
    }
    const from = bridge.from.point, to = bridge.to.point;
    const vx = to[0] - from[0], vz = to[2] - from[2];
    const t = Math.max(0, Math.min(1, ((tx - from[0]) * vx + (tz - from[2]) * vz) / (vx * vx + vz * vz || 1)));
    const p = bridgePoint(bridge, t);
    const trunkBlocked = Math.hypot(tx - p[0], tz - p[2]) < bridge.width / 2 + 0.4 * tree.scale;
    const crownBlocked = Math.hypot(tx - p[0], tz - p[2]) < bridge.width / 2 + 3.2 * tree.scale && ty + 3 * tree.scale < p[1] + 1.8;
    if (trunkBlocked || crownBlocked) fail(tree, 'bridge-clearance', 'bridge.path', '树木阻挡桥上步行净空');
  }
  // Building footprints must stay out of the bridge's walking corridor.
  for (const building of buildings) {
    if (rectCorners(building, 0.3).some(([x, z]) => pointSegmentDistance(x, z, bridge.from.point, bridge.to.point) < bridge.width / 2 + 0.3)) {
      fail(building, 'bridge-clearance', 'bridge.path', `建筑 ${building.id} 伸入桥上步行净空`);
    }
  }
  let previous = bridgePoint(bridge, 0);
  for (let i = 1; i <= bridge.segments; i++) {
    const next = bridgePoint(bridge, i / bridge.segments);
    if (Math.abs(next[1] - previous[1]) > Math.hypot(next[0] - previous[0], next[2] - previous[2]) * 0.8) {
      fail(bridge, 'bridge-continuity', 'bridge.path', '桥路径坡度超出连续步行预算'); break;
    }
    previous = next;
  }
  // Paths live on one island, keep off the shore, and never cross a building footprint.
  for (const path of paths) {
    const margin = path.width / 2 + unit / 2;
    const host = islands.find(region => islandContains(region, path.points[0][0], path.points[0][1]));
    if (!host || !path.points.every(([x, z]) => islandContains(host, x, z, margin))) {
      fail(path, 'path-bounds', 'path.region', '路径点必须全部落在同一座岛上并离岸足够远');
      continue;
    }
    const blocked = buildings.filter(building => pathSamples(path).some(([x, z]) => pointInRect(building, x, z, path.width / 2 + 0.15)));
    if (blocked.length) fail(path, 'path-clearance', 'path.clearance', `路径穿过建筑：${blocked.map(b => b.id).join('、')}`);
  }
  // Characters spawn on an island outside every building; routes stay on that island and clear of buildings.
  const characters = document.objects.filter(o => o?.kind === 'character');
  for (const character of characters) {
    const [cx, , cz] = character.position;
    const host = islands.find(region => islandContains(region, cx, cz, 0.3));
    if (!host) { fail(character, 'character-bounds', 'character.region', '角色出生点必须落在岛上'); continue; }
    const spawnIn = buildings.filter(building => pointInRect(building, cx, cz, 0.2));
    if (spawnIn.length) fail(character, 'character-clearance', 'character.clearance', `角色出生在建筑内：${spawnIn.map(b => b.id).join('、')}`);
    if (Array.isArray(character.route) && character.route.length) {
      if (!character.route.every(([x, z]) => islandContains(host, x, z, 0.3))) {
        fail(character, 'character-route', 'character.region', '角色路线必须全部落在出生岛同一座岛上');
      } else {
        const blocked = buildings.filter(building => pathSamples({ points: character.route }).some(([x, z]) => pointInRect(building, x, z, 0.25)));
        if (blocked.length) fail(character, 'character-route', 'character.clearance', `角色路线穿过建筑：${blocked.map(b => b.id).join('、')}`);
      }
    }
  }
  return errors;
}
import { validateCampSceneDocument } from './camp-document.js';


import { validateWorldStructure, validateWorldSpatialLayout } from './world-document.js';
