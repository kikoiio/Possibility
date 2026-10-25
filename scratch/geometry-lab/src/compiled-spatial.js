import * as THREE from 'three';
import { sceneLayout, localToWorld, bridgePoint, diagnostic } from './scene-validation.js';

// Probe the actual compiled surfaces, not just the declared dimensions. No renderer/GPU is needed.
export function validateCompiledSpatial(document, parts) {
  const errors = [];
  const { library, bridge } = sceneLayout(document);
  const ray = new THREE.Raycaster();
  const fail = (node, operationId, requirementId, message) => errors.push(diagnostic(node.id, operationId, requirementId, message));
  for (const part of Object.values(parts)) part.updateWorldMatrix(true, true);
  if (parts.library) {
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
  if (parts.bridge) {
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
