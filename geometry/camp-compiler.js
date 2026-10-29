import * as THREE from 'three';
import { CAMP_COLORS, CAMP_LOCATIONS } from './camp-document.js';

// The camp solid profile retains independently movable meshes. Static batching would
// erase the binding references (water gauge, canopy, deck wear, residents).
function buildCampPart(node) {
  const part = new THREE.Group();
  part.name = `camp:${node.id}`;
  part.userData.bindings = {};
  const camp = part;
  const geoCache = {}, matCache = {};
  const geo = new Proxy(geoCache, { get(cache, key) {
    if (cache[key]) return cache[key];
    const factories = {
      box: () => new THREE.BoxGeometry(1, 1, 1), round: () => new THREE.IcosahedronGeometry(1, 1),
      cylinder: () => new THREE.CylinderGeometry(1, 1, 1, 8), cone: () => new THREE.ConeGeometry(1, 1, 7),
      leaf: () => new THREE.OctahedronGeometry(1),
      gable: () => {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 1, 0, 0, 0, 1, 0], 3));
        g.computeVertexNormals(); return g;
      },
    };
    return cache[key] = factories[key]();
  } });
  const mat = new Proxy(matCache, { get(cache, key) {
    if (cache[key]) return cache[key];
    const color = node.colors[key] || CAMP_COLORS[key];
    const options = key === 'glint' ? { emissive: color, emissiveIntensity: 0.3 }
      : key === 'tankGlass' ? { transparent: true, opacity: 0.18, depthWrite: false }
      : key === 'lamp' ? { emissive: '#ffbd65', emissiveIntensity: 0.8 }
      : key === 'canopy' ? { side: THREE.DoubleSide } : {};
    const m = new THREE.MeshLambertMaterial({ color, flatShading: true, ...options });
    m.userData.ownedByPart = true; m.userData.campColor = color;
    return cache[key] = m;
  } });
  const group = (parent, position = [0, 0, 0]) => {
    const g = new THREE.Group(); g.position.set(...position); parent.add(g); return g;
  };
  const mesh = (parent, g, m, pos, scale, rot) => {
    const o = new THREE.Mesh(g, m); o.position.set(...pos); o.scale.set(...scale);
    if (rot) o.rotation.set(...rot); parent.add(o); return o;
  };
  const box = (p, pos, size, m, rot) => mesh(p, geo.box, m, pos, size, rot);
  const round = (p, pos, size, m = mat.moss) => mesh(p, geo.round, m, pos, size);
  const pole = (p, from, to, radius, m) => {
    const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
    const o = mesh(p, geo.cylinder, m, a.clone().add(b).multiplyScalar(0.5).toArray(), [radius, a.distanceTo(b), radius]);
    o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize()); return o;
  };
  const bindings = part.userData.bindings;
  switch (node.kind) {
  case 'beast': {
    const beast = camp, body = camp;
    const torso = round(body, [0, 2.98, 0], [3.38, 1.54, 1.65]);
    round(body, [0.6, 2.57, 0], [2.8, 1.2, 1.48], mat.belly);
    round(body, [-2.6, 3.05, 0], [1.25, 1.3, 1.38]);
    const neck = group(body, [-3.05, 2.95, 0]);
    round(neck, [-0.25, 0.45, 0], [0.84, 1.1, 1.0]);
    const head = group(neck, [-1.1, 0.58, 0]);
    round(head, [0, 0, 0], [1.05, 0.9, 0.94], mat.face);
    round(head, [-0.65, -0.31, 0.05], [0.8, 0.53, 0.79], mat.face);
    // Eyes and lifted eyebrows on both sides; the camera sees the near-side smile.
    for (const side of [-1, 1]) {
      round(head, [-0.26, 0.16, side * 0.85], [0.19, 0.23, 0.075], mat.eye);
      round(head, [-0.31, 0.23, side * 0.908], [0.047, 0.061, 0.027], mat.glint);
      pole(head, [-0.48, 0.47, side * 0.81], [-0.05, 0.46, side * 0.88], 0.055, mat.mossDark);
      round(head, [-0.01, -0.22, side * 0.884], [0.26, 0.14, 0.027], mat.blush);
      const ear = round(head, [0.62, 0.38, side * 0.96], [0.31, 0.18, 0.61], mat.belly);
      ear.rotation.x = side * 0.3; ear.rotation.z = 0.25;
      round(head, [0.59, 0.46, side * 1.03], [0.2, 0.07, 0.36], mat.mossLight);
      const horn = mesh(head, geo.cone, mat.horn, [0.3, 1.02, side * 0.56], [0.17, 0.81, 0.17], [0, 0, -0.34]);
      horn.rotation.x = side * 0.25;
      round(head, [-1.27, -0.22, side * 0.33], [0.05, 0.07, 0.08], mat.mossDark);
      const smile = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-1.18, -0.47, side * 0.46), new THREE.Vector3(-0.93, -0.57, side * 0.64), new THREE.Vector3(-0.65, -0.55, side * 0.74), new THREE.Vector3(-0.48, -0.45, side * 0.78),
      ]);

      const smileMat = new THREE.LineBasicMaterial({ color: node.colors.mossDark }); smileMat.userData.ownedByPart = true;
      head.add(new THREE.Line(smile, smileMat));
    }
    const legs = [];
    for (const [x, z, offset] of [[-2.03, -1.06, Math.PI], [2.05, -1.02, 0], [-2.15, 1.08, 0], [1.94, 1.08, Math.PI]]) {
      const limb = group(beast, [x, 2.4, z]);
      round(limb, [0, -0.7, 0], [0.57, 1.08, 0.56], mat.belly);
      round(limb, [0.08, -1.67, 0.02], [0.46, 0.65, 0.48], mat.moss);
      round(limb, [-0.14, -2.07, 0.06], [0.65, 0.28, 0.6], mat.foot);
      for (let toe = 0; toe < 3; toe++) round(limb, [-0.6, -2.1, -0.29 + toe * 0.3], [0.15, 0.14, 0.13], mat.horn);
      legs.push({ limb, offset });
    }
    const tail = group(body, [2.93, 2.9, 0]);
    pole(tail, [0, 0, 0], [1.37, -0.5, 0], 0.21, mat.belly);
    round(tail, [1.41, -0.52, 0], [0.38, 0.3, 0.34], mat.mossDark);
    // Moss hummocks follow the anatomy rather than floating above the deck.
    for (let i = 0; i < 15; i++) {
      const x = -2.7 + (i % 7) * 0.83, z = i % 2 ? -1.44 : 1.48;
      round(body, [x, 3.69 + (i % 3) * 0.12, z], [0.34, 0.22, 0.3], i % 3 ? mat.mossDark : mat.mossLight);
    }
    // Broad leather saddle and supporting beams keep the camp visibly on its back.
    for (const x of [-1.8, 1.8]) {
      const strap = mesh(body, geo.cylinder, mat.darkWood, [x, 3.05, 0], [1.55, 0.14, 1.55], [0, 0, Math.PI / 2]);
      strap.scale.y = 0.16;
      box(body, [x, 4.32, 0], [0.23, 0.25, 3.5], mat.darkWood);
    }
    Object.assign(bindings, { torso, legs, tail });
    break;
  }

  case 'deck': {
    box(camp, [0, 4.49, 0], [6.35, 0.22, 3.64], mat.wood);
    const deckPlanks = [];
    for (let i = 0; i < 12; i++) {
      deckPlanks.push(box(camp, [-2.9 + i * 0.53, 4.63, 0], [0.506, 0.1, 3.58], i % 2 ? mat.plank : mat.plankAlt));
    }
    const damage = group(camp);
    for (let i = 0; i < 3; i++) box(damage, [-0.7 + i * 0.39, 4.69, 0.98], [0.025, 0.012, 0.46], mat.darkWood, [0, 0.4 - i * 0.35, 0]);
    // Rails frame the silhouette; the front has openings around both residents.
    for (const z of [-1.73, 1.73]) {
      for (const x of [-3.05, -1.8, 0, 1.8, 3.05]) box(camp, [x, 4.99, z], [0.075, 0.67, 0.075], mat.rail);
      box(camp, [0, 5.28, z], [6.2, 0.075, 0.075], mat.rail);
    }
    for (const x of [-3.05, 3.05]) box(camp, [x, 5.28, 0], [0.075, 0.075, 3.5], mat.rail);
    Object.assign(bindings, { deckPlanks, damage });
    break;
  }
  case 'cabin': {
    // A little warm timber house, with a porch instead of the old room cutaway.
    box(camp, [0.55, 5.33, -0.45], [2.1, 1.3, 1.64], mat.wall);
    for (let i = 0; i < 6; i++) box(camp, [0.55, 4.78 + i * 0.21, 0.389], [2.1, 0.027, 0.028], mat.wood);
    box(camp, [0.65, 5.2, 0.397], [0.54, 1.05, 0.035], mat.iron);
    box(camp, [0.65, 5.75, 0.435], [0.67, 0.065, 0.09], mat.darkWood);
    round(camp, [0.84, 5.22, 0.445], [0.04, 0.04, 0.02], mat.lamp);
    for (const x of [-0.18, 1.3]) {
      box(camp, [x, 5.45, 0.412], [0.48, 0.54, 0.06], mat.darkWood);
      box(camp, [x, 5.45, 0.45], [0.37, 0.42, 0.025], mat.lamp);
      box(camp, [x, 5.45, 0.48], [0.028, 0.43, 0.02], mat.wood);
      box(camp, [x, 5.45, 0.48], [0.38, 0.028, 0.02], mat.wood);
    }
    box(camp, [-0.515, 5.44, -0.45], [0.025, 0.5, 0.57], mat.darkWood);
    box(camp, [-0.54, 5.44, -0.45], [0.025, 0.38, 0.45], mat.lamp);
    for (const x of [-0.56, 1.66]) for (const z of [-1.3, 0.4]) box(camp, [x, 5.32, z], [0.09, 1.4, 0.09], mat.darkWood);
    const { kind, rise, overhang } = node.roof;
    const halfDepth = 0.82 + overhang, halfWidth = 1.05 + overhang;
    if (kind === 'flat') {
      box(camp, [0.55, 6.02, -0.45], [halfWidth * 2, 0.12, halfDepth * 2], mat.roof);
    } else {
      const slope = Math.atan2(rise, halfDepth);
      for (const side of [-1, 1]) box(camp, [0.55, 5.96 + rise / 2, -0.45 + side * halfDepth / 2], [halfWidth * 2, 0.12, Math.hypot(halfDepth, rise)], mat.roof, [side * slope, 0, 0]);
      pole(camp, [0.55 - halfWidth, 5.96 + rise, -0.45], [0.55 + halfWidth, 5.96 + rise, -0.45], 0.08, mat.roofEdge);
      for (const x of [0.55 - halfWidth, 0.55 + halfWidth]) {
        pole(camp, [x, 5.96, -0.45 - halfDepth], [x, 5.96 + rise, -0.45], 0.065, mat.roofEdge);
        pole(camp, [x, 5.96 + rise, -0.45], [x, 5.96, -0.45 + halfDepth], 0.065, mat.roofEdge);
      }
      for (const side of [-1, 1]) mesh(camp, geo.gable, mat.wall, [0.55 + side * 1.05, 5.96, -0.45], [0.82, rise, 1], [0, side * Math.PI / 2, 0]);
    }
    box(camp, [1.25, 6.46, -0.92], [0.23, 0.91, 0.25], mat.iron);
    box(camp, [1.25, 6.93, -0.92], [0.37, 0.09, 0.37], mat.darkWood);
    
    break;
  }
  case 'lookout': {
    // Small balcony at the head end, with a map table.
    box(camp, [-2.44, 5.04, -0.54], [0.64, 0.08, 0.48], mat.darkWood);
    box(camp, [-2.44, 5.09, -0.54], [0.54, 0.02, 0.38], mat.canopy);
    box(camp, [-2.44, 4.87, -0.54], [0.09, 0.4, 0.09], mat.darkWood);
    
    break;
  }
  case 'canopy': {
    // Canvas opens from a rolled bundle. Closed state has no extended membrane.
    for (const x of [-2.67, 2.67]) box(camp, [x, 5.38, 1.6], [0.055, 1.45, 0.055], mat.rail);
    const canopy = group(camp, [0, 6.04, 1.03]);
    const openCanopy = group(canopy);
    box(openCanopy, [0, 0, 0], [5.65, 0.045, 1.3], mat.canopy, [-0.12, 0, 0]);
    for (let i = 0; i < 6; i++) box(openCanopy, [-2.65 + i * 1.06, -0.03, 0], [0.03, 0.06, 1.3], mat.rail, [-0.12, 0, 0]);
    const rolledCanopy = mesh(canopy, geo.cylinder, mat.canopy, [0, 0.08, -0.62], [0.1, 5.65, 0.1], [0, 0, Math.PI / 2]);
    Object.assign(bindings, { openCanopy, rolledCanopy });
    break;
  }
  case 'tank': {
    // Tank: an open inspection face and transparent shell make even zero water legible.
    const tank = group(camp, node.position);
    mesh(tank, geo.cylinder, mat.tank, [0, 0.08, 0], [0.51, 0.14, 0.51]);
    mesh(tank, geo.cylinder, mat.tankGlass, [0, 0.65, 0], [0.48, 1.1, 0.48]);
    const tankWater = mesh(tank, geo.cylinder, mat.water, [0, 0.14, 0], [0.43, 0.01, 0.43]);
    for (const y of [0.14, 1.22]) mesh(tank, geo.cylinder, mat.iron, [0, y, 0], [0.52, 0.07, 0.52]);
    for (const x of [-0.46, 0.46]) box(tank, [x, 0.65, 0], [0.045, 1.1, 0.045], mat.iron);
    // A visible gauge outside the glass, capped by five quiet graduation marks.
    box(tank, [0, 0.67, 0.51], [0.17, 1.03, 0.06], mat.darkWood);
    const gauge = box(tank, [0, 0.17, 0.55], [0.09, 0.01, 0.02], mat.water);
    for (let i = 0; i < 5; i++) box(tank, [0.14, 0.22 + i * 0.22, 0.54], [0.08, 0.025, 0.02], mat.strap);
    pole(tank, [-0.35, 0.2, 0.3], [-0.62, 0.2, 0.55], 0.055, mat.iron);
    const collector = group(tank, [0, 1.37, 0]);
    mesh(collector, geo.cone, mat.canopy, [0, 0.1, 0], [0.84, 0.38, 0.84], [Math.PI, 0, 0]);
    pole(tank, [0, 1.3, 0], [0, 1.58, 0], 0.07, mat.iron);
    const foldedCollector = mesh(tank, geo.cone, mat.canopy, [0, 1.5, 0], [0.14, 0.55, 0.14]);
    Object.assign(bindings, { tankWater, gauge, collector, foldedCollector });
    break;
  }
  case 'garden': {
    // A contained vegetable bed and six individually readable leaves.
    const garden = group(camp, node.position);
    box(garden, [0, 0.12, 0], [1.28, 0.24, 0.8], mat.wood);
    box(garden, [0, 0.25, 0], [1.13, 0.035, 0.65], mat.soil);
    const plants = [];
    for (let i = 0; i < 6; i++) {
      const plant = group(garden, [-0.4 + (i % 3) * 0.39, 0.27, -0.17 + Math.floor(i / 3) * 0.34]);
      pole(plant, [0, 0, 0], [0, 0.43, 0], 0.02, mat.leaves);
      for (const side of [-1, 1]) mesh(plant, geo.leaf, mat.leaves, [side * 0.12, 0.22 + (side + 1) * 0.065, 0], [0.18, 0.075, 0.09], [0, 0, side * 0.5]);
      plants.push(plant);
    }
    Object.assign(bindings, { plants });
    break;
  }
  case 'cargo': {
    const cargo = group(camp, node.position);
    box(cargo, [0, 0.26, 0], [0.7, 0.52, 0.6], mat.wood);
    for (const x of [-0.3, 0.3]) box(cargo, [x, 0.26, 0.32], [0.06, 0.5, 0.035], mat.darkWood);
    const straps = group(cargo);
    box(straps, [0, 0.53, 0], [0.07, 0.035, 0.65], mat.strap);
    for (const z of [-0.32, 0.32]) box(straps, [0, 0.27, z], [0.07, 0.53, 0.03], mat.strap);
    box(straps, [0, 0.27, 0], [0.73, 0.07, 0.64], mat.strap);
    const looseStrap = pole(cargo, [-0.29, 0.04, 0.44], [0.35, 0.035, 0.58], 0.025, mat.strap);
    Object.assign(bindings, { straps, looseStrap });
    break;
  }
  case 'timber': {
    const timber = [];
    for (let i = 0; i < 8; i++) timber.push(mesh(camp, geo.cylinder, i % 2 ? mat.wood : mat.plank, [1.2 + (i % 3) * 0.22, 4.81 + Math.floor(i / 3) * 0.19, -1.42], [0.09, 0.74, 0.09], [0, 0, Math.PI / 2]));
    Object.assign(bindings, { timber });
    break;
  }
  case 'lamps': {
    // Warm porthole lamps are emissive, avoiding multiple costly dynamic lights.
    for (const [x, z] of [[-2.95, 1.68], [-0.1, 1.68], [2.95, 1.68], [-2.95, -1.65]]) {
      pole(camp, [x, 5.28, z], [x, 5.55, z], 0.027, mat.iron);
      mesh(camp, geo.cylinder, mat.lamp, [x, 5.15, z], [0.085, 0.18, 0.085]);
      mesh(camp, geo.cone, mat.iron, [x, 5.29, z], [0.13, 0.11, 0.13]);
    }
    
    break;
  }
  case 'resident': {
    const residents = [node.id.slice('resident-'.length)].map(id => {
      const i = id === 'loran' ? 1 : 0;
      const person = group(camp);
      for (const x of [-0.07, 0.07]) box(person, [x, 0.14, 0], [0.09, 0.28, 0.13], mat.boots);
      const upper = group(person, [0, 0.24, 0]);
      mesh(upper, geo.cone, i ? mat.loran : mat.ihe, [0, 0.18, 0], [0.19, 0.39, 0.15]);
      for (const side of [-1, 1]) pole(upper, [side * 0.12, 0.29, 0], [side * 0.22, 0.03, 0.05], 0.044, i ? mat.loran : mat.ihe);
      round(upper, [0, 0.54, 0], [0.13, 0.15, 0.13], mat.skin);
      round(upper, [0, 0.64, -0.025], [0.14, 0.07, 0.14], i ? mat.hair : mat.strap);
      if (!i) mesh(upper, geo.cylinder, mat.strap, [0, 0.63, 0], [0.2, 0.025, 0.17]);
      const start = CAMP_LOCATIONS.terrace;
      person.position.set(start[0] + i * 0.27, start[1], start[2]);
      return { id, person, upper, location: null, from: person.position.clone(), target: person.position.clone(), movedAt: 0, moving: false };
    });
    Object.assign(bindings, { residents });
    break;
  }
  }
  bindings.materials = matCache;
  return part;
}
export function buildCamp(document, requestedParts) {
  const world = new THREE.Group();
  world.userData.parts = {};
  world.position.y = 3;
  for (const node of document.objects) {
    const id = `camp:${node.id}`;
    if (!requestedParts.includes(id)) continue;
    const part = buildCampPart(node);
    part.position.y = -3;
    world.add(part); world.userData.parts[id] = part;
  }
  return world;
}
export function campBindings(world) {
  const result = { residents: [], materials: {} };
  for (const part of Object.values(world.userData.parts)) {
    const { materials, residents, ...bindings } = part.userData.bindings;
    Object.assign(result, bindings);
    if (residents) result.residents.push(...residents);
    result.materials[part.userData.partId] = materials;
  }
  return result;
}
const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
// Authoritative world facts are applied after every compile/update. No resource
// quantity, actor position or simulation toggle is read from the scene document.
export function projectCampState(world, state = {}) {
  const w = state.world || state, c = w.camp || {};
  const bindings = campBindings(world);
  const water = clamp(Math.max(0, finite(c.waterL)) / Math.max(1, finite(c.waterCapacityL, 40)));
  bindings.openCanopy.visible = Boolean(c.canopyOpen); bindings.rolledCanopy.visible = !c.canopyOpen;
  bindings.collector.visible = Boolean(c.collectorOpen); bindings.foldedCollector.visible = !c.collectorOpen;
  bindings.straps.visible = Boolean(c.cargoSecured); bindings.looseStrap.visible = !c.cargoSecured;
  bindings.tankWater.visible = water > 0; bindings.tankWater.scale.y = Math.max(0.001, water * 1.04); bindings.tankWater.position.y = 0.16 + water * 0.52;
  bindings.gauge.visible = water > 0; bindings.gauge.scale.y = Math.max(0.001, water * 0.95); bindings.gauge.position.y = 0.19 + water * 0.475;
  const health = clamp(finite(c.plantHealth, 100) / 100), soil = clamp(finite(c.soilMoisture, 50) / 100);
  const wet = clamp(finite(c.deckWetness) / 100), integrity = clamp(finite(c.deckIntegrity, 100) / 100);
  const mats = bindings.materials;
  mats['camp:garden'].leaves.color.set('#a68b51').lerp(new THREE.Color(mats['camp:garden'].leaves.userData.campColor), health);
  mats['camp:garden'].soil.color.set('#998263').lerp(new THREE.Color(mats['camp:garden'].soil.userData.campColor), soil);
  for (const [key, shade] of [['plank', '#77694e'], ['plankAlt', '#71634b']]) {
    const m = mats['camp:deck'][key]; m.color.set(m.userData.campColor).lerp(new THREE.Color(shade), wet * 0.8);
  }
  bindings.plants.forEach((plant, i) => { plant.scale.y = 0.3 + health * 0.7; plant.rotation.z = (1 - health) * (i % 2 ? 0.5 : -0.5); });
  bindings.damage.visible = integrity < 0.65;
  bindings.deckPlanks.forEach((plank, i) => { plank.rotation.z = integrity < 0.35 && i % 4 === 1 ? (0.35 - integrity) * 0.13 : 0; });
  bindings.timber.forEach((log, i) => { log.visible = i < Math.min(8, Math.ceil(Math.max(0, finite(c.timber)))); });
  const actors = Array.isArray(w.actors) ? w.actors : [];
  bindings.residents.forEach((r, i) => {
    const actor = actors.find(a => a?.id === r.id);
    r.person.visible = Boolean(actor);
    if (!actor) return;
    r.upper.rotation.z = clamp(finite(actor.fatigue) / 100) * 0.13;
    const location = Object.hasOwn(CAMP_LOCATIONS, actor.location) ? actor.location : 'terrace';
    const p = CAMP_LOCATIONS[location];
    r.target.set(p[0] + (r.id === 'loran' ? 0.16 : -0.16), p[1], p[2]);
    r.person.position.copy(r.target); r.location = location;
  });
  return bindings;
}
