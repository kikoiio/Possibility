import { diagnostic, islandContains, rectCorners, rectsSeparated, rectAxes, pointInRect, pointSegmentDistance, bridgePoint, localToWorld } from './scene-validation.js';

export function pointInRoom(room, x, z, margin = 0) {
  const dx = x - room.transform.position[0], dz = z - room.transform.position[2], a = room.transform.rotation;
  return Math.abs(dx * Math.cos(a) - dz * Math.sin(a)) <= room.bounds.width / 2 - margin &&
    Math.abs(dx * Math.sin(a) + dz * Math.cos(a)) <= room.bounds.depth / 2 - margin;
}

function roomsOverlap(a, b) {
  const dx = b.transform.position[0] - a.transform.position[0], dz = b.transform.position[2] - a.transform.position[2];
  for (const [ux, uz] of [...rectAxes(a), ...rectAxes(b)]) {
    const extent = room => {
      const [ax, az] = rectAxes(room);
      return room.bounds.width / 2 * Math.abs(ux * ax[0] + uz * ax[1]) +
        room.bounds.depth / 2 * Math.abs(ux * az[0] + uz * az[1]);
    };
    // Touching walls are valid; any positive-area overlap is rejected.
    if (Math.abs(dx * ux + dz * uz) >= extent(a) + extent(b) - 1e-9) return false;
  }
  return true;
}

// World uses the existing SceneDocument vocabulary, units and backends. Limits
// apply before compilation so model output cannot request an unbounded grid.
export function validateWorldStructure(document) {
  const errors = [];
  const fail = (node, req, message) => errors.push(diagnostic(typeof node?.id === 'string' ? node.id : 'document', 'validate-document', req, message));
  const bounded = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;
  const islands = document.regions.filter(r => r?.kind === 'island');
  if (!islands.length) fail(document, 'world.land', 'world 至少需要一个 island 陆地区域');
  for (const kind of ['water', 'library', 'porch', 'bridge']) {
    if ([...document.regions, ...document.objects].filter(n => n?.kind === kind).length > 1) fail(document, `world.${kind}`, `${kind} 最多一个`);
  }
  if (islands.length > 8) fail(document, 'world.land.count', '最多 8 个陆地区域');
  if (typeof document.title !== 'string' || !document.title.trim() || document.title.length > 200) fail(document, 'world.title', '世界场景需要 1 到 200 字标题');
  let budget = 0, pathLength = 0;
  const unit = document.style?.voxelUnit;
  if (document.style?.seed !== undefined && !Number.isSafeInteger(document.style.seed)) fail(document, 'world.seed', 'seed 必须是安全整数');
  for (const node of [...document.regions, ...document.objects]) {
    if (!node || typeof node !== 'object') continue;
    if (typeof node.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(node.id)) fail(node, 'world.identity', 'id 需要 1 到 80 个字母、数字或 _ . : -');
    const coordinates = [node.center, node.position, node.transform?.position, node.from?.point, node.to?.point, ...(Array.isArray(node.points) ? node.points : []), ...(Array.isArray(node.route) ? node.route : [])].filter(Array.isArray);
    if (coordinates.some(p => p.some(n => !bounded(n, -256, 256)))) fail(node, 'world.coordinates', '世界坐标须在 -256 到 256 之间');
    if (node.elevation !== undefined && !bounded(node.elevation, -20, 20)) fail(node, 'world.elevation', '世界区域高程须在 -20 到 20 之间');
    if (node.seed !== undefined && !Number.isSafeInteger(node.seed)) fail(node, 'world.seed', 'seed 必须是安全整数');
    if (node.speed !== undefined && !bounded(node.speed, 0, 5)) fail(node, 'world.speed', 'speed 须在 0 到 5 之间');
    if (node.rotationY !== undefined || node.transform?.rotationY !== undefined) fail(node, 'world.transform', '仅使用 transform.rotation 指定旋转');
    if (Array.isArray(node.windows) && (node.windows.length > 8 || node.windows.some(w => !bounded(w?.offset, -15, 15)))) fail(node, 'world.windows', '最多 8 个偏移在 -15 到 15 之间的窗户');
    if (Array.isArray(node.attachments) && node.attachments.length > 16) fail(node, 'world.attachments', '最多 16 个连接');
    if (node.kind === 'island') budget += Math.ceil(2 * node.radius * (1 + 1.45 * node.irregularity) / unit + 1) ** 2 * Math.ceil(1.2 / unit);
    if (['house', 'library'].includes(node.kind)) {
      const b = node.bounds;
      budget += Math.ceil((b?.width + 4) / unit) * Math.ceil((b?.depth + 4) / unit) * Math.ceil((b?.wallHeight + (node.roof?.rise ?? 0)) / unit);
    }
    if (node.kind === 'room') budget += Math.ceil((node.bounds?.width + 1) / unit) * Math.ceil((node.bounds?.depth + 1) / unit) * Math.ceil(node.bounds?.wallHeight / unit);
    if (node.kind === 'tree') budget += (6 / unit) ** 3;
    for (const points of [node.points, node.route]) if (Array.isArray(points) && points.every(p => Array.isArray(p) && p.length === 2)) {
      for (let i = 1; i < points.length; i++) pathLength += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
  }
  if (Number.isFinite(budget) && budget > 300000) fail(document, 'world.geometry.budget', '几何总量超出 300000 单元预算；请缩小区域、建筑或提高 voxelUnit');
  if (pathLength > 512) fail(document, 'world.path.budget', '路径与角色路线总长度不能超过 512m');
  return errors;
}

// Exact slab test in the building's local frame; a segment can cross a small
// rotated building even when neither its endpoints nor the corners touch it.
function segmentHitsRect(a, b, object, margin) {
  const angle = object.transform.rotation, [ox, , oz] = object.transform.position;
  const local = p => [(p[0] - ox) * Math.cos(angle) - (p[1] - oz) * Math.sin(angle), (p[0] - ox) * Math.sin(angle) + (p[1] - oz) * Math.cos(angle)];
  const p = local(a), q = local(b), extents = [object.bounds.width / 2 + margin, object.bounds.depth / 2 + margin];
  let lo = 0, hi = 1;
  for (let i = 0; i < 2; i++) {
    const delta = q[i] - p[i];
    if (Math.abs(delta) < 1e-9) { if (Math.abs(p[i]) > extents[i]) return false; continue; }
    const t1 = (-extents[i] - p[i]) / delta, t2 = (extents[i] - p[i]) / delta;
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
    if (lo > hi) return false;
  }
  return true;
}
function circleHitsRect(object, x, z, radius) {
  const dx = x - object.transform.position[0], dz = z - object.transform.position[2], a = object.transform.rotation;
  const lx = dx * Math.cos(a) - dz * Math.sin(a), lz = dx * Math.sin(a) + dz * Math.cos(a);
  return Math.hypot(Math.max(0, Math.abs(lx) - object.bounds.width / 2), Math.max(0, Math.abs(lz) - object.bounds.depth / 2)) < radius;
}
function samples(points) {
  const result = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.25));
    for (let k = 0; k <= n; k++) result.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
  }
  return result;
}
export function validateWorldSpatialLayout(document) {
  const errors = [], unit = document.style.voxelUnit;
  const fail = (node, req, message) => errors.push(diagnostic(node.id, 'world-spatial', req, message));
  const islands = document.regions.filter(r => r.kind === 'island');
  const buildings = document.objects.filter(o => ['house', 'library', 'porch'].includes(o.kind));
  const rooms = document.objects.filter(o => o.kind === 'room');
  const trees = document.objects.filter(o => o.kind === 'tree');
  const water = document.regions.find(r => r.kind === 'water');
  if (water) for (const land of islands) {
    const radius = land.radius * (1 + 1.45 * land.irregularity);
    if (land.elevation <= water.elevation || Math.abs(land.center[0] - water.center[0]) + radius > water.size[0] / 2 || Math.abs(land.center[1] - water.center[1]) + radius > water.size[1] / 2) fail(land, 'region.bounds', '陆地须位于水域范围内且高于水面');
  }
  const hostAt = (x, y, z, margin = 0.3, tolerance = 0.15) => islands.find(r => islandContains(r, x, z, margin) && Math.abs(y - r.elevation) <= tolerance);
  for (const object of buildings) {
    const corners = rectCorners(object, Math.max(object.roof?.overhang ?? 0.2, 0.4));
    const perimeter = samples([corners[0], corners[1], corners[3], corners[2], corners[0]]);
    const floor = object.transform.position[1] + object.bounds.floor;
    if (!islands.some(r => perimeter.every(([x, z]) => islandContains(r, x, z, unit / 2)) && floor >= r.elevation - 0.05 && floor <= r.elevation + (object.kind === 'porch' ? 0.45 : 1.3))) fail(object, 'object.support', '建筑占地须在陆地上，地板高程必须与陆地连接');
    if (object.kind !== 'porch') {
      const e = object.entrance, b = object.bounds;
      if (object.kind === 'library' && (b.width - 0.5 - Math.min(3.6, b.width * 0.4) < 1.8 || b.depth - 0.8 - Math.min(2.7, b.depth * 0.4) < 1.8)) fail(object, 'interior.clearance', '书院家具周围不足 0.9m 活动通道');
      if (e.width < 0.9 || e.height < 1.8 || e.width > b.width - 0.6 || e.height > b.wallHeight - 0.2) fail(object, 'entrance.clearance', '建筑入口净空不足或超出墙体');
    }
  }
  for (const room of rooms) {
    const corners = rectCorners(room);
    const perimeter = samples([corners[0], corners[1], corners[3], corners[2], corners[0]]);
    const floor = room.transform.position[1] + room.bounds.floor;
    const center = [room.transform.position[0], room.transform.position[2]];
    if (!islands.some(r => perimeter.every(([x, z]) => islandContains(r, x, z, unit / 2)) &&
      islandContains(r, center[0], center[1]) && floor >= r.elevation - 0.05 && floor <= r.elevation + 1.3)) {
      fail(room, 'room.support', '房间整个地板范围须由陆地支撑，地板高程必须与陆地连接');
    }
  }
  for (let i = 0; i < rooms.length; i++) for (const other of rooms.slice(i + 1)) {
    if (roomsOverlap(rooms[i], other)) fail(rooms[i], 'room.overlap', `房间 ${rooms[i].id} 与 ${other.id} 不能重叠`);
  }
  for (let i = 0; i < buildings.length; i++) for (let j = i + 1; j < buildings.length; j++) {
    const a = buildings[i], b = buildings[j];
    // A declared porch may meet its building at the front door, never cover it.
    const porch = a.kind === 'porch' ? a : b.kind === 'porch' ? b : null;
    const building = porch === a ? b : a;
    const connected = porch && building.kind !== 'porch' && porch.attachments?.some(link => link.target === building.id) && building.attachments?.some(link => link.target === porch.id);
    if (connected) {
      const [x, z] = localToWorld(building, 0, building.bounds.depth / 2 + 0.15);
      const aligned = Math.abs(Math.sin(porch.transform.rotation - building.transform.rotation)) < 0.05;
      const origin = localToWorld(building, 0, building.bounds.depth / 2 + porch.bounds.depth / 2);
      if (!aligned || Math.hypot(origin[0] - porch.transform.position[0], origin[1] - porch.transform.position[2]) > 0.35 || !pointInRect(porch, x, z) || Math.abs(porch.transform.position[1] + porch.bounds.floor - building.transform.position[1] - building.bounds.floor) > 0.3) fail(porch, 'entrance.approach', '门廊必须贴合建筑正面入口并保持相近高程');
    } else if (!rectsSeparated(a, b, 0.6)) fail(a, 'object.separation', `建筑 ${a.id} 与 ${b.id} 重叠或间距不足`);
  }
  for (let i = 0; i < trees.length; i++) {
    const tree = trees[i], [x, y, z] = tree.position;
    if (!hostAt(x, y, z, 3.2 * tree.scale + unit / 2)) fail(tree, 'object.support', '树木须获得陆地支撑且树冠不能越岸');
    for (const b of buildings) if (circleHitsRect(b, x, z, 3.2 * tree.scale + 0.15)) fail(tree, 'object.clearance', `树木与建筑 ${b.id} 相交`);
    for (const other of trees.slice(i + 1)) if (Math.hypot(x - other.position[0], z - other.position[2]) < 3.2 * (tree.scale + other.scale)) fail(tree, 'tree.clearance', `树冠与 ${other.id} 相交`);
  }
  const checkLine = (node, points, margin) => {
    const all = samples(points);
    if (!islands.some(r => all.every(([x, z]) => islandContains(r, x, z, margin)))) fail(node, 'path.region', '路径须全程位于同一陆地区域内');
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      for (const building of buildings) if (segmentHitsRect(a, b, building, margin)) fail(node, 'path.clearance', `路径穿过建筑 ${building.id}`);
      for (const tree of trees) if (pointSegmentDistance(tree.position[0], tree.position[2], [a[0], 0, a[1]], [b[0], 0, b[1]]) < margin + 0.4 * tree.scale) fail(node, 'path.clearance', `路径被树干 ${tree.id} 阻挡`);
    }
  };
  for (const node of document.objects) {
    if (node.kind === 'path') checkLine(node, node.points, node.width / 2 + 0.15);
    if (node.kind === 'character') {
      const [x, y, z] = node.position;
      const room = node.roomId && rooms.find(candidate => candidate.id === node.roomId);
      if (room) {
        const floor = room.transform.position[1] + room.bounds.floor;
        if (!pointInRoom(room, x, z, 0.3) || Math.abs(y - floor) > 0.15) fail(node, 'character.room', '角色必须位于绑定房间范围内并站在房间地板高程');
      } else if (!hostAt(x, y, z)) fail(node, 'character.support', '角色位置须贴合陆地高程并离岸至少 0.3m');
      if ((!room && buildings.some(b => pointInRect(b, x, z, 0.25))) || trees.some(t => Math.hypot(x - t.position[0], z - t.position[2]) < 0.3 + 0.4 * t.scale)) fail(node, 'character.clearance', '角色位置被建筑或树干占用');
      if (node.route) checkLine(node, node.route, 0.3);
    }
    if (node.kind === 'bridge') {
      for (const end of ['from', 'to']) {
        const r = islands.find(r => r.id === node[end].region), [x, y, z] = node[end].point;
        if (!islandContains(r, x, z, node.width / 2 + unit / 2) || Math.abs(y - r.elevation) > 0.3) fail(node, `bridge.endpoint.${end}`, '桥端点须贴合所引用陆地');
      }
      const a = node.from.point, b = node.to.point, distance = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (distance < node.width || distance > 100) fail(node, 'bridge.path', '桥长度须大于桥宽且不超过 100m');
      for (const building of buildings) if (segmentHitsRect([a[0], a[2]], [b[0], b[2]], building, node.width / 2 + 0.2)) fail(node, 'bridge.clearance', `桥穿过建筑 ${building.id}`);
      for (const tree of trees) if (pointSegmentDistance(tree.position[0], tree.position[2], a, b) < node.width / 2 + 3.2 * tree.scale) fail(node, 'bridge.clearance', `树木 ${tree.id} 遮挡桥`);
      let previous = bridgePoint(node, 0);
      for (let k = 1; k <= node.segments; k++) {
        const next = bridgePoint(node, k / node.segments);
        if (Math.abs(next[1] - previous[1]) > 0.8 * Math.hypot(next[0] - previous[0], next[2] - previous[2])) { fail(node, 'bridge.path', '桥面坡度过大'); break; }
        previous = next;
      }
    }
  }
  return errors;
}
