import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export function group(parent, name) {
  const node = new THREE.Group();
  node.name = name;
  parent.add(node);
  return node;
}

export function mesh(parent, geometry, material, position = [0, 0, 0], name = '') {
  const node = new THREE.Mesh(geometry, material);
  node.position.set(...position);
  node.name = name;
  node.castShadow = !material.transparent;
  node.receiveShadow = true;
  parent.add(node);
  return node;
}

export function box(parent, material, size, position, name = '') {
  return mesh(parent, new THREE.BoxGeometry(...size), material, position, name);
}

export function texturedBox(parent, material, size, position, name = '', density = 0.65) {
  const geometry = new THREE.BoxGeometry(...size);
  const uv = geometry.attributes.uv;
  for (let face = 0; face < 6; face++) {
    const axis = Math.floor(face / 2);
    const uSize = axis === 0 ? size[2] : size[0];
    const vSize = axis === 1 ? size[2] : size[1];
    for (let vertex = 0; vertex < 4; vertex++) {
      const i = face * 4 + vertex;
      uv.setXY(i, uv.getX(i) * uSize * density, uv.getY(i) * vSize * density);
    }
  }
  return mesh(parent, geometry, material, position, name);
}

export function cylinder(parent, material, top, bottom, height, position, segments = 12, name = '') {
  return mesh(parent, new THREE.CylinderGeometry(top, bottom, height, segments), material, position, name);
}

export function sphere(parent, material, radius, position, scale = [1, 1, 1], detail = 1, name = '') {
  const node = mesh(parent, new THREE.IcosahedronGeometry(radius, detail), material, position, name);
  node.scale.set(...scale);
  return node;
}

export function beam(parent, material, start, end, width = 0.12, name = '') {
  const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end);
  const node = cylinder(parent, material, width, width, a.distanceTo(b), a.clone().add(b).multiplyScalar(0.5).toArray(), 8, name);
  node.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
  return node;
}

export function instances(parent, material, transforms, name) {
  const node = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, transforms.length);
  const dummy = new THREE.Object3D();
  transforms.forEach((item, i) => {
    dummy.position.set(...item.p);
    dummy.scale.set(...item.s);
    dummy.rotation.set(...(item.r || [0, 0, 0]));
    dummy.updateMatrix();
    node.setMatrixAt(i, dummy.matrix);
  });
  node.name = name;
  node.castShadow = true;
  node.receiveShadow = true;
  parent.add(node);
  return node;
}

export function exposedVoxelMesh(parent, materials, cells, unit, name) {
  const occupied = new Map(cells.map(cell => [`${cell.x},${cell.y},${cell.z}`, cell]));
  const batches = new Map();
  const colorOf = (cell, shade) => new THREE.Color(materials[cell.material].userData.baseColor || materials[cell.material].color).multiplyScalar(shade);
  const batchOf = cell => {
    if (!batches.has(cell.material)) batches.set(cell.material, { positions: [], normals: [], colors: [], indices: [] });
    return batches.get(cell.material);
  };
  // Push an arbitrary convex quad (two triangles) with an outward normal.
  const quad = (cell, shade, corners, normal) => {
    const batch = batchOf(cell), offset = batch.positions.length / 3;
    const color = colorOf(cell, shade);
    for (const corner of corners) {
      batch.positions.push(corner[0] * unit, corner[1] * unit, corner[2] * unit);
      batch.normals.push(...normal);
      batch.colors.push(color.r, color.g, color.b);
    }
    batch.indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
  };
  const faces = [
    { n: [1, 0, 0], c: [[1,0,0],[1,1,0],[1,1,1],[1,0,1]], shade: 0.83 },
    { n: [-1, 0, 0], c: [[0,0,1],[0,1,1],[0,1,0],[0,0,0]], shade: 0.72 },
    { n: [0, 1, 0], c: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], shade: 1.04 },
    { n: [0, -1, 0], c: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], shade: 0.55 },
    { n: [0, 0, 1], c: [[1,0,1],[1,1,1],[0,1,1],[0,0,1]], shade: 0.93 },
    { n: [0, 0, -1], c: [[0,0,0],[0,1,0],[1,1,0],[1,0,0]], shade: 0.78 },
  ];
  const solidAt = (x, y, z) => occupied.has(`${x},${y},${z}`);
  // Ramp cell: top surface slants from hLow (in cell units) on the low side to hHigh on the
  // high side, along the given axis. Sides are drawn only where exposed; the silhouette and
  // top become continuous slopes instead of stacked steps.
  const emitRamp = cell => {
    const { axis, sign, hLow, hHigh } = cell.ramp;
    const { x, y, z } = cell;
    const highAt = sign > 0 ? 1 : 0, lowAt = 1 - highAt;
    const along = axis === 'x' ? 'x' : 'z';
    const span = axis === 'x' ? 'z' : 'x';
    const corner = (a, h, s) => (along === 'x' ? [x + a, y + h, z + s] : [x + s, y + h, z + a]);
    // Slanted top.
    const top = [corner(lowAt, hLow, 0), corner(highAt, hHigh, 0), corner(highAt, hHigh, 1), corner(lowAt, hLow, 1)];
    const u = [top[1][0] - top[0][0], top[1][1] - top[0][1], top[1][2] - top[0][2]];
    const w = [top[3][0] - top[0][0], top[3][1] - top[0][1], top[3][2] - top[0][2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(...n) || 1;
    quad(cell, 1.04, top, [n[0] / len, n[1] / len, n[2] / len]);
    // Ends of the slope (±axis faces).
    const axisIndex = along === 'x' ? 0 : 2;
    for (const [a, dir] of [[highAt, sign > 0 ? 1 : -1], [lowAt, sign > 0 ? -1 : 1]]) {
      const h = a === highAt ? hHigh : hLow;
      if (solidAt(x + (axisIndex === 0 ? dir : 0), y, z + (axisIndex === 2 ? dir : 0))) continue;
      const shade = dir > 0 ? 0.83 : 0.72;
      const q = axisIndex === 0
        ? [[x + a, y, z], [x + a, y + h, z], [x + a, y + h, z + 1], [x + a, y, z + 1]]
        : [[x, y, z + a], [x, y + h, z + a], [x + 1, y + h, z + a], [x + 1, y, z + a]];
      quad(cell, shade, q, axisIndex === 0 ? [dir, 0, 0] : [0, 0, dir]);
    }
    // Long sides (±span faces): trapezoids following the slope.
    const spanLowAt = lowAt, spanHighAt = highAt;
    for (const s of [0, 1]) {
      const dir = s === 1 ? 1 : -1;
      if (solidAt(x + (span === 'x' ? dir : 0), y, z + (span === 'z' ? dir : 0))) continue;
      const shade = dir > 0 ? 0.93 : 0.78;
      const q = span === 'x'
        ? [[x + s, y, z + spanLowAt], [x + s, y + hLow, z + spanLowAt], [x + s, y + hHigh, z + spanHighAt], [x + s, y, z + spanHighAt]]
        : [[x + spanLowAt, y, z + s], [x + spanHighAt, y, z + s], [x + spanHighAt, y + hHigh, z + s], [x + spanLowAt, y + hLow, z + s]];
      quad(cell, shade, q, span === 'x' ? [dir, 0, 0] : [0, 0, dir]);
    }
    // Underside.
    if (!solidAt(x, y - 1, z)) quad(cell, 0.55, [[x, y, z], [x + 1, y, z], [x + 1, y, z + 1], [x, y, z + 1]], [0, -1, 0]);
  };
  let faceCount = 0;
  for (const cell of cells) {
    if (cell.ramp) { emitRamp(cell); continue; }
    for (const face of faces) {
      if (occupied.has(`${cell.x + face.n[0]},${cell.y + face.n[1]},${cell.z + face.n[2]}`)) continue;
      const batch = batchOf(cell), offset = batch.positions.length / 3;
      const color = colorOf(cell, face.shade);
      for (const corner of face.c) {
        batch.positions.push((cell.x + corner[0]) * unit, (cell.y + corner[1]) * unit, (cell.z + corner[2]) * unit);
        batch.normals.push(...face.n); batch.colors.push(color.r, color.g, color.b);
      }
      batch.indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3);
    }
  }
  for (const [materialName, batch] of batches) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(batch.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(batch.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(batch.colors, 3));
    geometry.setIndex(batch.indices); geometry.computeBoundingSphere();
    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.88, side: THREE.DoubleSide });
    material.userData.ownedByPart = true;
    const node = mesh(parent, geometry, material, [0, 0, 0], `${name}-${materialName}`);
    node.userData.sharedMaterial = materialName;
    faceCount += batch.indices.length / 6;
  }
  return { faceCount };
}

export function rng(seed = 83) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}

export function collectStats(root) {
  let triangles = 0, meshes = 0, instances = 0;
  root.traverse(node => {
    if (!node.isMesh) return;
    meshes++;
    const count = node.isInstancedMesh ? node.count : 1;
    if (node.isInstancedMesh) instances += node.count;
    triangles += (node.geometry.index ? node.geometry.index.count : node.geometry.attributes.position.count) / 3 * count;
  });
  return { triangles: Math.round(triangles), meshes, instances };
}

export function batchStaticMeshes(root) {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const batches = new Map(), originals = [];
  root.traverse(node => {
    if (!node.isMesh || node.isInstancedMesh || Array.isArray(node.material) || node.material.transparent || node.userData.noBatch) return;
    const attributes = Object.keys(node.geometry.attributes).sort().join(',');
    const key = `${node.material.uuid}:${attributes}:${Boolean(node.geometry.index)}`;
    if (!batches.has(key)) batches.set(key, { material: node.material, geometries: [] });
    const geometry = node.geometry.clone().applyMatrix4(inverse.clone().multiply(node.matrixWorld));
    batches.get(key).geometries.push(geometry);
    originals.push(node);
  });
  for (const node of originals) { node.removeFromParent(); node.geometry.dispose(); }
  for (const { material, geometries } of batches.values()) {
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries);
    if (!geometry) throw new Error('静态几何合批失败');
    mesh(root, geometry, material, [0, 0, 0], 'static-batch');
    if (geometries.length > 1) for (const item of geometries) item.dispose();
  }
}
