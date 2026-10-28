import { validateSceneDocument, validateSpatialLayout, localToWorld, rectCorners } from '../geometry/scene-validation.js';

import { pointInRoom } from '../geometry/world-document.js';

const escapeXML = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const checked = doc => {
  if (doc?.profile !== 'world') throw new Error('generated-world 需要 profile:world 场景');
  const errors = [...validateSceneDocument(doc), ...validateSpatialLayout(doc)];
  if (errors.length) throw new Error(errors.map(e => e.message).join('；'));
  return doc;
};

// Build a presentation snapshot from received locations only. Neither route,
// elapsed wall time, speed nor pause status can invent a future actor position.
export function projectWorldDocument(state, appearance = state?.scene?.document) {
  if (state?.world?.profile !== 'generated-world') throw new Error('需要 generated-world 状态');
  checked(appearance);
  const doc = structuredClone(appearance), actors = state.world.actors, places = state.world.places;
  if (!Array.isArray(actors) || !Array.isArray(places)) throw new Error('世界需要 actors 和 places');
  const byPlace = new Map(places.map(place => [place.id, place]));
  const byActor = new Map(actors.map(actor => [actor.id, actor]));
  const characters = doc.objects.filter(node => node.kind === 'character');
  if (byActor.size !== actors.length || byPlace.size !== places.length || characters.length !== actors.length || characters.some(node => !byActor.has(node.id))) throw new Error('scene character id 必须与 world actor id 一一对应');
  for (const node of characters) {
    const actor = byActor.get(node.id), place = byPlace.get(actor.location);
    if (!Array.isArray(place?.position) || place.position.length !== 3 || !place.position.every(Number.isFinite)) throw new Error(`角色 ${actor.id} 的 location 无有效地点`);
    node.position = [...place.position];
    delete node.roomId;
    if (place.roomId !== undefined) node.roomId = place.roomId;
    // Legacy metadata may be present in a document, but has no authority in a world.
    delete node.route; delete node.speed;
  }
  return checked(doc);
}

function occupantDisplayOffsets(state, document) {
  const places = new Map(state.world.places.map(place => [place.id, place]));
  const rooms = new Map(document.objects.filter(object => object.kind === 'room').map(room => [room.id, room]));
  const groups = new Map();
  for (const actor of state.world.actors) {
    const place = places.get(actor.location), room = rooms.get(place?.roomId);
    if (!Array.isArray(place?.position)) continue;
    const key = place.position.join(',');
    if (!groups.has(key)) groups.set(key, { room, actors: [] });
    groups.get(key).actors.push(actor);
  }
  const offsets = new Map();
  for (const { room, actors } of groups.values()) {
    if (actors.length < 2) continue;
    actors.sort((a, b) => a.id.localeCompare(b.id));
    const radius = room ? Math.min(0.32, room.bounds.width * 0.15, room.bounds.depth * 0.15) : 0.32;
    const angle = room?.transform.rotation || 0;
    actors.forEach((actor, index) => {
      const theta = index * Math.PI * 2 / actors.length;
      const localX = Math.cos(theta) * radius, localZ = Math.sin(theta) * radius;
      offsets.set(actor.id, [localX * Math.cos(angle) + localZ * Math.sin(angle), -localX * Math.sin(angle) + localZ * Math.cos(angle)]);
    });
  }
  return offsets;
}

function makeRoomLabel(THREE, room, text = room?.name || room?.id, position = null) {
  const createElement = globalThis.document?.createElement;
  if (!createElement || typeof THREE.Sprite !== 'function' || typeof THREE.CanvasTexture !== 'function') return null;
  let canvas, context;
  try { canvas = createElement.call(globalThis.document, 'canvas'); context = canvas.getContext?.('2d'); }
  catch { return null; }
  if (!context) return null;
  canvas.width = 512; canvas.height = 104;
  const label = String(text).slice(0, 120);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = 'rgba(13, 17, 19, 0.78)';
  context.strokeStyle = 'rgba(184, 138, 78, 0.78)'; context.lineWidth = 3;
  if (typeof context.roundRect === 'function') {
    context.beginPath(); context.roundRect(7, 7, 498, 90, 8); context.fill();
    context.stroke?.();
  }
  else { context.fillRect(7, 7, 498, 90); context.strokeRect?.(7, 7, 498, 90); }
  context.fillStyle = '#e5c789'; context.font = '600 36px system-ui, sans-serif';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  const lines = label.split('\n');
  context.font = `600 ${lines.length > 1 ? 27 : 36}px system-ui, sans-serif`;
  lines.forEach((line, index) => context.fillText(line, canvas.width / 2, lines.length > 1 ? 34 + index * 32 : 52, canvas.width - 36));
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  const [x, z] = room ? localToWorld(room, 0, 0) : [position[0], position[2]];
  const width = Math.max(1.1, Math.min((room?.bounds.width || 4) * 0.52, Math.max(...lines.map(line => line.length)) * 0.105 + 0.55));
  sprite.position.set(...(position || [x, room.transform.position[1] + room.bounds.floor + room.bounds.wallHeight + 0.14, z]));
  sprite.scale.set(width, width * 0.18, 1);
  sprite.renderOrder = 3;
  sprite.name = `room-label:${room?.id || "place"}`;
  return sprite;
}

// These labels describe the author/world snapshot, never predicted action effects.
function placeLabels(state, document) {
  const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
  const rooms = new Map(document.objects.filter(o => o.kind === 'room').map(o => [o.id, o]));
  return state.world.places.filter(place => Array.isArray(place.position)).map(place => {
    const room = rooms.get(place.roomId);
    const resources = (state.world.resources || []).filter(resource => resource.location === place.id);
    const amounts = resources.slice(0, 2).map(resource => `${compact(resource.name || resource.id)} ${resource.quantity}${compact(resource.unit)}`);
    if (resources.length > 2) amounts.push(`另${resources.length - 2}项`);
    return { id: place.id, room, text: [compact(place.name || place.id), ...amounts].join('\n'),
      position: [place.position[0], room ? room.transform.position[1] + room.bounds.floor + room.bounds.wallHeight + 0.14 : place.position[1] + 2.8, place.position[2]] };
  });
}

function makeActorLabel(THREE, actor) {
  const createElement = globalThis.document?.createElement;
  if (!createElement || typeof THREE.Sprite !== 'function' || typeof THREE.CanvasTexture !== 'function') return null;
  const canvas = createElement.call(globalThis.document, 'canvas'), context = canvas.getContext?.('2d');
  if (!context) return null;
  canvas.width = 420; canvas.height = 76;
  context.fillStyle = 'rgba(12, 16, 18, 0.72)';
  context.strokeStyle = 'rgba(184, 138, 78, 0.64)'; context.lineWidth = 2;
  if (typeof context.roundRect === 'function') {
    context.beginPath(); context.roundRect(6, 6, 408, 64, 10); context.fill();
    context.stroke?.();
  }
  else { context.fillRect(6, 6, 408, 64); context.strokeRect?.(6, 6, 408, 64); }
  context.fillStyle = '#ead29b'; context.font = '600 28px system-ui, sans-serif';
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(String(actor.name || actor.id).slice(0, 18), canvas.width / 2, canvas.height / 2, canvas.width - 34);
  const texture = new THREE.CanvasTexture(canvas);
  if (THREE.SRGBColorSpace) texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.92, 0.17, 1); sprite.renderOrder = 4; sprite.name = `actor-label:${actor.id}`;
  return sprite;
}

export function projectWorldState(compiled, state, appearance = state.scene.document) {
  const doc = projectWorldDocument(state, appearance);
  const actors = new Map(state.world.actors.map(actor => [actor.id, actor]));
  const displayOffsets = occupantDisplayOffsets(state, doc);
  for (const node of doc.objects.filter(o => o.kind === 'character')) {
    const part = compiled.userData.parts[`character:${node.id}`];
    if (!part) throw new Error(`角色部件缺失：${node.id}`);
    part.position.set(...node.position); part.visible = true;
    const [offsetX, offsetZ] = displayOffsets.get(node.id) || [0, 0];
    part.userData.displayMarker?.position.set(offsetX, 0, offsetZ);
    part.userData.displayOffset = [offsetX, 0, offsetZ];
    part.userData.authoritativePosition = [...node.position];
    part.userData.route = null;
    part.userData.actor = structuredClone(actors.get(node.id));
    part.userData.home = [...node.position];
  }
  compiled.userData.viewFacts = structuredClone({ world: state.world, paused: state.paused, speed: state.speed, worldMinute: state.worldMinute, revision: state.revision });
  return doc;
}
function description(state) {
  const w = state.world, places = new Map(w.places.map(p => [p.id, p.name || p.id]));
  return `${w.title}。${w.description || ''} 天气：${w.environment?.weather || ''}。第 ${state.worldMinute ?? 0} 分钟，${state.paused ? '已暂停' : '运行中'}，速度 ${state.speed ?? 1}，版本 ${state.revision ?? 0}。${w.actors.map(a => `${a.name || a.id}在${places.get(a.location) || a.location}（疲劳 ${a.fatigue ?? 0}）`).join('；')}。${(w.resources || []).map(r => `${r.name || r.id} ${r.quantity}/${r.capacity} ${r.unit || ''}`).join('；')}`;
}
export function worldSceneBounds(doc, places = []) {
  const islands = doc.regions.filter(r => r.kind === 'island');
  const rooms = doc.profile === 'world' ? doc.objects.filter(o => o.kind === 'room') : [];
  // A generated indoor world is presented as a room cross-section. The island
  // is only the structural support for compilation; using its radius here
  // makes the actual rooms and residents occupy a tiny part of the viewport.
  // Only pure interiors omit the support islands. Mixed worlds retain their
  // outdoor extent, including unoccupied places from the current snapshot.
  const insideRoom = position => rooms.some(room => pointInRoom(room, position[0], position[2]) && Math.abs(position[1] - room.transform.position[1] - room.bounds.floor) < 0.15);
  const hasOutdoor = doc.objects.some(o => !['room', 'character'].includes(o.kind) || (o.kind === 'character' && !insideRoom(o.position))) || places.some(place => !insideRoom(place.position));
  if (rooms.length && !hasOutdoor) {
    const corners = rooms.flatMap(room => {
      const { floor, wallHeight } = room.bounds;
      return rectCorners(room).flatMap(([x, z]) => [[x, room.transform.position[1] + floor, z], [x, room.transform.position[1] + floor + wallHeight, z]]);
    });
    for (const character of doc.objects.filter(o => o.kind === 'character')) {
      if (Array.isArray(character.position) && character.position.length === 3) corners.push([...character.position]);
    }
    const minX = Math.min(...corners.map(p => p[0])), maxX = Math.max(...corners.map(p => p[0]));
    const minZ = Math.min(...corners.map(p => p[2])), maxZ = Math.max(...corners.map(p => p[2]));
    const minY = Math.min(...corners.map(p => p[1])), maxY = Math.max(...corners.map(p => p[1]));
    const padding = Math.max(0.9, Math.min(2.2, Math.max(maxX - minX, maxZ - minZ) * 0.1));
    const focusedMinX = minX - padding, focusedMaxX = maxX + padding;
    const focusedMinZ = minZ - padding, focusedMaxZ = maxZ + padding;
    return {
      center: [(focusedMinX + focusedMaxX) / 2, (minY + maxY) / 2, (focusedMinZ + focusedMaxZ) / 2],
      span: Math.max(focusedMaxX - focusedMinX, focusedMaxZ - focusedMinZ, (maxY - minY) * 1.8, 8),
    };
  }
  // Outdoor worlds frame their content, not the landform. An island is the
  // structural support for its buildings; framing by island radius puts a
  // handful of small objects in an empty field and spends most of the viewport
  // on ground the world never uses. The island still shows around the content.
  const content = contentBounds(doc, places);
  if (!content) {
    const minX = Math.min(...islands.map(r => r.center[0] - r.radius));
    const maxX = Math.max(...islands.map(r => r.center[0] + r.radius));
    const minZ = Math.min(...islands.map(r => r.center[1] - r.radius));
    const maxZ = Math.max(...islands.map(r => r.center[1] + r.radius));
    return { center: [(minX + maxX) / 2, 0, (minZ + maxZ) / 2], span: Math.max(maxX - minX, maxZ - minZ, 8) };
  }
  return { center: content.center, span: content.span, reach: content.reach };
}

// Bounds of everything a viewer is meant to look at: rooms, characters, trees,
// buildings, path and bridge geometry, plus any place the world knows about but
// has not built on yet. Ground is not a bounding subject — it surrounds these.
export function contentBounds(doc, places = []) {
  const boxes = [];
  const addPoints = points => {
    const flat = points.filter(point => Array.isArray(point) && point.length === 3 && point.every(Number.isFinite));
    if (!flat.length) return;
    boxes.push({
      min: [Math.min(...flat.map(p => p[0])), Math.min(...flat.map(p => p[1])), Math.min(...flat.map(p => p[2]))],
      max: [Math.max(...flat.map(p => p[0])), Math.max(...flat.map(p => p[1])), Math.max(...flat.map(p => p[2]))],
    });
  };
  for (const object of doc.objects) {
    if (object.kind === 'character') { if (Array.isArray(object.position)) addPoints([object.position, [object.position[0], object.position[1] + 2.05, object.position[2]]]); }
    else if (object.kind === 'tree') { const [x, y, z] = object.position, s = object.scale ?? 0.5, r = 2.6 * s; addPoints([[x - r, y, z - r], [x + r, y + 7.6 * s, z + r]]); }
    else if (object.kind === 'path') { const host = (doc.regions || []).find(region => region.kind === 'island' && region.center && object.points?.[0] && Math.hypot(object.points[0][0] - region.center[0], object.points[0][1] - region.center[1]) <= region.radius * 1.3); const y = host?.elevation ?? 0; addPoints((object.points || []).map(([x, z]) => [x, y, z])); }
    else if (object.kind === 'bridge') { addPoints([object.from?.point, object.to?.point]); }
    else if (object.bounds && object.transform) {
      const { width, depth, floor, wallHeight } = object.bounds;
      const y = object.transform.position[1];
      const h = (wallHeight ?? 3) + (object.roof?.rise ?? 0);
      const yaw = object.transform.rotationY ?? object.transform.rotation ?? 0;
      const cos = Math.cos(yaw), sin = Math.sin(yaw);
      addPoints([[-width / 2, -depth / 2], [width / 2, -depth / 2], [width / 2, depth / 2], [-width / 2, depth / 2]]
        .flatMap(([x, z]) => [[0, floor], [0, floor + h]].map(([_, ly]) => [object.transform.position[0] + x * cos + z * sin, y + ly, object.transform.position[2] - x * sin + z * cos])));
    } else if (Array.isArray(object.position)) addPoints([object.position]);
  }
  for (const place of places) if (Array.isArray(place.position)) addPoints([place.position]);
  if (!boxes.length) return null;
  const min = [0, 1, 2].map(i => Math.min(...boxes.map(box => box.min[i])));
  const max = [0, 1, 2].map(i => Math.max(...boxes.map(box => box.max[i])));
  // A little air around the content so roofs and labels are not clipped, but
  // far less than an island-radius frame would add.
  const padXZ = Math.max(2.2, Math.min(4.5, Math.max(max[0] - min[0], max[2] - min[2]) * 0.1));
  const padY = Math.max(1.4, (max[1] - min[1]) * 0.2);
  const spanX = max[0] - min[0] + padXZ * 2, spanZ = max[2] - min[2] + padXZ * 2;
  const spanY = (max[1] - min[1] + padY * 2) * 1.6;
  // Ground has to reach past the content box in every direction, so a world
  // whose parts cluster at one end never shows its landform starting mid-frame.
  // The frame itself still covers the full extent: an object placed far from
  // the others is part of the world and must stay in view. What changes is that
  // the extent is measured from content, not from the island's outer radius.
  const extent = Math.max(max[0] - min[0], max[2] - min[2]) / 2 + padXZ;
  // A near edge in front of the content would show a slab of ground the world
  // does not use, so the frame is never tighter than the landform's own near
  // edge. Each island's footprint is measured from its centre, so an island
  // that the content happens to sit at one side of is not cropped.
  const nearEdge = Math.max(0, ...(doc.regions || []).filter(region => region.kind === 'island' && Array.isArray(region.center))
    .map(region => {
      const dx = region.center[0] - (min[0] + max[0]) / 2, dz = region.center[1] - (min[2] + max[2]) / 2;
      return Math.hypot(dx, dz) + (region.radius ?? 0);
    }));
  // A 16:9 viewport is wider than it is tall, so the vertical extent needs more
  // room than the horizontal one for the same span; this was the other half of
  // the empty-margin problem.
  const themeFrame = doc.style?.palette === 'victorian-archive';
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2 + padY * 0.3, (min[2] + max[2]) / 2],
    span: Math.max(spanX, spanZ, spanY, extent * (themeFrame ? 1.32 : 1.62), nearEdge * (themeFrame ? 1.18 : 1.62), 6),
    reach: Math.max(extent, nearEdge),
  };
}

// The fallback uses precisely the same world coordinates as the 3D projection.
export function renderWorldSVG(state, appearance = state.scene.document) {
  const doc = projectWorldDocument(state, appearance), bounds = worldSceneBounds(doc, state.world.places);
  const [cx, , cz] = bounds.center, scale = 760 / bounds.span;
  const project = ([x, y, z]) => [550 + (x - cx) * scale, 350 + (z - cz) * scale * 0.62 - y * scale * 0.7];
  const attr = (node, p) => `data-object-id="${escapeXML(node.id)}" data-world-x="${p[0]}" data-world-y="${p[1]}" data-world-z="${p[2]}"`;
  const land = doc.regions.filter(r => r.kind === 'island').map(r => {
    const [x, y] = project([r.center[0], r.elevation, r.center[1]]);
    return `<ellipse cx="${x}" cy="${y + 10}" rx="${r.radius * scale}" ry="${r.radius * scale * 0.62}" fill="#6c8770"/><ellipse cx="${x}" cy="${y}" rx="${r.radius * scale}" ry="${r.radius * scale * 0.62}" fill="#9fb58d"/>`;
  }).join('');
  const lines = doc.objects.filter(o => ['path', 'bridge'].includes(o.kind)).map(o => {
    const points = o.kind === 'bridge' ? [o.from.point, o.to.point] : o.points.map(([x, z]) => [x, doc.regions.find(r => r.kind === 'island' && Math.hypot(x - r.center[0], z - r.center[1]) <= r.radius * 1.3)?.elevation ?? 0, z]);
    return `<polyline data-object-id="${escapeXML(o.id)}" points="${points.map(p => project(p).join(',')).join(' ')}" stroke="${o.kind === 'bridge' ? '#a68a63' : '#d5ccb0'}" stroke-width="${o.width * scale}" stroke-linecap="round" fill="none"/>`;
  }).join('');
  const placeById = new Map(state.world.places.map(place => [place.id, place]));
  const connections = (state.world.story?.connections || []).map(connection => {
    const from = placeById.get(connection.from)?.position, to = placeById.get(connection.to)?.position;
    if (!from || !to) return '';
    return `<line x1="${project(from)[0]}" y1="${project(from)[1]}" x2="${project(to)[0]}" y2="${project(to)[1]}" stroke="#e6bd6b" stroke-width="3" stroke-dasharray="8 7" opacity=".85"/>`;
  }).join('');
  const rooms = doc.objects.filter(o => o.kind === 'room').map(room => {
    const { width, depth, floor, wallHeight } = room.bounds, hw = width / 2, hd = depth / 2;
    const point = (x, z, y = floor) => {
      const [wx, wz] = localToWorld(room, x, z);
      return project([wx, room.transform.position[1] + y, wz]);
    };
    const floorCorners = [[-hw, -hd], [-hw, hd], [hw, hd], [hw, -hd]].map(([x, z]) => point(x, z));
    const wall = (from, to) => [point(...from), point(...to), point(...to, floor + wallHeight), point(...from, floor + wallHeight)];
    const polygon = points => points.map(([x, y]) => `${x},${y}`).join(' ');
    const backWall = wall([-hw, -hd], [hw, -hd]), leftWall = wall([-hw, -hd], [-hw, hd]);
    const [labelX, labelY] = point(0, 0, floor + 0.12);
    const fontSize = clamp(scale * 0.32, 12, 24);
    return `<g data-room-id="${escapeXML(room.id)}"><polygon points="${polygon(floorCorners)}" fill="#b99a6d" stroke="#6c5942" stroke-width="2"/><polygon points="${polygon(backWall)}" fill="#dfd2b5" fill-opacity=".82" stroke="#8f8063" stroke-width="2"/><polygon points="${polygon(leftWall)}" fill="#cdbd9c" fill-opacity=".78" stroke="#8f8063" stroke-width="2"/><text data-room-label="${escapeXML(room.name)}" x="${labelX}" y="${labelY}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="${fontSize}" font-weight="600" fill="#302c25">${escapeXML(room.name)}</text></g>`;
  }).join('');
  const displayOffsets = occupantDisplayOffsets(state, doc);
  const objects = doc.objects.filter(o => !['path', 'bridge', 'room'].includes(o.kind)).sort((a, b) => (a.position || a.transform?.position)[2] - (b.position || b.transform?.position)[2]).map(o => {
    const p = o.position || o.transform.position, [x, y] = project(p);
    const title = `<title>${escapeXML(o.name || state.world.actors.find(a => a.id === o.id)?.name || o.id)}</title>`;
    if (o.kind === 'character') {
      const [offsetX, offsetZ] = displayOffsets.get(o.id) || [0, 0], [drawX, drawY] = project([p[0] + offsetX, p[1], p[2] + offsetZ]);
      return `<g ${attr(o, p)} transform="translate(${drawX} ${drawY})">${title}<ellipse cy="1" rx="7" ry="3" fill="#567965" opacity=".25"/><path d="M-5-8-7-23h14L5-8Z" fill="#ae785c"/><path d="M-3-8v9m6-9v9" stroke="#526c60" stroke-width="3"/><circle cy="-29" r="6" fill="#e5c696"/><path d="M-9-32H9L4-38H-4Z" fill="#d3bf8b"/><text data-actor-label="${escapeXML(o.id)}" y="-44" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#302c25">${escapeXML(state.world.actors.find(a => a.id === o.id)?.name || o.id)}</text></g>`;
    }
    if (o.kind === 'tree') return `<g ${attr(o, p)} transform="translate(${x} ${y}) scale(${o.scale * scale / 10})">${title}<path d="M-2 0V-52h4V0" fill="#6d7760"/><ellipse cy="-50" rx="24" ry="30" fill="#668c70"/><ellipse cx="-7" cy="-59" rx="17" ry="20" fill="#81a080"/></g>`;
    const w = o.bounds.width * scale, d = o.bounds.depth * scale * 0.62, h = (o.bounds.wallHeight ?? 2) * scale * 0.7;
    return `<g ${attr(o, p)} transform="translate(${x} ${y})">${title}<rect x="${-w / 2}" y="${-d / 2 - h}" width="${w}" height="${h + d}" rx="2" fill="#e1d5b2"/><path d="M${-w / 2 - 4} ${-d / 2 - h}L0 ${-d / 2 - h - (o.roof?.rise ?? 1) * scale * 0.7}L${w / 2 + 4} ${-d / 2 - h}Z" fill="#577b6d"/><rect x="-5" y="${d / 2 - h * 0.6}" width="10" height="${h * 0.6}" fill="#718476"/></g>`;
  }).join('');
  const labels = placeLabels(state, doc).map(label => {
    const [x, y] = project(label.position);
    return `<text data-place-label="${escapeXML(label.id)}" x="${x}" y="${y}" text-anchor="middle" font-family="system-ui,sans-serif" font-size="12" fill="#302c25">${label.text.split('\n').map((line, i) => `<tspan x="${x}" dy="${i ? 15 : 0}">${escapeXML(line)}</tspan>`).join('')}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1100 700" width="100%" height="100%" role="img" aria-label="${escapeXML(description(state))}"><rect width="1100" height="700" fill="#b6cdbe"/><path d="M0 350Q300 290 600 350T1100 350V700H0Z" fill="#a6c4b4"/>${land}${lines}${connections}${rooms}${objects}${labels}</svg>`;
}

function makeFallback(shell, initialState) {
  let disposed = false, accepted = null;
  shell.reset.hidden = true;
  const update = state => {
    if (disposed) return;
    try { projectWorldDocument(state); accepted = structuredClone(state.scene.document); delete shell.root.dataset.sceneError; }
    catch (error) { shell.root.dataset.sceneError = error.message; }
    if (!accepted) return;
    try { shell.stage.innerHTML = renderWorldSVG(state, accepted); }
    catch (error) { shell.root.dataset.sceneError = error.message; }
  };
  update(initialState);
  return { mode: 'fallback', update, dispose() { if (disposed) return; disposed = true; shell.root.remove(); } };
}

export function buildWorldThree(THREE, shell, initialState, compiler, { createPlainMaterials, createMaterials = createPlainMaterials }) {
  const { compileScene, prepareSceneUpdate, disposeWorld } = compiler;
  let renderer, observer, compiled, accepted, key, disposed = false, fallback = null, lastState = initialState;
  const makeMaterials = typeof globalThis.document?.createElement === 'function' ? createMaterials : createPlainMaterials;
  const materials = makeMaterials(), removers = [];
  const roomLabels = new Map();
  const locationLabels = new Map();
  const actorLabels = new Map();
  let connectionGroup = null;
  let connectionSignature = '';
  const removeRoomLabel = entry => {
    entry.sprite.removeFromParent();
    entry.sprite.material.map?.dispose(); entry.sprite.material.dispose();
  };
  const listen = (target, event, fn, options) => { target.addEventListener(event, fn, options); removers.push(() => target.removeEventListener(event, fn, options)); };
  const release = () => {
    observer?.disconnect(); removers.splice(0).forEach(fn => fn());
    if (compiled) { disposeWorld(compiled); compiled = null; }
    for (const entry of roomLabels.values()) removeRoomLabel(entry);
    roomLabels.clear();
    for (const entry of locationLabels.values()) removeRoomLabel(entry);
    locationLabels.clear();
    for (const entry of actorLabels.values()) removeRoomLabel(entry);
    actorLabels.clear();
    connectionGroup?.removeFromParent();
    connectionGroup?.traverse(node => { if (node.geometry) node.geometry.dispose(); if (node.material) node.material.dispose(); });
    connectionGroup = null;
    for (const m of new Set(Object.values(materials))) { m.map?.dispose(); m.dispose(); }
    if (renderer) { renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); }
  };
  try {
    const scene = new THREE.Scene(), sky = '#b2cbc1';
    const syncRoomLabels = (state, document) => {
      const boundRooms = new Set(state.world.places.map(place => place.roomId));
      const rooms = document.objects.filter(object => object.kind === 'room' && !boundRooms.has(object.id)), wanted = new Set(rooms.map(room => room.id));
      for (const [id, entry] of roomLabels) if (!wanted.has(id)) { removeRoomLabel(entry); roomLabels.delete(id); }
      for (const room of rooms) {
        const signature = JSON.stringify(room), old = roomLabels.get(room.id);
        if (old?.signature === signature) continue;
        if (old) removeRoomLabel(old);
        const sprite = makeRoomLabel(THREE, room);
        if (!sprite) { roomLabels.delete(room.id); continue; }
        scene.add(sprite); roomLabels.set(room.id, { signature, sprite });
      }
    };
    const syncPlaceLabels = (state, document) => {
      const labels = placeLabels(state, document), wanted = new Set(labels.map(label => label.id));
      for (const [id, entry] of locationLabels) if (!wanted.has(id)) { removeRoomLabel(entry); locationLabels.delete(id); }
      for (const label of labels) {
        const signature = JSON.stringify([label.text, label.position, label.room]), old = locationLabels.get(label.id);
        if (old?.signature === signature) continue;
        if (old) { removeRoomLabel(old); locationLabels.delete(label.id); }
        const sprite = makeRoomLabel(THREE, label.room, label.text, label.position);
        if (!sprite) continue;
        sprite.name = `place-label:${label.id}`;
        scene.add(sprite); locationLabels.set(label.id, { signature, sprite });
      }
    };
    const syncActorLabels = (state, document) => {
      const actors = new Map(state.world.actors.map(actor => [actor.id, actor]));
      const wanted = new Set(actors.keys());
      const offsets = occupantDisplayOffsets(state, document);
      for (const [id, entry] of actorLabels) if (!wanted.has(id)) { removeRoomLabel(entry); actorLabels.delete(id); }
      for (const node of document.objects.filter(object => object.kind === 'character')) {
        const actor = actors.get(node.id); if (!actor) continue;
        const signature = actor.name || actor.id, old = actorLabels.get(actor.id);
        let sprite = old?.sprite;
        if (old?.signature !== signature) {
          if (old) { removeRoomLabel(old); actorLabels.delete(actor.id); }
          sprite = makeActorLabel(THREE, actor); if (!sprite) continue;
          scene.add(sprite); actorLabels.set(actor.id, { signature, sprite });
        }
        const [dx, dz] = offsets.get(actor.id) || [0, 0];
        sprite.position.set(node.position[0] + dx, node.position[1] + 2.05, node.position[2] + dz);
      }
    };
    const syncConnections = state => {
      const connections = state.world.story?.connections || [];
      const places = new Map(state.world.places.map(place => [place.id, place]));
      const signature = JSON.stringify([connections, [...places].map(([id, place]) => [id, place.position])]);
      if (signature === connectionSignature) return;
      connectionSignature = signature;
      connectionGroup?.removeFromParent();
      connectionGroup?.traverse(node => { if (node.geometry) node.geometry.dispose(); if (node.material) node.material.dispose(); });
      connectionGroup = new THREE.Group(); connectionGroup.name = 'world-connections';
      for (const connection of connections) {
        const from = places.get(connection.from)?.position, to = places.get(connection.to)?.position;
        if (!from || !to) continue;
        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(from[0], from[1] + 0.03, from[2]),
          new THREE.Vector3(to[0], to[1] + 0.03, to[2]),
        ]);
        const material = new THREE.LineDashedMaterial({ color: '#b78750', dashSize: 0.22, gapSize: 0.14, transparent: true, opacity: 0.68 });
        const line = new THREE.Line(geometry, material); line.computeLineDistances(); connectionGroup.add(line);
      }
      scene.add(connectionGroup);
    };
    scene.background = new THREE.Color(sky);
    const camera = new THREE.PerspectiveCamera(34, 1, 0.1, 2000);
    // Ambient fill stays well under the sun so surfaces keep a lit and a shadow
    // side. Two near-equal lights flatten everything into a diagram.
    scene.add(new THREE.HemisphereLight('#e2e4df', '#303438', 0.86));
    const sun = new THREE.DirectionalLight('#fff0d0', 2.8); scene.add(sun); scene.add(sun.target);
    const fill = new THREE.DirectionalLight('#9db5c6', 0.52); fill.position.set(14, 9, -16); scene.add(fill);
    // Accent lights give the scene a warm and a cool side instead of one flat
    // key. They are subtle: the world is about reading what happens, not about
    // a colour grade that hides states.
    const warmRim = new THREE.PointLight('#ffcf8a', 8, 34, 2); warmRim.position.set(9, 6, -9); scene.add(warmRim);
    const coolRim = new THREE.PointLight('#8fc6d9', 4.5, 34, 2); coolRim.position.set(-10, 5, 8); scene.add(coolRim);
    // A large soft gradient behind the world: sky above the horizon, haze below.
    const domeShader = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color('#8fb4c6') }, horizon: { value: new THREE.Color('#dfe8dc') }, bottom: { value: new THREE.Color('#9eb6a6') } },
      vertexShader: 'varying float h; void main(){ h = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform vec3 bottom; varying float h; void main(){ vec3 c = h > 0.0 ? mix(horizon, top, pow(h, 0.75)) : mix(horizon, bottom, pow(-h, 0.5)); gl_FragColor = vec4(c, 1.0); }',
    });
    domeShader.fogColors = false;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), domeShader);
    dome.name = 'sky-dome'; dome.renderOrder = -1; dome.frustumCulled = false;
    scene.add(dome);
    scene.fog = new THREE.Fog('#dfe8dc', 40, 200);
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(globalThis.window?.devicePixelRatio || 1, 1.25));
    // A CPU sink or stub renderer has no shadowMap; it keeps the flat lighting.
    if (renderer.shadowMap) { renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
    if (THREE.SRGBColorSpace) renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.06;
    const canvas = renderer.domElement;
    Object.assign(canvas.style, { width: '100%', height: '100%', display: 'block', touchAction: 'none', cursor: 'grab' });
    canvas.setAttribute('role', 'img'); shell.stage.replaceChildren(canvas);
    let bounds, yaw = 0.62, pitch = 0.58, zoom = 0.78, pointer = null;
    const setCamera = () => {
      if (!bounds) return;
      // Frame the content box tightly: the span already includes its own air,
      // so a large multiplier just reintroduces the empty margin we removed.
      const distance = bounds.span * 0.5 / Math.sin(camera.fov * Math.PI / 360) * Math.max(1, 1.05 / camera.aspect) * zoom;
      // Keep the default elevation above the shallow range: near-horizontal
      // views collapse rooftops, shadows and far walls into flat bands.
      const elevation = Math.max(0.42, pitch);
      const [x, y, z] = bounds.center;
      camera.position.set(x + Math.sin(yaw) * Math.cos(elevation) * distance, y + Math.sin(elevation) * distance, z + Math.cos(yaw) * Math.cos(elevation) * distance);
      camera.far = Math.max(200, distance + bounds.span * 8); camera.updateProjectionMatrix(); camera.lookAt(x, y, z);
      // Fog starts past the content so it never washes out the world itself, and
      // ends before the ground edge so distant ground dissolves into the sky.
      scene.fog = new THREE.Fog(scene.background, distance + bounds.span * 0.85, distance + bounds.span * 3.4);
      // Shadow frustum tracks the content box: a fixed frustum either clips a
      // large world or wastes its resolution on empty ground.
      const radius = Math.max(6, bounds.span * 0.8);
      sun.position.set(x - radius * 0.55, y + radius * 1.25, z + radius * 0.7);
      sun.target.position.set(x, y, z);
      sun.castShadow = true;
      sun.shadow.mapSize.set(1024, 1024);
      sun.shadow.camera.left = -radius; sun.shadow.camera.right = radius;
      sun.shadow.camera.top = radius; sun.shadow.camera.bottom = -radius;
      sun.shadow.camera.near = 0.5; sun.shadow.camera.far = radius * 4;
      sun.shadow.bias = -0.0012; sun.shadow.normalBias = 0.035;
      sun.shadow.camera.updateProjectionMatrix();
      dome.scale.setScalar(distance + bounds.span * 9);
      dome.position.set(x, y, z);
    };
    const draw = () => { if (!disposed && !globalThis.document?.hidden) renderer.render(scene, camera); };
    // Ground plane beneath the content, sized to the frame. It is presentation
    // only: the island remains the world's landform, this keeps the camera from
    // looking off the edge of a small island into the void.
    let ground = null;
    const fitGround = (nextBounds, weather, palette) => {
      if (!nextBounds) return;
      const [x, y, z] = nextBounds.center;
      const extent = (nextBounds.reach ?? nextBounds.span) * 6 + 60;
      const rainy = /rain|雨|storm/i.test(weather || '');
      if (!ground) {
        ground = new THREE.Mesh(new THREE.CircleGeometry(1, 64),
          new THREE.MeshStandardMaterial({ color: '#7f915f', roughness: 0.95, metalness: 0, side: THREE.DoubleSide }));
        ground.name = 'ground'; ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
        scene.add(ground);
      }
      ground.position.set(x, y - 0.42, z);      ground.scale.setScalar(extent);
      ground.material.color.set(palette === 'victorian-archive' ? '#34383b' : rainy ? '#3e5148' : '#5d705a');
      ground.material.needsUpdate = true;
    };
    // The drag hint shares the chip row instead of floating in a corner: on a
    // phone a free-floating caption landed on top of the chips.
    let legend = null;
    const makeLegend = create => {
      if (!legend) { legend = create.call(globalThis.document, 'p'); legend.className = 'scene-legend'; legend.textContent = '拖动环视'; }
      return legend;
    };
    // Weather and resource totals belong on the scene, not in a full-width bar
    // under it. Text is set through textContent only; nothing here is markup.
    let overlay = null;
    const syncOverlay = state => {
      const create = globalThis.document?.createElement;
      if (!create) return;
      const weather = String(state.world.environment?.weather || '').trim();
      const resources = (Array.isArray(state.world.resources) ? state.world.resources : []).slice(0, 6)
        .map(resource => [String(resource.name || resource.id || '').trim(), `${resource.quantity ?? '—'}${String(resource.unit || '')}`]);
      if (!overlay) {
        if (typeof shell.stage?.append !== 'function' || typeof shell.stage?.replaceChildren !== 'function') return;
        overlay = create.call(globalThis.document, 'div'); overlay.className = 'scene-overlay'; overlay.hidden = true; shell.stage.append(overlay);
      }
      const signature = JSON.stringify([weather, resources]);
      if (overlay.dataset.signature === signature) return;
      overlay.dataset.signature = signature;
      const chips = [];
      const chip = (className = 'scene-chip') => { const element = create.call(globalThis.document, 'span'); element.className = className; return element; };
      if (weather) { const weatherChip = chip(); weatherChip.textContent = weather; chips.push(weatherChip); }
      for (const [name, amount] of resources) {
        const resourceChip = chip(), value = create.call(globalThis.document, 'b');
        if (name) { const label = create.call(globalThis.document, 'span'); label.textContent = `${name} `; resourceChip.append(label); }
        value.textContent = amount; resourceChip.append(value); chips.push(resourceChip);
      }
      // With nothing to say there is no box at all: an empty overlay would
      // still paint chrome on the scene.
      if (!chips.length) { overlay.hidden = true; return; }
      overlay.hidden = false;
      // Reset belongs to the same row: as a separate absolutely placed control
      // it collided with the weather chip on a phone.
      Object.assign(shell.reset.style, { position: 'static', right: 'auto', top: 'auto', left: 'auto', bottom: 'auto', order: '-1' });
      overlay.replaceChildren(shell.reset, ...chips, makeLegend(create));
    };
    const update = state => {
      if (fallback) { fallback.update(state); return; }
      if (disposed) return;
      lastState = state;
      try {
        projectWorldDocument(state);
        const candidate = state.scene.document, nextKey = JSON.stringify(candidate);
        if (key !== nextKey) {
          if (!compiled) { compiled = compileScene(candidate, 'solid', { materials }); scene.add(compiled); }
          else prepareSceneUpdate(candidate, 'solid', { world: compiled, materials }).commit();
          accepted = structuredClone(candidate); key = nextKey;
        }
        delete shell.root.dataset.sceneError;
      } catch (error) { shell.root.dataset.sceneError = error.message; if (!compiled) throw error; }
      // Apply current world facts after every preview or incremental replacement.
      let projected;
      try { projected = projectWorldState(compiled, state, accepted); }
      catch (error) { shell.root.dataset.sceneError = error.message; return; }
      syncActorLabels(state, projected);
      syncRoomLabels(state, projected);
      syncPlaceLabels(state, projected);
      bounds = worldSceneBounds(projected, state.world.places);
      // The compiled terrain only covers the island the world was built on.
      // Extend the ground under the content so the frame never ends in a cut
      // plane, and let the fog dissolve its rim into the horizon colour.
      fitGround(bounds, state.world.environment?.weather, state.scene?.document?.style?.palette);
      syncConnections(state);
      canvas.setAttribute('aria-label', description(state));
      syncOverlay(state);
      const rainy = /rain|雨|storm/i.test(state.world.environment?.weather || '');
      const victorian = state.scene?.document?.style?.palette === 'victorian-archive';
      // Rain darkens and cools the scene; the sky dome and fog follow so the
      // horizon does not stay sunny behind a rainy world.
      const domeTop = dome.material.uniforms.top.value, domeHorizon = dome.material.uniforms.horizon.value, domeBottom = dome.material.uniforms.bottom.value;
      domeTop.set(victorian ? '#202b34' : rainy ? '#5d7b83' : '#8fb4c6');
      domeHorizon.set(victorian ? '#65727a' : rainy ? '#9aa9a2' : '#dfe8dc');
      domeBottom.set(victorian ? '#3a4246' : rainy ? '#6e8580' : '#9eb6a6');
      scene.background.set(victorian ? '#2b343a' : rainy ? '#93aaa4' : sky);
      scene.fog.color.set(victorian ? '#65727a' : rainy ? '#9aa9a2' : '#dfe8dc');
      sun.intensity = victorian ? 2.1 : rainy ? 1.75 : 2.5; fill.intensity = victorian ? 0.72 : rainy ? 0.42 : 0.34;
      warmRim.intensity = victorian ? 13 : 6; coolRim.intensity = victorian ? 4.5 : 5;
      setCamera(); draw();
    };
    const resize = () => {
      renderer.setSize(Math.max(1, shell.stage.clientWidth), Math.max(1, shell.stage.clientHeight), false);
      camera.aspect = Math.max(1, shell.stage.clientWidth) / Math.max(1, shell.stage.clientHeight); setCamera(); draw();
    };
    if (typeof ResizeObserver !== 'undefined') { observer = new ResizeObserver(resize); observer.observe(shell.stage); }
    listen(canvas, 'pointerdown', e => {
      if (e.button !== 0 || e.isPrimary === false) return;
      pointer = { id: e.pointerId, x: e.clientX, y: e.clientY, yaw, pitch };
      canvas.setPointerCapture?.(e.pointerId); canvas.style.cursor = 'grabbing';
    });
    listen(canvas, 'pointermove', e => {
      if (!pointer || e.pointerId !== pointer.id) return;
      yaw = pointer.yaw - (e.clientX - pointer.x) * 0.005;
      pitch = clamp(pointer.pitch + (e.clientY - pointer.y) * 0.004, 0.18, 1.35); setCamera(); draw();
    });
    const end = e => { if (!pointer || e.pointerId !== pointer.id) return; const id = pointer.id; pointer = null; if (canvas.hasPointerCapture?.(id)) canvas.releasePointerCapture(id); canvas.style.cursor = 'grab'; };
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) listen(canvas, event, end);
    listen(canvas, 'wheel', e => { e.preventDefault(); zoom = clamp(zoom * Math.exp(clamp(e.deltaY, -200, 200) * 0.0015), 0.45, 2.2); setCamera(); draw(); }, { passive: false });
    listen(shell.reset, 'click', () => { yaw = 0.62; pitch = 0.58; zoom = 0.78; setCamera(); draw(); });
    listen(document, 'visibilitychange', draw);
    listen(canvas, 'webglcontextlost', e => { e.preventDefault(); if (disposed) return; disposed = true; release(); fallback = makeFallback(shell, lastState); });
    update(initialState); resize();
    return { get mode() { return fallback ? 'fallback' : '3d'; }, update, dispose() { if (fallback) { fallback.dispose(); fallback = null; return; } if (disposed) return; disposed = true; release(); shell.root.remove(); } };
  } catch (error) { disposed = true; release(); throw error; }
}

export async function createWorldScene(shell, state) {
  shell.reset.setAttribute('aria-label', '重置世界视角');
  try {
    // The prototype server exposes geometry modules at /geometry/*; relative
    // imports from the browser URL would incorrectly resolve to /prototypes/*.
    const [THREE, compiler, materials] = await Promise.all([import('/vendor/three.module.js'), import('/geometry/scene-compiler.js'), import('/geometry/materials.js')]);
    return buildWorldThree(THREE, shell, state, compiler, materials);
  } catch { return makeFallback(shell, state); }
}
