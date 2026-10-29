import * as THREE from 'three';
import { group, mesh, instances, exposedVoxelMesh } from './primitives.js';
import { solidCamera } from './solid.js';
import { libraryScene } from './scene-document.js';

export const voxelCamera = solidCamera;
const DEFAULT_UNIT = 0.42;
const PARTS = ['terrain', 'library', 'interior', 'porch', 'bridge', 'nature'];
const key = (x, y, z) => `${x},${y},${z}`;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

class Voxels {
  constructor(unit) { this.unit = unit; this.cells = new Map(); }
  set(x, y, z, material) { this.cells.set(key(x, y, z), { x, y, z, material }); }
  // 斜面单元:顶面沿 axis 从 hLow(低侧)斜到 hHigh(高侧),高度均为格单位,可大于 1。
  setRamp(x, y, z, material, axis, sign, hLow, hHigh) {
    this.cells.set(key(x, y, z), { x, y, z, material, ramp: { axis, sign, hLow, hHigh } });
  }
  fill(x0, x1, y0, y1, z0, z1, material) {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) for (let z = z0; z <= z1; z++) this.set(x, y, z, material);
  }
  build(parent, materials, name) {
    return exposedVoxelMesh(parent, materials, [...this.cells.values()], this.unit, name);
  }
}

export function buildVoxel(materials, edited = false, details = true, cutaway = false, document = libraryScene, options = {}) {
  const world = new THREE.Group();
  const requested = new Set(Array.isArray(options.parts) ? options.parts : PARTS);
  const parts = world.userData.parts = {};
  const configuredUnit = document.style?.voxelUnit;
  // Bound resolution so a bad style value cannot generate an unbounded voxel grid.
  const unit = Number.isFinite(configuredUnit) && configuredUnit > 0 ? clamp(configuredUnit, 0.2, 1) : DEFAULT_UNIT;
  world.userData.voxelUnit = unit;
  const objects = document.objects || [];
  const regions = document.regions || [];
  for (const name of PARTS) {
    if (!requested.has(name)) continue;
    const part = parts[name] = group(world, name);
    part.userData.voxelUnit = unit;
    switch (name) {
      case 'terrain':
        for (const region of regions) {
          if (region.kind === 'water') buildWater(part, materials, region);
          if (region.kind === 'island') buildIsland(part, materials, region, unit);
        }
        break;
      case 'library': {
        const record = objects.find(object => object.kind === 'library');
        if (record) buildLibrary(part, materials, record, unit, cutaway);
        break;
      }
      case 'interior': {
        const record = objects.find(object => object.kind === 'library');
        if (record) buildInterior(part, materials, record, unit);
        break;
      }
      case 'porch': {
        const record = objects.find(object => object.kind === 'porch');
        if (record) buildPorch(part, materials, record, unit, edited);
        break;
      }
      case 'bridge': {
        const record = objects.find(object => object.kind === 'bridge');
        if (record) buildBridge(part, materials, record, unit, edited);
        break;
      }
      case 'nature':
        // Trees are scene objects, not optional decoration; details only controls reeds/garden extras.
        if (document.profile !== 'world' && details) buildNatureExtras(part, materials, regions, unit);
        for (const record of objects) if (record.kind === 'tree') buildTree(part, materials, record, unit);
        break;
    }
  }
  // Village parts are per-object: one part per house and per path, each independently rebuildable.
  for (const id of requested) {
    if (PARTS.includes(id)) continue;
    if (id.startsWith('house:')) {
      const record = objects.find(item => item?.id === id.slice(6) && item.kind === 'house');
      if (!record) continue;
      const part = parts[id] = group(world, id);
      part.userData.voxelUnit = unit;
      buildLibrary(part, materials, record, unit, false);
    } else if (id.startsWith('path:')) {
      const record = objects.find(item => item?.id === id.slice(5) && item.kind === 'path');
      if (!record) continue;
      const part = parts[id] = group(world, id);
      part.userData.voxelUnit = unit;
      buildPathVoxel(part, materials, record, regions, unit);
    } else if (id.startsWith('character:')) {
      const record = objects.find(item => item?.id === id.slice(10) && item.kind === 'character');
      if (!record) continue;
      const part = parts[id] = group(world, id);
      part.userData.voxelUnit = unit;
      buildCharacterVoxel(part, materials, record, unit);
    } else if (id.startsWith('room:')) {
      const record = objects.find(item => item?.id === id.slice(5) && item.kind === 'room');
      if (!record) continue;
      const part = parts[id] = group(world, id);
      part.userData.voxelUnit = unit;
      buildRoomVoxel(part, materials, record, unit);
    }
  }
  return world;
}

function applyTransform(part, record) {
  part.position.set(...(record.transform?.position || record.position || [0, 0, 0]));
  part.rotation.y = record.transform?.rotation || 0;
  part.userData.recordId = record.id;
}

// A fitted lattice retains voxel batching while making footprint and floor planes exact.
function fittedGrid(parent, unit, width, depth, floor, height = unit) {
  const nx = Math.max(1, Math.ceil(width / unit));
  const nz = Math.max(1, Math.ceil(depth / unit));
  const ny = Math.max(1, Math.ceil(height / unit));
  const frame = group(parent, 'voxel-grid');
  frame.position.set(-width / 2, floor, -depth / 2);
  frame.scale.set(width / (nx * unit), height / (ny * unit), depth / (nz * unit));
  return { frame, nx, nz, ny, dx: width / nx, dy: height / ny, dz: depth / nz };
}

function buildWater(parent, m, record) {
  const water = mesh(parent, new THREE.PlaneGeometry(...record.size), m.water,
    [record.center[0], record.elevation, record.center[1]], 'water');
  water.rotation.x = -Math.PI / 2;
  water.userData.recordId = record.id;
}

function buildIsland(parent, m, record, unit) {
  const island = group(parent, 'island');
  island.userData.recordId = record.id;
  island.position.set(record.center[0] - unit / 2, record.elevation, record.center[1] - unit / 2);
  const v = new Voxels(unit);
  const extent = Math.ceil(record.radius * (1 + record.irregularity * 1.45) / unit);
  const thickness = Math.max(1, Math.ceil(clamp(record.radius * 0.08, 0.5, 1.2) / unit));
  for (let x = -extent; x <= extent; x++) for (let z = -extent; z <= extent; z++) {
    const a = Math.atan2(z, x);
    const radius = record.radius * (1 + record.irregularity * (Math.sin(a * 3) + Math.cos(a * 5) * 0.45));
    const distance = Math.hypot(x * unit, z * unit);
    if (distance > radius) continue;
    v.fill(x, x, -thickness, -2, z, z, 'earth');
    v.set(x, -1, z, radius - distance < unit * 1.5 ? 'stoneDark' : 'grass');
  }
  v.build(island, m, 'island');
}

function libraryGrid(parent, record, unit) {
  applyTransform(parent, record);
  parent.userData.bounds = { ...record.bounds };
  const { width, depth, floor, wallHeight } = record.bounds;
  return fittedGrid(parent, unit, width, depth, floor, wallHeight);
}

function buildLibrary(parent, m, record, unit, cutaway) {
  const { frame, nx, nz, ny, dx, dy } = libraryGrid(parent, record, unit);
  const { width, wallHeight } = record.bounds;
  const v = new Voxels(unit);
  v.fill(0, nx - 1, -2, -2, 0, nz - 1, 'stone');
  v.fill(0, nx - 1, -1, -1, 0, nz - 1, 'woodLight');
  const entrance = record.entrance;
  const doorWidth = entrance?.wall === 'front' ? clamp(entrance.width, 0, width) : 0;
  const doorHeight = entrance?.wall === 'front' ? clamp(entrance.height, 0, wallHeight) : 0;
  const windows = (record.windows || []).filter(window => window.wall === 'front');
  for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) for (let z = 0; z < nz; z++) {
    const front = z === nz - 1;
    const back = z === 0;
    const left = x === 0;
    const right = x === nx - 1;
    if (!front && !back && !left && !right) continue;
    if (cutaway && (front || right)) continue;
    const x0 = x * dx - width / 2, x1 = x0 + dx;
    // Remove every intersecting cell, never narrowing the requested clear opening.
    if (front && doorWidth > 0 && x0 < doorWidth / 2 - 1e-9 && x1 > -doorWidth / 2 + 1e-9 && y * dy < doorHeight - 1e-9) continue;
    const timber = (left || right) && (front || back) || y === 0 || y === ny - 1;
    let material = timber ? 'wood' : 'plaster';
    if (front && !timber && y * dy > wallHeight * 0.28 && (y + 1) * dy < wallHeight * 0.82 &&
      windows.some(window => Math.abs((x0 + x1) / 2 - window.offset) < Math.min(0.8, width * 0.09))) material = 'glass';
    v.set(x, y, z, material);
  }
  v.build(frame, m, 'library');
  if (!cutaway) buildRoof(parent, m, record, unit);
}

function buildRoof(parent, m, record, unit) {
  const { width, depth, floor, wallHeight } = record.bounds;
  const overhang = Math.max(0, record.roof?.overhang ?? 0);
  const rise = Math.max(0, record.roof?.rise ?? 0);
  const { frame, nx, nz, ny } = fittedGrid(parent, unit, width + 2 * overhang, depth + 2 * overhang,
    floor + wallHeight - (rise === 0 ? unit : 0), rise || unit);
  frame.name = 'roof-grid';
  const v = new Voxels(unit);
  if (rise === 0) {
    for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) v.set(x, 0, z, x === 0 || x === nx - 1 ? 'roofLight' : 'roof');
    v.build(frame, m, 'roof');
    return;
  }
  // 连续坡面:每列一个斜面单元,高度取列边界处的连续剖面值,不再逐格堆台阶。
  const outerHalf = (nx - 1) / 2;
  const ridgeDistance = nx % 2 ? 0 : 0.5;
  const profile = boundary => {
    if (outerHalf <= ridgeDistance) return ny;
    const slope = clamp((outerHalf - Math.abs(boundary - nx / 2)) / (outerHalf - ridgeDistance), 0, 1);
    return slope * ny;
  };
  for (let x = 0; x < nx; x++) {
    const hL = profile(x), hR = profile(x + 1);
    const hLow = Math.min(hL, hR), hHigh = Math.max(hL, hR);
    const material = x === 0 || x === nx - 1 ? 'roofLight' : 'roof';
    for (let z = 0; z < nz; z++) {
      if (Math.abs(hR - hL) <= 0.05) {
        const top = Math.max(1, Math.round((hL + hR) / 2));
        v.fill(x, x, 0, top - 1, z, z, material);
      } else {
        v.setRamp(x, 0, z, material, 'x', hR > hL ? 1 : -1, hLow, hHigh);
      }
    }
  }
  v.build(frame, m, 'roof');
}

function buildInterior(parent, m, record, unit) {
  const { frame, nx, nz, ny } = libraryGrid(parent, record, unit);
  const v = new Voxels(unit);
  // All furniture is laid out in the library's own footprint and floor frame.
  const back = Math.min(nz - 2, 1);
  const shelfTop = Math.max(1, Math.floor(ny * 0.72));
  for (const [start, end] of [[0.12, 0.42], [0.58, 0.88]]) {
    const x0 = clamp(Math.floor(nx * start), 1, nx - 2);
    const x1 = clamp(Math.floor(nx * end), x0, nx - 2);
    v.fill(x0, x1, 0, shelfTop, back, back, 'wood');
    const front = Math.min(nz - 2, back + 1);
    for (let y = 0; y < shelfTop; y += 2) for (let x = x0; x <= x1; x++) {
      v.set(x, y, front, 'woodLight');
      if (y + 1 < shelfTop) v.set(x, y + 1, front, ['bookRed', 'bookBlue', 'bookGold'][(x + y) % 3]);
    }
  }
  const x0 = Math.max(1, Math.floor(nx * 0.3)), x1 = Math.min(nx - 2, Math.floor(nx * 0.7));
  const z0 = Math.max(1, Math.floor(nz * 0.4)), z1 = Math.min(nz - 2, Math.floor(nz * 0.6));
  const tableTop = Math.max(1, Math.floor(ny * 0.22));
  v.fill(x0, x1, tableTop, tableTop, z0, z1, 'wood');
  for (const x of [x0, x1]) for (const z of [z0, z1]) v.fill(x, x, 0, tableTop - 1, z, z, 'wood');
  const seatZ = Math.min(nz - 2, z1 + 2);
  for (let x = x0; x <= x1; x += Math.max(2, Math.round((x1 - x0) / 2))) v.fill(x, x, 0, tableTop - 1, seatZ, seatZ, 'woodLight');
  v.set(Math.floor((x0 + x1) / 2), tableTop + 1, Math.floor((z0 + z1) / 2), 'cream');
  v.build(frame, m, 'interior');
}

function buildPorch(parent, m, record, unit, edited) {
  applyTransform(parent, record);
  parent.userData.bounds = { ...record.bounds };
  parent.userData.variant = edited ? 'lookout' : 'porch';
  const { width, depth, floor } = record.bounds;
  const { frame, nx, nz } = fittedGrid(parent, unit, width, depth, floor);
  const v = new Voxels(unit);
  const onDeck = (x, z) => x >= 0 && x < nx && z >= 0 && z < nz &&
    (!edited || ((x + 0.5 - nx / 2) / (nx / 2)) ** 2 + ((z + 0.5 - nz / 2) / (nz / 2)) ** 2 <= 1);
  for (let x = 0; x < nx; x++) for (let z = 0; z < nz; z++) {
    if (!onDeck(x, z)) continue;
    v.set(x, -1, z, 'woodLight');
    if (edited && z >= nz / 2 && (!onDeck(x - 1, z) || !onDeck(x + 1, z) || !onDeck(x, z + 1))) {
      const rail = Math.max(1, Math.round(1 / unit));
      v.set(x, rail, z, 'woodLight');
      if (x % 3 === 0 || z % 3 === 0) v.fill(x, x, 0, rail - 1, z, z, 'wood');
    }
  }
  if (edited) {
    const x = Math.floor(nx * 0.65), z = Math.floor(nz * 0.6);
    const stand = Math.max(1, Math.round(1.5 / unit));
    v.fill(x, x, 0, stand - 1, z, z, 'wood');
    for (let i = 0; i < Math.min(3, nz - z); i++) v.set(x, stand + Math.floor(i / 2), z + i, 'dark');
  } else {
    const height = Math.max(2, Math.round(3.4 / unit));
    for (const x of [0, nx - 1]) for (const z of [0, nz - 1]) v.fill(x, x, 0, height - 1, z, z, 'wood');
    v.fill(0, nx - 1, height, height, 0, nz - 1, 'roof');
  }
  v.build(frame, m, edited ? 'lookout' : 'porch');
}

function buildBridge(parent, m, record, unit, edited) {
  const from = record.from.point, to = record.to.point;
  const length = Math.hypot(to[0] - from[0], to[2] - from[2]);
  parent.position.set(...from);
  parent.rotation.y = -Math.atan2(to[2] - from[2], to[0] - from[0]);
  parent.userData.recordId = record.id;
  parent.userData.from = [...from];
  parent.userData.to = [...to];
  parent.userData.width = record.width;
  // A vertical-only endpoint pair has no horizontal walkable footprint.
  if (length < 1e-9) return;
  const segments = Math.max(2, Math.round(record.segments));
  const columns = Math.max(2, segments, Math.ceil(length / unit));
  const across = Math.max(1, Math.ceil(record.width / unit));
  const frame = group(parent, 'voxel-grid');
  frame.position.z = -record.width / 2;
  frame.scale.set(length / (columns * unit), 1, record.width / (across * unit));
  const rise = to[1] - from[1];
  const knotHeight = i => rise * i / segments + record.arch * Math.sin(Math.PI * i / segments);
  const profile = t => {
    const u = t * segments, i = Math.min(segments - 1, Math.floor(u)), f = u - i;
    return knotHeight(i) * (1 - f) + knotHeight(i + 1) * f;
  };
  const heights = Array.from({ length: columns }, (_, i) => Math.round(profile(i / (columns - 1)) / unit));
  const v = new Voxels(unit);
  const railHeight = Math.max(1, Math.round(1.1 / unit));
  for (let x = 0; x < columns; x++) {
    const top = heights[x];
    // Each tread extends down to both neighbours. Even large Y changes share a
    // full face, rather than leaving disconnected, diagonally touching planks.
    const bottom = Math.min(top, heights[Math.max(0, x - 1)], heights[Math.min(columns - 1, x + 1)]) - 1;
    v.fill(x, x, bottom, top - 1, 0, across - 1, edited ? 'terracotta' : 'woodLight');
    if (across >= 5) for (const z of [0, across - 1]) {
      const previousRail = heights[Math.max(0, x - 1)] + railHeight;
      v.fill(x, x, Math.min(top + railHeight, previousRail), Math.max(top + railHeight, previousRail), z, z, 'wood');
      if (x === 0 || x === columns - 1 || x % Math.max(1, Math.round(columns / 6)) === 0) v.fill(x, x, top, top + railHeight, z, z, 'wood');
    }
  }
  v.build(frame, m, 'bridge');
}

function buildNatureExtras(parent, m, regions, unit) {
  const island = regions.find(region => region.kind === 'island');
  if (!island) return;
  const reeds = [];
  for (let i = 0; i < 160; i++) {
    const a = (i * 0.61803398875 % 1) * Math.PI * 2;
    const radius = island.radius + 0.7 + (i % 17) / 8;
    reeds.push({ p: [island.center[0] + Math.cos(a) * radius, island.elevation - 0.75, island.center[1] + Math.sin(a) * radius], s: [0.09, 0.6 + (i % 9) * 0.12, 0.09] });
  }
  const water = regions.find(region => region.kind === 'water');
  instances(parent, m.reed, reeds, 'reeds');
  const ripples = [];
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * Math.PI * 2, radius = island.radius + 1.5 + (i % 4);
    ripples.push({ p: [island.center[0] + Math.cos(a) * radius, (water?.elevation ?? island.elevation - 1.23) + 0.025, island.center[1] + Math.sin(a) * radius], s: [0.5, 0.01, 0.5] });
  }
  instances(parent, m.waterLight, ripples, 'water-ripples');
}

// Rasterize a lane as stone cells on top of its host island's voxel ground grid.
function buildPathVoxel(parent, m, record, regions, unit) {
  const points = record.points;
  const islandRadius = (region, angle) =>
    region.radius * (1 + region.irregularity * (Math.sin(angle * 3) + Math.cos(angle * 5) * 0.45));
  const host = regions.find(region => {
    if (region?.kind !== 'island') return false;
    const dx = points[0][0] - region.center[0], dz = points[0][1] - region.center[1];
    return Math.hypot(dx, dz) <= islandRadius(region, Math.atan2(dz, dx));
  });
  if (!host) return;
  parent.position.set(host.center[0] - unit / 2, host.elevation, host.center[1] - unit / 2);
  parent.userData.recordId = record.id;
  const v = new Voxels(unit);
  const toCell = (wx, wz) => [
    Math.floor((wx - (host.center[0] - unit / 2)) / unit),
    Math.floor((wz - (host.center[1] - unit / 2)) / unit),
  ];
  const half = record.width / 2;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1];
    const length = Math.hypot(bx - ax, bz - az);
    const steps = Math.max(1, Math.ceil(length / (unit * 0.5)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps, wx = ax + (bx - ax) * t, wz = az + (bz - az) * t;
      const [cx, cz] = toCell(wx, wz);
      const reach = Math.ceil(half / unit) + 1;
      for (let ox = -reach; ox <= reach; ox++) for (let oz = -reach; oz <= reach; oz++) {
        const px = (cx + ox + 0.5) * unit + host.center[0] - unit / 2;
        const pz = (cz + oz + 0.5) * unit + host.center[1] - unit / 2;
        const vx = bx - ax, vz = bz - az;
        const u = Math.max(0, Math.min(1, ((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz || 1)));
        if (Math.hypot(px - (ax + vx * u), pz - (az + vz * u)) <= half) v.set(cx + ox, 0, cz + oz, 'stone');
      }
    }
  }
  v.build(parent, m, 'path');
}

// Voxel villager: four cell layers (legs, body, head) standing on its spawn point.
// Route metadata rides on the part for the UI-side walking animation.
function buildCharacterVoxel(parent, m, record, unit) {
  const [x, y, z] = record.position;
  parent.position.set(x, y, z);
  const figure = group(parent, 'character-figure');
  parent.userData.displayMarker = figure;
  const frame = group(figure, 'voxel-grid');
  frame.position.set(-unit / 2, 0, -unit / 2);
  const v = new Voxels(unit);
  const r = Math.max(1, Math.round(0.14 / unit));
  v.fill(-r, r, 0, 0, -r, r, 'wood');
  v.fill(-r, r, 1, 2, -r, r, 'terracotta');
  v.fill(-r, r, 3, 3, -r, r, 'cream');
  v.set(-r - 1, 4, 0, 'roofLight'); v.set(r + 1, 4, 0, 'roofLight');
  v.set(0, 4, -r - 1, 'roofLight'); v.set(0, 4, r + 1, 'roofLight');
  v.build(frame, m, 'character');
  frame.traverse(node => { if (node.isMesh) node.userData.noBatch = true; });
  parent.userData.route = Array.isArray(record.route) ? record.route : null;
  parent.userData.speed = record.speed ?? 1.2;
  parent.userData.home = [x, y, z];
}

function buildRoomVoxel(parent, m, record, unit) {
  const { frame, nx, nz, ny } = libraryGrid(parent, record, unit);
  parent.userData.roomId = record.id;
  parent.userData.roomName = record.name;
  const v = new Voxels(unit);
  // The floor's top face is exactly at the declared room floor elevation.
  v.fill(0, nx - 1, -1, -1, 0, nz - 1, 'woodLight');
  for (let y = 0; y < ny; y++) {
    for (let z = 0; z < nz; z++) v.set(0, y, z, y === 0 ? 'wood' : 'plaster');
    for (let x = 1; x < nx; x++) v.set(x, y, 0, y === 0 ? 'wood' : 'plaster');
  }
  v.build(frame, m, 'room');
}

function buildTree(parent, m, record, unit) {
  const tree = group(parent, 'tree');
  tree.position.set(...record.position);
  tree.scale.setScalar(record.scale);
  tree.userData.recordId = record.id;
  const frame = group(tree, 'voxel-grid');
  frame.position.set(-unit / 2, 0, -unit / 2);
  const v = new Voxels(unit);
  const trunkRadius = Math.max(0, Math.round(0.25 / unit - 0.5));
  v.fill(-trunkRadius, trunkRadius, 0, Math.ceil(4.3 / unit) - 1, -trunkRadius, trunkRadius, 'wood');
  const radius = 2.5, crownY = 5.6, crownHeight = 2.2;
  const extent = Math.ceil(radius / unit);
  for (let x = -extent; x <= extent; x++) for (let z = -extent; z <= extent; z++) {
    for (let y = Math.floor((crownY - crownHeight) / unit); y < Math.ceil((crownY + crownHeight) / unit); y++) {
      const dy = (y + 0.5) * unit - crownY;
      if ((x * unit / radius) ** 2 + (z * unit / radius) ** 2 + (dy / crownHeight) ** 2 <= 1) v.set(x, y, z, dy > 0.7 ? 'leafLight' : 'leaf');
    }
  }
  v.build(frame, m, 'tree');
}
