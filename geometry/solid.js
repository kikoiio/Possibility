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
  const victorian = document.style?.palette === 'victorian-archive';
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
        } else if (region.kind === 'island') buildIsland(parent, materials, region, details, victorian);
      }
      if (victorian && details) buildVictorianDistrict(parent, materials, objects, regions);
      if (document.profile !== 'world' && details && primaryIsland) buildPath(islandFrame(parent, primaryIsland, 'island-path'), materials);
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
      if (document.profile !== 'world' && details && primaryIsland) {
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
    } else if (id.startsWith('room:')) {
      const object = objects.find(item => item?.id === id.slice(5) && item.kind === 'room');
      if (!object) continue;
      buildRoomSolid(parts[id] = group(world, id), materials, object, victorian);
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
  const figure = group(parent, 'character-figure');
  parent.userData.displayMarker = figure;
  const keepLocal = node => { node.userData.noBatch = true; return node; };
  keepLocal(cylinder(figure, m.wood, 0.08, 0.11, 0.55, [-0.11, 0.28, 0], 8, 'leg'));
  keepLocal(cylinder(figure, m.wood, 0.08, 0.11, 0.55, [0.11, 0.28, 0], 8, 'leg'));
  keepLocal(cylinder(figure, m.terracotta, 0.16, 0.21, 0.62, [0, 0.86, 0], 10, 'torso'));
  keepLocal(sphere(figure, m.cream, 0.16, [0, 1.34, 0], [1, 1.05, 1], 1, 'head'));
  keepLocal(cylinder(figure, m.roofLight, 0.03, 0.2, 0.15, [0, 1.52, 0], 10, 'hat-crown'));
  keepLocal(cylinder(figure, m.roof, 0.33, 0.36, 0.04, [0, 1.45, 0], 12, 'hat-brim'));
  parent.userData.route = Array.isArray(object.route) ? object.route : null;
  parent.userData.speed = object.speed ?? 1.2;
  parent.userData.home = [x, y, z];
}

function buildRoomSolid(parent, m, room, victorian = false) {
  const frame = objectFrame(parent, room), { width, depth, floor, wallHeight } = room.bounds;
  frame.userData.roomId = room.id;
  frame.userData.roomName = room.name;
  if (victorian) {
    buildVictorianRoom(frame, m, room);
    return;
  }
  const halfWidth = width / 2, halfDepth = depth / 2;
  texturedBox(frame, m.woodLight, [width, 0.14, depth], [0, floor - 0.07, 0], 'room-floor');
  // Keep the roof and the front/right walls open so residents remain visible.
  box(frame, m.plaster, [width, wallHeight, 0.18], [0, floor + wallHeight / 2, -halfDepth], 'room-back-wall');
  box(frame, m.plaster, [0.18, wallHeight, depth], [-halfWidth, floor + wallHeight / 2, 0], 'room-left-wall');
  box(frame, m.wood, [width, 0.12, 0.22], [0, floor + 0.06, -halfDepth], 'room-back-trim');
  box(frame, m.wood, [0.22, 0.12, depth], [-halfWidth, floor + 0.06, 0], 'room-left-trim');
  buildRoomFurnishing(frame, m, room, floor, halfWidth, halfDepth);
}

function buildVictorianDistrict(parent, m, objects, regions) {
  const rooms = objects.filter(object => object.kind === 'room');
  const island = regions.find(region => region.kind === 'island');
  if (!rooms.length || !island || !m.iron) return;
  const ground = island.elevation + 0.18;
  const worldPoint = room => [room.transform.position[0], ground, room.transform.position[2]];
  const frontPoint = room => [room.transform.position[0], ground, room.transform.position[2] + room.bounds.depth / 2 + 1.55];
  const connect = (a, b, width, material, name) => {
    const start = new THREE.Vector3(...worldPoint(a)), end = new THREE.Vector3(...worldPoint(b));
    const direction = end.clone().sub(start), length = Math.hypot(direction.x, direction.z);
    if (length < 0.01) return;
    const slab = box(parent, material, [width, 0.11, length], start.clone().add(end).multiplyScalar(0.5).toArray(), name);
    slab.rotation.y = Math.atan2(direction.x, direction.z);
  };
  const connectPoints = (a, b, width, material, name) => {
    const start = new THREE.Vector3(...a), end = new THREE.Vector3(...b);
    const direction = end.clone().sub(start), length = Math.hypot(direction.x, direction.z);
    if (length < 0.01) return;
    const slab = box(parent, material, [width, 0.11, length], start.clone().add(end).multiplyScalar(0.5).toArray(), name);
    slab.rotation.y = Math.atan2(direction.x, direction.z);
  };
  const by = key => rooms.find(room => `${room.id} ${room.name || ''}`.toLowerCase().includes(key));
  const pawnshop = by('pawnshop') || by('当铺');
  const basement = by('basement') || by('地下');
  const bank = by('bank') || by('银行');
  if (pawnshop && bank) {
    connect(pawnshop, bank, 1.55, m.paverLight, 'market-crossing');
    const a = frontPoint(pawnshop), b = frontPoint(bank);
    connectPoints(a, b, 2.35, m.paverLight, 'front-street');
  }
  if (pawnshop && basement) connect(pawnshop, basement, 1.2, m.paverLight, 'service-alley');
  const lampSpots = [];
  if (pawnshop && bank) {
    const a = frontPoint(pawnshop), b = frontPoint(bank);
    lampSpots.push([(a[0] + b[0]) / 2, (a[2] + b[2]) / 2]);
  }
  if (pawnshop && basement) {
    lampSpots.push([pawnshop.transform.position[0] - 3.1, pawnshop.transform.position[2] + pawnshop.bounds.depth / 2 + 2.1]);
  }
  lampSpots.forEach(([x, z], index) => buildStreetLamp(parent, m, x, ground, z, index));
  // A shallow gutter gives the plaza a street edge and keeps the three scenes
  // in one readable public space instead of floating as separate rooms.
  for (const room of rooms) {
    const { width, depth } = room.bounds;
    box(parent, m.iron, [width + 1.1, 0.06, 0.16], [room.transform.position[0], ground + 0.02, room.transform.position[2] + depth / 2 + 0.72], 'building-gutter');
  }
}

function buildStreetLamp(parent, m, x, ground, z, index) {
  const lamp = group(parent, `street-lamp-${index}`);
  cylinder(lamp, m.iron, 0.055, 0.08, 3.2, [x, ground + 1.6, z], 8, 'lamp-post');
  beam(lamp, m.iron, [x, ground + 2.72, z], [x + 0.38, ground + 2.72, z], 0.045, 'lamp-arm');
  box(lamp, m.windowGlow, [0.26, 0.34, 0.26], [x + 0.38, ground + 2.47, z], 'lamp-glow');
  box(lamp, m.copper, [0.36, 0.06, 0.34], [x + 0.38, ground + 2.68, z], 'lamp-cap');
  box(lamp, m.copper, [0.42, 0.06, 0.4], [x + 0.38, ground + 2.27, z], 'lamp-base');
  box(lamp, m.stoneDark, [0.42, 0.08, 0.42], [x, ground + 0.04, z], 'lamp-foot');
}

function buildVictorianRoom(frame, m, room) {
  const { width, depth, floor, wallHeight } = room.bounds;
  const halfWidth = width / 2, halfDepth = depth / 2, top = floor + wallHeight;
  const key = `${room.name || ''} ${room.role || ''} ${room.id || ''}`;
  const pawnshop = /当铺|pawnshop|shop/i.test(key);
  const basement = /地下室|basement|tunnel|挖掘/i.test(key);
  const bank = /银行|bank|vault/i.test(key);
  texturedBox(frame, basement ? m.stoneDark : m.paverLight, [width, 0.14, depth], [0, floor - 0.07, 0], 'district-floor');
  box(frame, m.brickDark, [width + 0.46, 0.34, depth + 0.46], [0, floor - 0.17, 0], 'district-foundation');
  const wallMaterial = bank ? m.marble : basement ? m.stoneDark : m.brick;
  box(frame, wallMaterial, [width, wallHeight, 0.25], [0, floor + wallHeight / 2, -halfDepth], 'district-back-wall');
  box(frame, wallMaterial, [0.25, wallHeight, depth], [-halfWidth, floor + wallHeight / 2, 0], 'district-side-wall');
  box(frame, m.brickDark, [width + 0.34, 0.28, 0.38], [0, top + 0.12, -halfDepth], 'district-cornice');
  box(frame, m.brickDark, [0.38, 0.28, depth + 0.22], [-halfWidth, top + 0.12, 0], 'district-side-cornice');
  if (basement) buildBasementFacade(frame, m, width, depth, floor, wallHeight);
  else if (bank) buildBankFacade(frame, m, width, depth, floor, wallHeight);
  else if (pawnshop) buildPawnshopFacade(frame, m, width, depth, floor, wallHeight);
  else buildPawnshopFacade(frame, m, width, depth, floor, wallHeight);
}

function windowBay(frame, m, x, floor, z, width, height, material = m.windowGlow) {
  box(frame, material, [width, height, 0.08], [x, floor + 1.35, z], 'window-glass');
  for (const side of [-1, 1]) box(frame, m.woodDark, [0.1, height + 0.16, 0.15], [x + side * (width / 2 + 0.05), floor + 1.35, z + 0.06], 'window-jamb');
  for (const y of [floor + 1.35 - height / 2 - 0.05, floor + 1.35 + height / 2 + 0.05]) box(frame, m.woodDark, [width + 0.2, 0.1, 0.15], [x, y, z + 0.06], 'window-sill');
  box(frame, m.woodDark, [0.06, height, 0.12], [x, floor + 1.35, z + 0.09], 'window-mullion');
  box(frame, m.woodDark, [width, 0.06, 0.12], [x, floor + 1.35, z + 0.09], 'window-mullion');
}

function doorBay(frame, m, x, floor, z, width = 1.35, height = 2.45) {
  box(frame, m.woodDark, [width, height, 0.12], [x, floor + height / 2, z], 'street-door');
  box(frame, m.copper, [0.06, 0.11, 0.05], [x + width * 0.28, floor + height * 0.5, z + 0.1], 'door-handle');
  for (const side of [-1, 1]) box(frame, m.copper, [0.08, height + 0.16, 0.16], [x + side * (width / 2 + 0.08), floor + height / 2, z + 0.06], 'door-frame');
}

function awning(frame, m, x, floor, z, width, material = m.redSign) {
  const canopy = box(frame, material, [width, 0.14, 0.72], [x, floor + 2.58, z + 0.28], 'shop-awning');
  canopy.rotation.x = -0.22;
  box(frame, m.copper, [width + 0.08, 0.06, 0.08], [x, floor + 2.39, z + 0.62], 'awning-edge');
}

function buildPawnshopFacade(frame, m, width, depth, floor, wallHeight) {
  const front = depth / 2 + 0.14;
  box(frame, m.woodDark, [width, 0.42, 0.22], [0, floor + 0.38, front], 'shop-baseboard');
  const bay = Math.min(2.2, width * 0.28);
  windowBay(frame, m, -width * 0.27, floor, front, bay, 1.65);
  windowBay(frame, m, width * 0.27, floor, front, bay, 1.65);
  doorBay(frame, m, 0, floor, front, 1.18, 2.35);
  awning(frame, m, -width * 0.27, floor, front, bay + 0.18);
  awning(frame, m, width * 0.27, floor, front, bay + 0.18);
  box(frame, m.redSign, [width * 0.8, 0.5, 0.18], [0, floor + wallHeight - 0.54, front + 0.08], 'pawnshop-sign');
  box(frame, m.copper, [width * 0.84, 0.08, 0.08], [0, floor + wallHeight - 0.84, front + 0.19], 'pawnshop-sign-trim');
  box(frame, m.wood, [2.8, 0.72, 0.62], [0, floor + 0.95, -depth / 2 + 0.95], 'pawnshop-counter');
  for (let i = 0; i < 5; i++) box(frame, [m.bookGold, m.bookBlue, m.terracotta][i % 3], [0.22, 0.24 + (i % 2) * 0.12, 0.22], [-1 + i * 0.5, floor + 1.42, -depth / 2 + 0.42], 'pawnshop-display');
  for (const x of [-width / 2 + 0.22, width / 2 - 0.22]) box(frame, m.copper, [0.1, wallHeight - 0.25, 0.12], [x, floor + wallHeight / 2, front + 0.05], 'shop-pilaster');
}

function buildBankFacade(frame, m, width, depth, floor, wallHeight) {
  const front = depth / 2 + 0.16;
  for (const x of [-width * 0.32, width * 0.32]) windowBay(frame, m, x, floor + 0.12, front, Math.min(1.7, width * 0.24), 2.1, m.windowGlow);
  doorBay(frame, m, 0, floor, front, 1.55, 2.6);
  for (const x of [-width / 2 + 0.55, width / 2 - 0.55]) {
    cylinder(frame, m.marble, 0.26, 0.32, wallHeight - 0.2, [x, floor + (wallHeight - 0.2) / 2, front + 0.12], 14, 'bank-column');
    cylinder(frame, m.copper, 0.32, 0.34, 0.12, [x, floor + wallHeight - 0.18, front + 0.12], 14, 'bank-capital');
  }
  box(frame, m.marble, [width + 0.48, 0.32, 0.55], [0, floor + wallHeight - 0.18, front], 'bank-entablature');
  box(frame, m.iron, [width * 0.68, 0.38, 0.16], [0, floor + wallHeight - 0.62, front + 0.08], 'bank-sign');
  for (let step = 0; step < 3; step++) box(frame, m.stone, [3.4 - step * 0.32, 0.16, 0.42], [0, floor - 0.02 - step * 0.16, front + 0.34 + step * 0.32], 'bank-step');
  box(frame, m.dark, [1.3, 0.76, 0.24], [0, floor + 0.58, -depth / 2 + 0.36], 'bank-vault');
}

function buildBasementFacade(frame, m, width, depth, floor, wallHeight) {
  const front = depth / 2 + 0.1, lowWall = Math.min(1.15, wallHeight * 0.52);
  box(frame, m.brickDark, [width, lowWall, 0.28], [0, floor + lowWall / 2, -depth / 2], 'basement-back-wall');
  box(frame, m.brickDark, [0.28, lowWall, depth], [-width / 2, floor + lowWall / 2, 0], 'basement-side-wall');
  const mouthWidth = Math.min(2.2, width * 0.4), mouthHeight = Math.min(1.55, wallHeight * 0.64);
  box(frame, m.dark, [mouthWidth, mouthHeight, 0.16], [0, floor + mouthHeight / 2, front - 0.06], 'tunnel-mouth');
  for (const x of [-mouthWidth / 2 - 0.18, mouthWidth / 2 + 0.18]) box(frame, m.brick, [0.36, mouthHeight + 0.2, 0.42], [x, floor + (mouthHeight + 0.2) / 2, front], 'tunnel-jamb');
  for (let i = 0; i < 5; i++) {
    const y = floor + mouthHeight + 0.08 + Math.abs(i - 2) * 0.12;
    box(frame, m.brick, [0.42, 0.32, 0.42], [-0.84 + i * 0.42, y, front], 'tunnel-arch');
  }
  for (let i = 0; i < 4; i++) box(frame, m.woodDark, [1.7, 0.2, 0.18], [0, floor + 0.55 + i * 0.34, -depth / 2 + 0.42], 'basement-beam');
  box(frame, m.wood, [2.8, 0.7, 0.58], [0, floor + 0.36, -depth / 2 + 1.0], 'basement-bench');
  for (let i = 0; i < 4; i++) box(frame, m.copper, [0.1, 0.52, 0.1], [-0.75 + i * 0.5, floor + 0.93, -depth / 2 + 0.7], 'basement-tool');
  for (let i = 0; i < 4; i++) box(frame, m.stoneDark, [1.1, 0.14, 0.38], [0, floor + 0.08 + i * 0.16, front + 0.32 + i * 0.3], 'basement-step');
  box(frame, m.redSign, [2.6, 0.34, 0.16], [0, floor + wallHeight - 0.38, front + 0.08], 'basement-sign');
}

function buildRoomFurnishing(frame, m, room, floor, halfWidth, halfDepth) {
  // The model chooses the room's meaning; the renderer supplies a restrained
  // visual vocabulary so a valid room never collapses into four empty
  // rectangles. The reading below is keyed to what the room is called, so a
  // study receives shelves and a parlour receives seats. An unnamed room falls
  // back to a deterministic pick from its id.
  const key = `${room.name || ''} ${room.role || ''} ${room.id || ''}`;
  const seed = /当铺|pawnshop|shop/i.test(key) ? 4
    : /地下室|basement|tunnel|挖掘/i.test(key) ? 5
    : /银行|bank|vault/i.test(key) ? 6
    : /书|档|卷|笔记|study|library|archive|office/i.test(key) ? 1
    : /餐|厨|宴|dining|kitchen|pantry/i.test(key) ? 2
    : /卧|寝|bedroom|sleep/i.test(key) ? 3
    : /厅|客|会客|堂|parlour|hall|lounge/i.test(key) ? 0
    : [...key].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4;
  const y = floor + 0.12;
  const table = (x, z, width, depth, height = 0.72) => {
    box(frame, m.wood, [width, 0.12, depth], [x, y + height, z], 'room-tabletop');
    for (const [lx, lz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) cylinder(frame, m.wood, 0.045, 0.06, height, [x + lx * (width / 2 - 0.12), y + height / 2, z + lz * (depth / 2 - 0.12)], 7, 'room-table-leg');
  };
  const rug = (color = m.terracotta) => texturedBox(frame, color, [Math.min(2.9, halfWidth * 1.15), 0.025, Math.min(2.1, halfDepth * 0.8)], [0, y + 0.015, 0], 'room-rug');
  if (seed === 0) {
    rug(m.bookBlue); table(0, 0, 1.85, 1.05);
    box(frame, m.bookGold, [0.8, 0.18, 0.45], [0, y + 0.87, 0], 'room-object');
  } else if (seed === 1) {
    rug(m.bookRed);
    box(frame, m.wood, [1.8, 1.15, 0.34], [0, y + 0.58, -halfDepth + 0.5], 'room-shelf');
    for (let index = 0; index < 5; index += 1) box(frame, index % 2 ? m.bookBlue : m.bookGold, [0.2, 0.5 + (index % 3) * 0.08, 0.07], [-0.68 + index * 0.34, y + 0.76, -halfDepth + 0.29], 'room-book');
  } else if (seed === 2) {
    rug(m.earth); table(0, 0, 2.15, 1.2, 0.66);
    for (const [x, z] of [[-1.2, -0.72], [1.2, -0.72], [-1.2, 0.72], [1.2, 0.72]]) cylinder(frame, m.terracotta, 0.16, 0.18, 0.34, [x, y + 0.17, z], 8, 'room-chair');
  } else if (seed === 4) {
    // Pawnshop: a broad counter and a wall of mismatched objects make this
    // room read as a shop before the labels are even visible.
    rug(m.bookRed);
    box(frame, m.wood, [Math.min(halfWidth * 1.5, 3.8), 0.82, 0.62], [0, y + 0.41, halfDepth - 1.08], 'pawnshop-counter');
    box(frame, m.woodLight, [Math.min(halfWidth * 1.25, 3.2), 1.45, 0.28], [0, y + 0.78, -halfDepth + 0.34], 'pawnshop-shelf');
    for (let index = 0; index < 6; index += 1) {
      const material = [m.bookGold, m.bookBlue, m.terracotta][index % 3];
      box(frame, material, [0.28, 0.22 + (index % 2) * 0.16, 0.24], [-1.35 + index * 0.54, y + 1.12, -halfDepth + 0.16], 'pawnshop-object');
    }
    cylinder(frame, m.bookGold, 0.18, 0.22, 0.05, [0, y + 1.7, -halfDepth + 0.18], 12, 'pawnshop-sign');
  } else if (seed === 5) {
    // Basement: a dark workbench and a visible tunnel mouth point toward the
    // hidden action without embedding a scripted outcome in the scene.
    rug(m.earth);
    box(frame, m.wood, [2.8, 0.75, 0.62], [0, y + 0.38, -halfDepth + 0.85], 'basement-bench');
    for (let index = 0; index < 4; index += 1) box(frame, m.bookGold, [0.12, 0.55, 0.12], [-0.8 + index * 0.52, y + 0.86, -halfDepth + 0.58], 'basement-tool');
    const arch = group(frame, 'basement-arch');
    for (let index = 0; index < 5; index += 1) box(arch, m.stoneDark, [0.36, 0.35, 0.45], [-0.72 + index * 0.36, y + 1.02 + Math.abs(index - 2) * 0.14, halfDepth - 0.32], 'tunnel-stone');
    box(frame, m.dark, [1.55, 1.35, 0.18], [0, y + 0.72, halfDepth - 0.22], 'tunnel-mouth');
  } else if (seed === 6) {
    // Bank: a cool, formal counter and paired columns separate it from the
    // warmer, improvised pawnshop across the passage.
    rug(m.bookBlue);
    box(frame, m.woodLight, [3.2, 0.72, 0.58], [0, y + 0.36, halfDepth - 1.06], 'bank-counter');
    for (const x of [-halfWidth + 0.55, halfWidth - 0.55]) {
      cylinder(frame, m.stone, 0.24, 0.32, 1.8, [x, y + 0.9, -halfDepth + 0.48], 12, 'bank-column');
    }
    box(frame, m.dark, [1.05, 0.8, 0.22], [0, y + 0.4, -halfDepth + 0.36], 'bank-vault');
  } else {
    // A bedroom: a raised bed with a pillow and a low side table, rather than
    // another bench that reads identically to the parlour from every angle.
    rug(m.bookGold);
    box(frame, m.wood, [1.35, 0.34, 1.05], [0, y + 0.17, -halfDepth + 0.95], 'room-bed-frame');
    box(frame, m.cream, [1.24, 0.2, 0.86], [0, y + 0.42, -halfDepth + 0.95], 'room-bed');
    box(frame, m.plaster, [0.7, 0.14, 0.3], [0, y + 0.58, -halfDepth + 0.52], 'room-pillow');
    box(frame, m.wood, [0.5, 0.5, 0.5], [Math.min(halfWidth - 0.5, 1.05), y + 0.25, -halfDepth + 0.55], 'room-stand');
  }
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

function buildIsland(parent, m, region, details, victorian = false) {
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
  mesh(local, geometry, victorian && m.street ? m.street : m.grass, [0, 0, 0], victorian ? 'paved-district' : 'organic-island');
  // A grass plain with a single flat colour reads as a painted disc. Scatter
  // low foliage clumps over the interior so the ground has texture and scale;
  // they are decoration on the landform, not world facts.
  if (victorian && details && m.paver) {
    const pavers = [], random = rng((region.id || 'street').split('').reduce((seed, ch) => seed * 31 + ch.charCodeAt(0), 97));
    const span = region.radius * 1.72;
    for (let x = -span; x <= span; x += 0.92) for (let z = -span; z <= span; z += 0.58) {
      const edge = Math.hypot(x, z);
      if (edge > region.radius * (0.88 + random() * 0.08)) continue;
      pavers.push({ p: [x, 0.065 + random() * 0.012, z], s: [0.74, 0.035, 0.42], r: [0, (random() - 0.5) * 0.08, 0] });
    }
    instances(local, m.paver, pavers, 'cobblestone-rhythm');
    const curb = [];
    for (let i = 0; i < 48; i++) {
      const a = i / 48 * Math.PI * 2, r = region.radius * 0.92;
      curb.push({ p: [Math.cos(a) * r, 0.15, Math.sin(a) * r], s: [0.38, 0.12, 0.72], r: [0, -a, 0] });
    }
    instances(local, m.paverLight, curb, 'plaza-curb');
  } else if (details && region.radius > 2) {
    const random = rng((region.id || 'island').split('').reduce((seed, ch) => seed * 31 + ch.charCodeAt(0), 11));
    const tufts = [], clumps = [];
    const span = region.radius * 0.92;
    for (let i = 0; i < Math.round(region.radius * 9); i++) {
      const a = random() * Math.PI * 2, r = Math.sqrt(random()) * span;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      if (i % 4 === 0) clumps.push({ p: [x, 0.06, z], s: [0.55 + random() * 0.5, 0.34 + random() * 0.3, 0.55 + random() * 0.5], r: [0, random() * Math.PI, 0] });
      else tufts.push({ p: [x, 0.04, z], s: [0.1 + random() * 0.12, 0.16 + random() * 0.26, 0.1 + random() * 0.12], r: [0, random() * Math.PI, (random() - 0.5) * 0.35] });
    }
    instances(local, m.leafLight, tufts, 'grass-tufts');
    instances(local, m.leaf, clumps, 'ground-clumps');
  }
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
