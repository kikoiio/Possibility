import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { libraryScene, villageScene, validateSceneDocument, validateSpatialLayout } from './src/scene-document.js';
import { compileScene, compileSceneParts, disposeWorld } from './src/scene-compiler.js';
import { createUnfamiliarScene } from './src/scene-fixtures.js';
import { bridgePoint, localToWorld } from './src/scene-validation.js';
import { validateCompiledSpatial } from './src/compiled-spatial.js';
import { buildSolid } from './src/solid.js';
import { buildVoxel } from './src/voxel.js';

const names = ['grass','earth','stone','stoneDark','plaster','wood','woodLight','roof','roofLight','glass','water','waterLight','leaf','leafLight','reed','cream','terracotta','bookRed','bookBlue','bookGold','dark'];
const materials = Object.fromEntries(names.map(name => [name, new THREE.MeshStandardMaterial()]));
const options = { materials, details: true, edited: false, cutaway: false };
const copy = () => structuredClone(libraryScene);
const resources = part => {
  const result = [];
  part.traverse(node => { if (node.isMesh) result.push([node.geometry, node.material]); });
  return result;
};

for (const backend of ['solid', 'voxel']) {
  test(`${backend}: porch edit compiles only porch and preserves stable resources`, () => {
    const doc = copy();
    const world = compileScene(doc, backend, options);
    const before = Object.fromEntries(Object.entries(world.userData.parts).map(([id, part]) => [id, { part, resources: resources(part), hash: part.userData.recipeHash }]));
    let disposed = 0;
    before.porch.resources.forEach(([geometry]) => geometry.addEventListener('dispose', () => disposed++));
    doc.objects.find(o => o.kind === 'porch').bounds.width = 7;
    const updated = compileSceneParts(doc, backend, { ...options, world }, ['porch']);
    assert.equal(updated, world);
    assert.deepEqual(world.userData.rebuiltParts, ['porch']);
    for (const id of ['terrain', 'library', 'interior', 'nature', 'bridge']) {
      assert.equal(world.userData.parts[id], before[id].part, id);
      assert.deepEqual(resources(world.userData.parts[id]), before[id].resources, id);
      assert.equal(world.userData.parts[id].userData.recipeHash, before[id].hash, id);
    }
    assert.ok(disposed > 0);
    compileSceneParts(doc, backend, { ...options, edited: true, world }, ['porch']);
    assert.deepEqual(world.userData.rebuiltParts, ['porch', 'bridge']);
    compileSceneParts(doc, backend, { ...options, edited: true, world });
    assert.deepEqual(world.userData.rebuiltParts, []);
    disposeWorld(world);
  });
}

test('malformed documents return contextual diagnostics without crashing', () => {
  for (const doc of [null, {}, { ...copy(), objects: [null] }, { ...copy(), regions: [null] }]) {
    const errors = validateSceneDocument(doc);
    assert.ok(errors.length);
    for (const error of errors) for (const key of ['nodeId', 'operationId', 'requirementId']) assert.equal(typeof error[key], 'string');
  }
  const doc = copy();
  doc.objects[0].kind = 'spaceship';
  assert.ok(validateSceneDocument(doc).some(e => e.nodeId === 'library' && e.requirementId === 'object.kind'));
  assert.equal(validateSceneDocument(createUnfamiliarScene()).length, 0);
});

test('spatial rejection identifies clearance, bounds and endpoints', () => {
  const doc = copy();
  doc.objects[0].entrance.width = 0.7;
  doc.objects[2].to.point = [40, 0.9, 6];
  const errors = validateSpatialLayout(doc);
  assert.ok(errors.some(e => e.requirementId === 'entrance.clearance'));
  assert.ok(errors.some(e => e.requirementId === 'bridge.endpoint.to'));
});

test('builders allocate only selected parts; tree objects survive details=false', () => {
  for (const build of [buildSolid, buildVoxel]) {
    const partial = build(materials, false, true, false, copy(), { parts: ['porch'] });
    assert.deepEqual(Object.keys(partial.userData.parts), ['porch']);
    assert.equal(partial.children.length, 1);
    disposeWorld(partial);
    const nature = build(materials, false, false, false, copy(), { parts: ['nature'] });
    assert.equal(nature.userData.parts.nature.visible, true);
    assert.ok(resources(nature.userData.parts.nature).length > 0);
    disposeWorld(nature);
  }
});

test('compiled probes reject a blocked entrance and missing bridge deck', () => {
  const doc = copy();
  const world = compileScene(doc, 'solid', options);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 0.3), materials.wood);
  wall.position.set(0, 2.5, 3.5);
  world.userData.parts.library.add(wall);
  world.userData.parts.bridge.clear();
  const errors = validateCompiledSpatial(doc, world.userData.parts);
  assert.ok(errors.some(e => e.operationId === 'probe-entrance'));
  assert.ok(errors.some(e => e.operationId === 'probe-bridge-path'));
  disposeWorld(world);
});

test('invalid updates retain accepted world and diagnostics carry context', () => {
  const doc = copy();
  const world = compileScene(doc, 'solid', options);
  const original = world.userData.parts.library;
  doc.objects[0].bounds.width = -2;
  assert.throws(() => compileSceneParts(doc, 'solid', { ...options, world }), error => error.diagnostics.some(d => d.nodeId === 'library' && d.operationId && d.requirementId));
  assert.equal(world.userData.parts.library, original);
  disposeWorld(world);
});

test('village: houses and paths compile on both backends with their own parts', () => {
  assert.deepEqual(validateSceneDocument(villageScene), []);
  assert.deepEqual(validateSpatialLayout(villageScene), []);
  for (const backend of ['solid', 'voxel']) {
    const world = compileScene(villageScene, backend, options);
    const partIds = Object.keys(world.userData.parts);
    for (const house of villageScene.objects.filter(o => o.kind === 'house')) {
      assert.ok(partIds.includes(`house:${house.id}`), `${backend}:${house.id}`);
    }
    assert.ok(partIds.includes('path:lane-main'), `${backend}:path`);
    assert.deepEqual(validateCompiledSpatial(villageScene, world.userData.parts), []);
    disposeWorld(world);
  }
});

test('village: editing one house or path rebuilds only that part; overlapping buildings rejected', () => {  for (const backend of ['solid', 'voxel']) {
    const doc = structuredClone(villageScene);
    const world = compileScene(doc, backend, options);
    doc.objects.find(o => o.id === 'h2').roof.rise += 0.2;
    compileSceneParts(doc, backend, { ...options, world });
    assert.deepEqual(world.userData.rebuiltParts, ['house:h2'], `${backend}:house`);
    doc.objects.find(o => o.id === 'lane-main').width = 1.3;
    compileSceneParts(doc, backend, { ...options, world });
    assert.deepEqual(world.userData.rebuiltParts, ['path:lane-main'], `${backend}:path`);
    doc.objects = doc.objects.filter(o => o.id !== 'h3');
    compileSceneParts(doc, backend, { ...options, world });
    assert.ok(!Object.keys(world.userData.parts).includes('house:h3'), `${backend}:stale-removed`);
    disposeWorld(world);
  }
  const bad = structuredClone(villageScene);
  bad.objects.find(o => o.id === 'h2').transform.position = [-8.5, 0, -5];
  assert.ok(validateSpatialLayout(bad).some(e => e.requirementId === 'object.separation'));
  const crossing = structuredClone(villageScene);
  crossing.objects.find(o => o.id === 'lane-main').points = [[0, 6.8], [0, 12.3]];
  assert.ok(validateSpatialLayout(crossing).some(e => e.requirementId === 'path.clearance'));
});

test('characters: spawn on island, routes validated, compiled per part with walk metadata', () => {
  assert.ok(villageScene.objects.some(o => o.kind === 'character' && Array.isArray(o.route)));
  for (const backend of ['solid', 'voxel']) {
    const world = compileScene(villageScene, backend, options);
    const part = world.userData.parts['character:villager-1'];
    assert.ok(part, `${backend}:character part`);
    assert.ok(Array.isArray(part.userData.route) && part.userData.route.length >= 2);
    assert.equal(part.userData.home.length, 3);
    disposeWorld(world);
  }
  const inside = structuredClone(villageScene);
  inside.objects.find(o => o.id === 'villager-2').position = [0, 0.8, 0];
  assert.ok(validateSpatialLayout(inside).some(e => e.requirementId === 'character.clearance'));
  const offIsland = structuredClone(villageScene);
  offIsland.objects.find(o => o.id === 'villager-2').position = [1.8, 0.8, 30];
  assert.ok(validateSpatialLayout(offIsland).some(e => e.requirementId === 'character.region'));
  const offRoute = structuredClone(villageScene);
  offRoute.objects.find(o => o.id === 'villager-1').route = [[1.8, 7.2], [1.8, 40]];
  assert.ok(validateSpatialLayout(offRoute).some(e => e.requirementId === 'character.region'));
});

test('unfamiliar rotated document is compiled from semantic parameters', () => {
  const doc = createUnfamiliarScene();
  assert.equal(validateSpatialLayout(doc).length, 0);
  for (const backend of ['solid', 'voxel']) {
    const world = compileScene(doc, backend, options);
    assert.deepEqual(Object.keys(world.userData.parts), ['terrain', 'library', 'interior', 'porch', 'bridge', 'nature']);
    assert.equal(world.userData.sceneId, doc.id);
    const building = doc.objects[0];
    const [x, z] = localToWorld(building, 0, 0);
    const bounds = new THREE.Box3().setFromObject(world.userData.parts.library);
    assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).x - x) < 0.3);
    assert.ok(Math.abs(bounds.getCenter(new THREE.Vector3()).z - z) < 0.3);
    assert.ok(bounds.max.y >= building.transform.position[1] + building.bounds.floor + building.bounds.wallHeight + building.roof.rise - 0.1);
    assert.deepEqual(validateCompiledSpatial(doc, world.userData.parts), []);
    disposeWorld(world);
  }
});
