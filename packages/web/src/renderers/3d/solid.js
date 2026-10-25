import * as THREE from 'three';
import { group, mesh, box, texturedBox, cylinder, sphere, beam, instances, rng } from './primitives.js';
import { libraryScene } from './scene-document.js';
import { islandContains } from './scene-validation.js';

export const solidCamera = {
  island: { position: [27, 22, 31], target: [0, 2, 0] },
  interior: { position: [2.6, 3.7, 2.5], target: [-0.8, 2.8, -2.5] },
  detail: { position: [14, 8, 16], target: [2, 2.8, 1] },
};

const partNames = ['terrain', 'library', 'interior', 'porch', 'bridge', 'nature'];

export function buildSolid(materials, edited = false, details = true, cutaway = false, document = libraryScene, options = {}) {
  const world = new THREE.Group();
  const selected = new Set(options.parts ?? partNames);
  const parts = {};
  const regions = document.regions || [];
  const objects = document.objects || [];
  const islands = regions.filter(region => region.kind === 'island');
  const primaryIsland = islands[0];
  const waterRegion = regions.find(region => region.kind === 'water');
  for (const name of partNames) {
    if (!selected.has(name)) continue;
    const parent = parts[name] = group(world, name);
    if (name === 'terrain') {
      for (const region of regions) {
        if (region.kind === 'water') {
          const water = mesh(parent, new THREE.PlaneGeometry(...region.size), materials.water,
            [region.center[0], region.elevation, region.center[1]], region.id);
          water.rotation.x = -Math.PI / 2;
        } else if (region.kind === 'island') buildIsland(parent, materials, region, details);
      }
      if (details && primaryIsland) buildPath(islandFrame(parent, primaryIsland, 'island-path'), materials);
    } else if (name === 'library' || name === 'interior') {
      for (const object of objects.filter(object => object.kind === 'library')) {
        const local = objectFrame(parent, object);
        if (name === 'library') buildLibrary(local, materials, object, cutaway);
        else buildInterior(local, materials, object);
      }
    } else if (name === 'porch') {
      for (const object of objects.filter(object => object.kind === 'porch')) {
        const local = objectFrame(parent, object);
        const { width, depth, floor } = object.bounds;
        const composition = group(local, edited ? 'observatory' : 'porch-composition');
        composition.scale.set(width / (edited ? 6.8 : 6.5), 1, depth / (edited ? 6.8 : 2.6));
        composition.position.y = floor;
        const canonical = group(composition, 'porch-local');
        canonical.position.set(0, edited ? -1.49 : -1.445, edited ? -5.4 : -4.65);
        if (edited) buildObservatory(canonical, materials);
        else buildPorch(canonical, materials);
      }
    } else if (name === 'bridge') {
      for (const object of objects.filter(object => object.kind === 'bridge')) {
        buildBridge(group(parent, object.id), materials, edited, object);
      }
    } else if (name === 'nature') {
      if (details && primaryIsland) {
        buildReeds(parent, materials, primaryIsland, waterRegion);
        buildGarden(islandFrame(parent, primaryIsland, 'island-garden'), materials);
      }
      buildTrees(parent, materials, objects.filter(object => object.kind === 'tree'));
    }
  }
  // Village parts are per-object: one part per house and per path, each independently rebuildable.
  for (const id of selected) {
    if (partNames.includes(id)) continue;
    if (id.startsWith('house:')) {
      const object = objects.find(item => item?.id === id.slice(6) && item.kind === 'house');
      if (!object) continue;
      buildLibrary(objectFrame(parts[id] = group(world, id), object), materials, object, false);
    } else if (id.startsWith('path:')) {
      const object = objects.find(item => item?.id === id.slice(5) && item.kind === 'path');
      if (!object) continue;
      buildLane(parts[id] = group(world, id), materials, object, islands);
    } else if (id.startsWith('character:')) {
      const object = objects.find(item => item?.id === id.slice(10) && item.kind === 'character');
      if (!object) continue;
      buildCharacterSolid(parts[id] = group(world, id), materials, object);
    }
  }
  world.userData.parts = parts;
  return world;
}

// A stylized villager: legs, torso, head and a straw hat, standing at its spawn point.
// Route metadata rides on the part for the UI-side walking animation.
function buildCharacterSolid(parent, m, object) {
  const [x, y, z] = object.position;
  parent.position.set(x, y, z);
  cylinder(parent, m.wood, 0.08, 0.11, 0.55, [-0.11, 0.28, 0], 8, 'leg');
  cylinder(parent, m.wood, 0.08, 0.11, 0.55, [0.11, 0.28, 0], 8, 'leg');
  cylinder(parent, m.terracotta, 0.16, 0.21, 0.62, [0, 0.86, 0], 10, 'torso');
  sphere(parent, m.cream, 0.16, [0, 1.34, 0], [1, 1.05, 1], 1, 'head');
  cylinder(parent, m.roofLight, 0.03, 0.2, 0.15, [0, 1.52, 0], 10, 'hat-crown');
  cylinder(parent, m.roof, 0.33, 0.36, 0.04, [0, 1.45, 0], 12, 'hat-brim');
  parent.userData.route = Array.isArray(object.route) ? object.route : null;
  parent.userData.speed = object.speed ?? 1.2;
  parent.userData.home = [x, y, z];
}

// A lane is a flat stone walkway following its polyline, resting on its host island's elevation.
function buildLane(parent, m, object, islands) {  const points = object.points;
  const host = islands.find(region => islandContains(region, points[0][0], points[0][1]));
  if (!host) return;
  const elevation = host.elevation;
  const stones = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1];
    const dx = bx - ax, dz = bz - az;
    const length = Math.hypot(dx, dz);
    if (length < 1e-6) continue;
    const yaw = Math.atan2(dx, dz);
    const base = box(parent, m.earth, [object.width + 0.24, 0.14, length + 0.1],
      [(ax + bx) / 2, elevation + 0.02, (az + bz) / 2], 'lane-base');
    base.rotation.y = yaw;
    const steps = Math.max(2, Math.round(length / 0.62));
    const random = rng((object.id || 'lane').split('').reduce((seed, ch) => seed * 31 + ch.charCodeAt(0), 7) + i);
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const wobble = (random() - 0.5) * 0.16;
      stones.push({
        p: [ax + dx * t - dz / length * wobble, elevation + 0.1, az + dz * t + dx / length * wobble],
        s: [object.width * 0.66, 0.08, 0.44],
        r: [0, yaw + (random() - 0.5) * 0.25, 0],
      });
    }
  }
  instances(parent, m.stone, stones, 'lane-stones');
}

function objectFrame(parent, object) {
  const local = group(parent, object.id);
  local.position.set(...(object.transform?.position ?? object.position ?? [0, 0, 0]));
  const rotation = object.transform?.rotation ?? object.rotation ?? 0;
  local.rotation.y = object.transform?.rotationY ?? object.rotationY
    ?? (typeof rotation === 'number' ? rotation : (rotation[1] ?? rotation.y ?? 0));
  return local;
}

function islandFrame(parent, region, name) {
  const local = group(parent, name);
  local.position.set(region.center[0], region.elevation - 0.8, region.center[1]);
  local.scale.set(region.radius / 11.5, 1, region.radius / 11.5);
  return local;
}

function islandRadius(region, angle) {
  return region.radius * (1 + region.irregularity * (Math.sin(angle * 3) + Math.cos(angle * 5) * 0.45));
}

function buildIsland(parent, m, region, details) {
  const local = group(parent, region.id);
  local.position.set(region.center[0], region.elevation, region.center[1]);
  const segments = 64, rings = 8, positions = [], uvs = [], indices = [];
  for (let ring = 0; ring <= rings; ring++) for (let i = 0; i <= segments; i++) {
    const a = i / segments * Math.PI * 2;
    const radius = islandRadius(region, a) * ring / rings;
    positions.push(Math.cos(a) * radius, Math.sin(a * 4) * 0.035 * ring / rings, Math.sin(a) * radius);
    uvs.push(Math.cos(a) * ring / rings * 4, Math.sin(a) * ring / rings * 4);
    if (ring < rings && i < segments) {
      const n = ring * (segments + 1) + i;
      indices.push(n, n + 1, n + segments + 1, n + 1, n + segments + 2, n + segments + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices); geometry.computeVertexNormals();
  mesh(local, geometry, m.grass, [0, 0, 0], 'organic-island');
  const shore = [], shoreThickness = Math.min(0.42, region.radius * 0.15);
  for (let i = 0; i <= segments; i++) {
    const a = i / segments * Math.PI * 2, radius = islandRadius(region, a);
    shore.push(new THREE.Vector3(Math.cos(a) * radius, -shoreThickness, Math.sin(a) * radius));
  }
  mesh(local, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(shore), 96, shoreThickness, 5, false), m.earth, [0, 0, 0], 'island-shore');
  if (details) {
    const rocks = [];
    for (let i = 0; i < 34; i++) {
      const a = i / 64 * Math.PI * 2, r = islandRadius(region, a) * 0.94;
      const scale = Math.min(1, region.radius / 11.5);
      rocks.push({ p: [Math.cos(a) * r, -0.25 + Math.sin(i * 7) * 0.09, Math.sin(a) * r], s: [(0.65 + (i % 3) * 0.18) * scale, 0.38 * scale, 0.65 * scale], r: [0, -a, 0] });
    }
    instances(local, m.stoneDark, rocks, 'shore-stones');
  }
}

function buildPath(parent, m) {
  const stones = [];
  for (let i = 0; i < 8; i++) stones.push({ p: [5.3 + i * 0.65, 0.85, 3.9], s: [0.48, 0.1, 0.7], r: [0, Math.sin(i) * 0.2, 0] });
  for (let i = 0; i < 5; i++) stones.push({ p: [-1.2, 0.85, 4.3 + i * 0.7], s: [1.15, 0.1, 0.5], r: [0, Math.sin(i) * 0.1, 0] });
  instances(parent, m.stone, stones, 'stepping-stones');
}

function buildLibrary(parent, m, object, cutaway) {
  const { width, depth, wallHeight: height, floor } = object.bounds;
  const half = width / 2, front = depth / 2, top = floor + height;
  const opening = Math.min(object.entrance.width, width);
  const doorHeight = Math.min(object.entrance.height, height);
  box(parent, m.stone, [width + 0.8, 0.65, depth + 0.8], [0, floor - 0.18 - 0.325, 0], 'foundation');
  texturedBox(parent, m.woodLight, [width + 0.2, 0.18, depth + 0.2], [0, floor - 0.09, 0], 'floor');
  box(parent, m.plaster, [width, height, 0.25], [0, floor + height / 2, -front], 'back-wall');
  box(parent, m.plaster, [0.25, height, depth], [-half, floor + height / 2, 0], 'left-wall');
  if (!cutaway) {
    box(parent, m.plaster, [0.25, height, depth], [half, floor + height / 2, 0], 'right-wall');
    for (const side of [-1, 1]) {
      const start = side < 0 ? -half : opening / 2;
      const end = side < 0 ? -opening / 2 : half;
      buildFrontBay(parent, m, start, end, floor, height, front, object.windows || []);
    }
    if (height > doorHeight) box(parent, m.plaster, [opening, height - doorHeight, 0.25], [0, floor + (height + doorHeight) / 2, front], 'door-top-wall');
    // Jambs and lintel sit outside the specified clear opening, never across its floor.
    if ((width - opening) / 2 >= 0.18) for (const side of [-1, 1]) {
      box(parent, m.wood, [0.18, doorHeight, 0.2], [side * (opening / 2 + 0.09), floor + doorHeight / 2, front + 0.06], 'door-frame');
    }
    if (height - doorHeight >= 0.18) box(parent, m.wood, [opening + 0.36, 0.18, 0.2], [0, floor + doorHeight + 0.09, front + 0.06], 'door-lintel');
    const leafWidth = opening * 0.75;
    box(parent, m.woodLight, [0.1, doorHeight * 0.9, leafWidth], [-opening / 2 - 0.1, floor + doorHeight * 0.5, front + leafWidth / 2 + 0.17], 'open-door');
    sphere(parent, m.bookGold, 0.07, [-opening / 2 - 0.18, floor + doorHeight * 0.5, front + leafWidth], [1, 1, 1], 1);
  }
  for (const x of [-half, half]) for (const z of [-front, front]) {
    if (cutaway && (x > 0 || z > 0)) continue;
    if (z > 0 && Math.abs(x) - 0.16 < opening / 2) continue;
    box(parent, m.wood, [0.32, height, 0.32], [x, floor + height / 2, z], 'timber-post');
  }
  for (const y of [floor + 0.14, top - 0.14]) {
    box(parent, m.wood, [width + 0.35, 0.28, 0.3], [0, y, -front]);
    if (!cutaway) {
      if (y - 0.14 >= floor + doorHeight) box(parent, m.wood, [width + 0.35, 0.28, 0.3], [0, y, front]);
      else for (const side of [-1, 1]) {
        const span = (width - opening) / 2;
        if (span > 0) box(parent, m.wood, [span, 0.28, 0.3], [side * (opening / 2 + span / 2), y, front]);
      }
    }
  }
  for (const x of [-half, half]) {
    if (!cutaway || x < 0) box(parent, m.wood, [0.3, 0.28, depth + 0.2], [x, top - 0.14, 0]);
  }
  if (!cutaway) buildRoof(parent, m, object);
}

function buildFrontBay(parent, m, start, end, floor, height, front, windows) {
  const span = end - start;
  if (span <= 0) return;
  const center = (start + end) / 2;
  const window = windows.find(item => item.wall === 'front' && item.offset > start + 0.2 && item.offset < end - 0.2);
  if (!window || span < 0.8) {
    box(parent, m.plaster, [span, height, 0.25], [center, floor + height / 2, front], 'front-wall');
    return;
  }
  const windowWidth = Math.min(1.65, (window.offset - start) * 2 - 0.3, (end - window.offset) * 2 - 0.3);
  const bottom = floor + height * 0.22, windowHeight = height * 0.51;
  const left = window.offset - windowWidth / 2, right = window.offset + windowWidth / 2;
  box(parent, m.plaster, [left - start, height, 0.25], [(start + left) / 2, floor + height / 2, front], 'front-pier');
  box(parent, m.plaster, [end - right, height, 0.25], [(right + end) / 2, floor + height / 2, front], 'front-pier');
  box(parent, m.plaster, [windowWidth, bottom - floor, 0.25], [window.offset, (floor + bottom) / 2, front], 'window-sill-wall');
  const upper = height - (bottom - floor) - windowHeight;
  box(parent, m.plaster, [windowWidth, upper, 0.25], [window.offset, bottom + windowHeight + upper / 2, front], 'window-top-wall');
  for (const x of [left, right]) box(parent, m.wood, [0.13, windowHeight, 0.18], [x, bottom + windowHeight / 2, front + 0.18], 'window-frame');
  for (const y of [bottom, bottom + windowHeight]) box(parent, m.wood, [windowWidth + 0.13, 0.13, 0.22], [window.offset, y, front + 0.18], 'window-frame');
  box(parent, m.glass, [windowWidth, windowHeight, 0.08], [window.offset, bottom + windowHeight / 2, front + 0.23], 'window-glass');
  box(parent, m.woodLight, [0.09, windowHeight, 0.12], [window.offset, bottom + windowHeight / 2, front + 0.3]);
  box(parent, m.woodLight, [windowWidth, 0.09, 0.12], [window.offset, bottom + windowHeight / 2, front + 0.3]);
}

function buildRoof(parent, m, object) {
  const { width, depth, wallHeight, floor } = object.bounds;
  const { rise, overhang } = object.roof;
  const half = width / 2 + overhang, length = depth + overhang * 2, eave = floor + wallHeight;
  const shape = new THREE.Shape();
  shape.moveTo(-half, 0); shape.lineTo(0, rise); shape.lineTo(half, 0); shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: length, bevelEnabled: false });
  mesh(parent, geometry, m.roof, [0, eave, -length / 2], 'gable-roof');
  const tiles = [], rows = Math.max(1, Math.ceil(half / 0.58)), columns = Math.max(1, Math.ceil(length / 0.48));
  const angle = Math.atan2(rise, half), tileLength = Math.hypot(half, rise) / rows;
  for (const side of [-1, 1]) for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
    const t = (row + 0.5) / rows;
    tiles.push({ p: [side * half * t, eave + rise * (1 - t) + 0.035, -length / 2 + (col + 0.5) * length / columns], s: [tileLength + 0.03, 0.055, length / columns * 0.9], r: [0, 0, -side * angle] });
  }
  instances(parent, m.roofLight, tiles, 'roof-tile-rhythm');
  beam(parent, m.woodLight, [-half, eave, length / 2 + 0.06], [0, eave + rise, length / 2 + 0.06], 0.11);
  beam(parent, m.woodLight, [0, eave + rise, length / 2 + 0.06], [half, eave, length / 2 + 0.06], 0.11);
  beam(parent, m.woodLight, [0, eave + rise + 0.05, -length / 2], [0, eave + rise + 0.05, length / 2], 0.13, 'ridge');
}

function buildInterior(parent, m, object) {
  const { width, depth, wallHeight, floor } = object.bounds;
  const sx = Math.max(0.01, (width - 0.5) / 8.5), sz = Math.max(0.01, (depth - 0.5) / 6.8);
  const fitting = group(parent, 'fitted-furniture');
  fitting.position.y = floor;
  fitting.scale.set(sx, Math.min(wallHeight / 4.1, Math.sqrt(sx * sz)), sz);
  const interior = group(fitting, 'furniture-local');
  interior.position.y = -1.48;
  buildBookshelves(interior, m);
  texturedBox(interior, m.wood, [3.6, 0.18, 1.6], [0, 2.45, -0.4], 'reading-table');
  for (const x of [-1.5, 1.5]) for (const z of [-0.95, 0.15]) box(interior, m.wood, [0.16, 1, 0.16], [x, 1.98, z]);
  for (const x of [-1.3, 0, 1.3]) {
    cylinder(interior, m.woodLight, 0.45, 0.45, 0.16, [x, 1.98, 1], 12, 'stool');
    cylinder(interior, m.wood, 0.12, 0.16, 0.42, [x, 1.69, 1], 8);
  }
  box(interior, m.cream, [0.85, 0.04, 0.6], [0.3, 2.57, -0.4], 'open-book');
  cylinder(interior, m.bookGold, 0.07, 0.1, 0.5, [-0.65, 2.78, -0.4], 10, 'lamp-stem');
  cylinder(interior, m.cream, 0.22, 0.48, 0.48, [-0.65, 3.15, -0.4], 16, 'lamp-shade');
}

function buildBookshelves(parent, m) {
  for (const x of [-2.8, 2.8]) {
    box(parent, m.wood, [2.4, 3.5, 0.48], [x, 3.23, -3.1], 'bookshelf');
    box(parent, m.dark, [2.05, 3.18, 0.12], [x, 3.15, -2.82]);
    const books = [];
    for (let shelf = 0; shelf < 4; shelf++) {
      box(parent, m.woodLight, [2.2, 0.12, 0.65], [x, 1.65 + shelf * 0.9, -2.85]);
      for (let b = 0; b < 9; b++) books.push({ p: [x - 0.88 + b * 0.21, 1.94 + shelf * 0.9, -2.65], s: [0.14, 0.45 + (b % 3) * 0.07, 0.3], r: [0, 0, b % 4 === 0 ? 0.08 : 0] });
    }
    for (let color = 0; color < 3; color++) instances(parent, [m.bookRed, m.bookBlue, m.bookGold][color], books.filter((_, i) => i % 3 === color), 'books');
  }
}

function buildPorch(parent, m) {
  box(parent, m.woodLight, [6.5, 0.25, 2.6], [0, 1.32, 4.65], 'porch-deck');
  for (const x of [-2.8, 2.8]) {
    cylinder(parent, m.wood, 0.12, 0.15, 3.5, [x, 3.1, 5.5], 10, 'porch-column');
    beam(parent, m.woodLight, [x, 4.4, 3.5], [x, 4.4, 5.6], 0.1);
  }
  const canopy = box(parent, m.roof, [6.9, 0.18, 3.2], [0, 4.95, 4.5], 'porch-canopy');
  canopy.rotation.x = 0.16;
  for (const x of [-3, 3]) {
    box(parent, m.wood, [0.1, 1, 0.1], [x, 1.9, 5.6]);
    box(parent, m.wood, [0.1, 1, 0.1], [x, 1.9, 4.2]);
    box(parent, m.woodLight, [0.12, 0.12, 1.5], [x, 2.35, 4.9]);
  }
}

function buildObservatory(parent, m) {
  cylinder(parent, m.woodLight, 3.4, 3.4, 0.28, [0, 1.35, 5.4], 8, 'lookout-deck');
  for (let i = 0; i < 8; i++) {
    const a = i / 8 * Math.PI * 2, b = (i + 1) / 8 * Math.PI * 2;
    // Leave the library-facing half open; rails must not cross the entrance approach.
    if (i >= 4) continue;
    const p = [Math.cos(a) * 3, 1.95, 5.4 + Math.sin(a) * 3];
    const q = [Math.cos(b) * 3, 1.95, 5.4 + Math.sin(b) * 3];
    cylinder(parent, m.wood, 0.08, 0.08, 1.15, p, 8);
    beam(parent, m.woodLight, [p[0], 2.45, p[2]], [q[0], 2.45, q[2]], 0.07, 'lookout-rail');
  }
  beam(parent, m.dark, [1.4, 2.3, 6], [2.2, 3.1, 7], 0.13, 'telescope');
  cylinder(parent, m.wood, 0.08, 0.12, 1.6, [1.4, 1.9, 6], 8);
}

function buildBridge(parent, m, edited, object) {
  const from = new THREE.Vector3(...object.from.point), to = new THREE.Vector3(...object.to.point);
  const count = Math.max(2, Math.floor(object.segments));
  const direction = to.clone().sub(from);
  const across = new THREE.Vector3(direction.z, 0, -direction.x);
  if (across.lengthSq() === 0) across.set(1, 0, 0);
  else across.normalize();
  const points = Array.from({ length: count + 1 }, (_, i) => {
    const t = i / count, point = from.clone().lerp(to, t);
    point.y += Math.sin(t * Math.PI) * object.arch;
    return point;
  });
  const thickness = 0.16;
  for (let i = 0; i < count; i++) {
    const a = points[i], b = points[i + 1], tangent = b.clone().sub(a).normalize();
    const normal = new THREE.Vector3().crossVectors(tangent, across).normalize();
    const center = a.clone().add(b).multiplyScalar(0.5).addScaledVector(normal, -thickness / 2);
    const plank = box(parent, edited ? m.terracotta : m.woodLight, [object.width, thickness, a.distanceTo(b) + 0.025], center.toArray(), 'bridge-planks');
    plank.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(across, normal, tangent));
  }
  const railOffset = Math.max(0, object.width / 2 - Math.min(0.075, object.width * 0.1));
  for (const side of [-1, 1]) {
    const rail = points.map(point => point.clone().addScaledVector(across, side * railOffset).add(new THREE.Vector3(0, 1.15, 0)));
    // Linear spans share the deck's stations, keeping rails continuous even at steep endpoints.
    for (let i = 0; i < count; i++) beam(parent, m.wood, rail[i].toArray(), rail[i + 1].toArray(), 0.055, 'curved-handrail');
    for (let i = 0; i <= count; i++) {
      if (i % 4 !== 0 && i !== count) continue;
      const foot = points[i].clone().addScaledVector(across, side * railOffset);
      cylinder(parent, m.wood, 0.07, 0.09, 1.22, foot.clone().add(new THREE.Vector3(0, 0.575, 0)).toArray(), 8, 'bridge-post');
    }
  }
}

function buildTrees(parent, m, trees) {
  for (const tree of trees) {
    const local = objectFrame(parent, tree);
    local.scale.setScalar(tree.scale);
    cylinder(local, m.wood, 0.22, 0.38, 4.3, [0, 2.15, 0], 9, 'tree-trunk');
    const clusters = [[0, 5.75, 0, 2.2], [-1.5, 4.95, 0.4, 1.7], [1.4, 5.15, 0.6, 1.6], [-0.4, 4.85, -1.4, 1.65], [0.7, 6.25, -0.5, 1.45]];
    for (let i = 0; i < clusters.length; i++) {
      const [x, y, z, size] = clusters[i];
      const leaf = sphere(local, i % 3 ? m.leaf : m.leafLight, size, [x, y, z], [1, 0.82, 1], 1, 'foliage');
      leaf.rotation.y = i * 0.7;
      if (i > 0) beam(local, m.wood, [0, 2.95, 0], [x, y - 0.5, z], 0.07, 'branch');
    }
  }
}

function buildReeds(parent, m, island, water) {
  const random = rng(642), reeds = [], scale = island.radius / 11.5;
  const [x, z] = island.center, waterY = water?.elevation ?? island.elevation - 1.23;
  for (let i = 0; i < 150; i++) {
    const a = random() * Math.PI * 2, r = islandRadius(island, a) + (0.2 + random() * 2.5) * scale;
    reeds.push({ p: [x + Math.cos(a) * r, island.elevation - 0.75, z + Math.sin(a) * r], s: [0.045 * scale, 0.7 + random() * 0.9, 0.045 * scale], r: [random() * 0.15, 0, random() * 0.15] });
  }
  instances(parent, m.reed, reeds, 'reeds');
  for (let i = 0; i < 16; i++) {
    const a = random() * Math.PI * 2, r = islandRadius(island, a) + (0.5 + random() * 4) * scale;
    const ring = mesh(parent, new THREE.RingGeometry(0.5 * scale, 0.515 * scale, 32), m.waterLight, [x + Math.cos(a) * r, waterY + 0.025, z + Math.sin(a) * r], 'water-ripple');
    ring.rotation.x = -Math.PI / 2;
  }
}

function buildGarden(parent, m) {
  const shrubs = [];
  for (let i = 0; i < 20; i++) shrubs.push({ p: [-5.2 - (i % 4) * 0.38, 1, -2 + Math.floor(i / 4) * 0.7], s: [0.5, 0.45 + (i % 3) * 0.1, 0.5] });
  instances(parent, m.leafLight, shrubs, 'herb-garden');
  box(parent, m.woodLight, [2.5, 0.18, 0.55], [-5.5, 1.5, 2], 'garden-bench');
  for (const x of [-6.4, -4.6]) box(parent, m.wood, [0.16, 0.8, 0.45], [x, 1.1, 2]);
}
