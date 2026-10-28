import * as THREE from 'three';
import { sceneLayout, localToWorld, bridgePoint, diagnostic, islandContains } from './scene-validation.js';
import { CAMP_LOCATIONS } from './camp-document.js';

// Probe the actual compiled surfaces, not just the declared dimensions. No renderer/GPU is needed.
export function validateCompiledSpatial(document, parts) {
  const errors = [];
  if (document.profile === 'beast-camp') {
    for (const part of Object.values(parts)) {
      part.updateWorldMatrix(true, true);
      part.traverse(node => {
        if (node.isMesh && (!node.geometry.attributes.position || !node.geometry.attributes.position.array.every(Number.isFinite))) errors.push(diagnostic(part.name, 'probe-camp', 'camp.mesh', '营地几何含无效坐标'));
      });
    }
    // Partial updates only probe parts actually rebuilt; the station origins
    // cannot move, so unchanged deck support remains valid.
    const deck = parts['camp:deck'];
    if (deck) {
      const ray = new THREE.Raycaster();
      for (const [id, [x, y, z]] of Object.entries(CAMP_LOCATIONS)) {
        ray.set(new THREE.Vector3(x, y + 0.2, z), new THREE.Vector3(0, -1, 0)); ray.far = 0.5;
        if (!ray.intersectObject(deck, true).length) errors.push(diagnostic(id, 'probe-camp-support', 'camp.station.support', '固定站点下方缺少甲板支撑'));
      }
    }
    return errors;
  }
  const { library, bridge } = sceneLayout(document);
  const ray = new THREE.Raycaster();
  const fail = (node, operationId, requirementId, message) => errors.push(diagnostic(node.id, operationId, requirementId, message));
  for (const part of Object.values(parts)) part.updateWorldMatrix(true, true);
  if (document.profile === 'world') {
    for (const part of Object.values(parts)) part.traverse(node => {
      if (node.isMesh && (!node.geometry.attributes.position?.array.every(Number.isFinite) || !node.matrixWorld.elements.every(Number.isFinite) || (node.isInstancedMesh && !node.instanceMatrix.array.every(Number.isFinite)))) errors.push(diagnostic(part.name, 'probe-world', 'world.mesh', '世界几何含无效坐标'));
    });
    // A rebuilt terrain must still physically support every declared origin.
    // Raycasting the real mesh catches accidental backend translation or holes.
    if (parts.terrain) {
      const islands = document.regions.filter(r => r.kind === 'island');
      for (const node of document.objects) {
        const points = node.position ? [[node.position[0], node.position[2]]] : node.transform ? [localToWorld(node, 0, 0), ...rectPoints(node)] : node.kind === 'path' ? node.points : [];
        for (const [x, z] of points) {
          const host = islands.find(r => islandContains(r, x, z));
          if (!host) continue;
          ray.set(new THREE.Vector3(x, host.elevation + 0.2, z), new THREE.Vector3(0, -1, 0)); ray.far = 0.4;
          if (!ray.intersectObject(parts.terrain, true).length) { fail(node, 'probe-world-support', 'world.land.support', '已编译陆地缺少物件支撑'); break; }
        }
      }
    }
    for (const room of document.objects.filter(object => object.kind === 'room')) {
      const part = parts[`room:${room.id}`];
      if (!part) continue;
      const { width, depth, floor } = room.bounds;
      const inset = Math.min(Math.max(0.28, (part.userData.voxelUnit ?? 0) * 1.5), width / 4, depth / 4);
      const probes = [[0, 0], ...[-1, 1].flatMap(x => [-1, 1].map(z => [x * (width / 2 - inset), z * (depth / 2 - inset)]))];
      const floorY = room.transform.position[1] + floor;
      for (const [localX, localZ] of probes) {
        const [x, z] = localToWorld(room, localX, localZ);
        ray.set(new THREE.Vector3(x, floorY + 0.25, z), new THREE.Vector3(0, -1, 0)); ray.far = 0.6;
        if (!ray.intersectObject(part, true).length) {
          fail(room, 'probe-room-floor', 'room.floor.compiled', '已编译房间地板缺少支撑面');
          break;
        }
      }
    }
  }
  if (parts.library && library) {
    const angle = library.transform.rotation;
    const forward = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle));
    const floor = library.transform.position[1] + library.bounds.floor;
    let blocked = false;
    for (const x of [-0.35, 0, 0.35]) for (const height of [0.2, 0.9, 1.7]) {
      const [wx, wz] = localToWorld(library, x, library.bounds.depth / 2 + 0.5);
      ray.set(new THREE.Vector3(wx, floor + height, wz), forward.clone().negate());
      ray.far = 1;
      if (ray.intersectObject(parts.library, true).length) blocked = true;
    }
    if (blocked) fail(library, 'probe-entrance', 'entrance.clearance', '已编译入口被几何遮挡');
  }
  if (parts.bridge && bridge) {
    const count = Math.max(64, Math.ceil(new THREE.Vector3(...bridge.from.point).distanceTo(new THREE.Vector3(...bridge.to.point)) / 0.08));
    let missing = false;
    for (let i = 0; i <= count; i++) {
      const p = bridgePoint(bridge, (i + 0.001) / (count + 0.002));
      ray.set(new THREE.Vector3(p[0], p[1] + 0.65, p[2]), new THREE.Vector3(0, -1, 0));
      ray.far = 1.3;
      if (!ray.intersectObject(parts.bridge, true).length) { missing = true; break; }
    }
    if (missing) fail(bridge, 'probe-bridge-path', 'bridge.path', '已编译桥面路径存在空隙');
  }
  return errors;
}

function rectPoints(node) {
  return [-1, 1].flatMap(x => [-1, 1].map(z => localToWorld(node, x * node.bounds.width / 2, z * node.bounds.depth / 2)));
}
