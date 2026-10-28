import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlainMaterials } from '../geometry/materials.js';
import { compileScene, prepareSceneUpdate, disposeWorld } from '../geometry/scene-compiler.js';
import { validateSceneDocument, validateSpatialLayout } from '../geometry/scene-validation.js';
import { validateWorldBindings } from '../geometry/world-bindings.js';
import { validateWorldDefinition } from '../world-definition.mjs';
import { buildWorldThree, projectWorldDocument, renderWorldSVG } from '../ui/world-scene.js';
import { createMansionFixture } from '../fixtures/mansion-fixture.mjs';

class Element {
  style = {}; dataset = {}; attributes = {}; events = {}; children = []; clientWidth = 900; clientHeight = 600;
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, listener) { this.events[type] = listener; }
  removeEventListener(type) { delete this.events[type]; }
  replaceChildren(...children) { this.children = children; }
  remove() { this.removed = true; }
}

const definition = createMansionFixture();
assert.deepEqual(validateWorldDefinition(definition), [], 'public mansion fixture must satisfy the world schema');
assert.deepEqual(validateSceneDocument(definition.scene), []);
assert.deepEqual(validateSpatialLayout(definition.scene), []);
assert.deepEqual(validateWorldBindings(definition.world, definition.scene), [], 'every place must bind to its room');

const state = {
  world: definition.world,
  scene: { document: definition.scene },
  paused: true,
  speed: 1,
  worldMinute: 0,
  revision: 0,
};
const projected = projectWorldDocument(state);
const projectedLin = projected.objects.find(object => object.id === 'lin');
assert.equal(projectedLin.roomId, 'room-hall');
assert.deepEqual(projectedLin.position, definition.world.places[0].position);

const svg = renderWorldSVG(state);
assert.equal((svg.match(/data-room-label=/g) || []).length, 4, 'SVG fallback must label all four rooms');
assert.match(svg, /data-room-label="会客厅"[^>]*>会客厅/);
const markerPosition = actorId => svg.match(new RegExp(`<g data-object-id="${actorId}"[^>]*transform="translate\\(([-0-9.]+) ([-0-9.]+)\\)">`))?.slice(1).map(Number);
const svgLin = markerPosition('lin'), svgXu = markerPosition('xu');
assert.ok(svgLin && svgXu && (svgLin[0] !== svgXu[0] || svgLin[1] !== svgXu[1]), 'co-located indoor actors need distinct display markers');
assert.match(svg, /data-object-id="lin" data-world-x="[-0-9.]+" data-world-y="0\.8" data-world-z="3\.4"/);

const invalidRoom = structuredClone(definition.world);
invalidRoom.places[0].roomId = 'missing-room';
assert.ok(validateWorldBindings(invalidRoom, definition.scene).some(error => error.requirementId === 'character.room'), 'unknown place.roomId must be rejected');

const overlapping = structuredClone(definition.scene);
const duplicateRoom = structuredClone(overlapping.objects.find(object => object.id === 'room-study'));
duplicateRoom.id = 'room-overlap'; duplicateRoom.name = '重叠房间';
duplicateRoom.transform.position = [...overlapping.objects.find(object => object.id === 'room-hall').transform.position];
overlapping.objects.push(duplicateRoom);
assert.ok(validateSpatialLayout(overlapping).some(error => error.requirementId === 'room.overlap'), 'overlapping rooms must be rejected');

let view;
const descriptors = ['document', 'window', 'ResizeObserver'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
const fakeContext = { clearRect() {}, fillRect() {}, beginPath() {}, roundRect() {}, fill() {}, fillText() {} };
const fakeDocument = Object.assign(new Element(), {
  hidden: false,
  createElement() {
    const canvas = { width: 0, height: 0, drawnText: [] };
    const context = { ...fakeContext, fillText: text => canvas.drawnText.push(text) };
    canvas.getContext = () => context;
    return canvas;
  },
});
class Renderer {
  constructor() { this.domElement = new Element(); Renderer.latest = this; }
  setPixelRatio() {}
  setSize() {}
  render(scene, camera) { this.scene = scene; this.camera = camera; }
  dispose() {}
  forceContextLoss() {}
}
globalThis.document = fakeDocument;
globalThis.window = { devicePixelRatio: 1 };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
try {
  const shell = { root: new Element(), stage: new Element(), reset: new Element() };
  view = buildWorldThree({ ...THREE, WebGLRenderer: Renderer }, shell, state, { compileScene, prepareSceneUpdate, disposeWorld }, { createPlainMaterials });
  assert.equal(view.mode, '3d');
  const scene = Renderer.latest.scene;
  // A bound room is labeled by its place (including current resources), while
  // unbound rooms retain a room label. Verify coverage and content, not a prefix.
  const assertRoomLabels = snapshot => {
    const labels = new Set();
    const camera = Renderer.latest.camera;
    scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
    const frustum = new THREE.Frustum().setFromProjectionMatrix(
      new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const room of snapshot.scene.document.objects.filter(object => object.kind === 'room')) {
      const places = snapshot.world.places.filter(place => place.roomId === room.id);
      const label = places.length
        ? scene.getObjectByName(`place-label:${places[0].id}`)
        : scene.getObjectByName(`room-label:${room.id}`);
      assert.ok(label?.isSprite, `${room.id} must have a label sprite`);
      for (let parent = label; parent; parent = parent.parent) assert.equal(parent.visible, true);
      assert.equal(label.material.visible, true);
      assert.ok(label.material.opacity > 0 && label.scale.x > 0 && label.scale.y > 0);
      assert.ok(label.material.map?.isTexture, `${room.id} must have a text texture`);
      assert.ok(label.material.map.image.drawnText.includes(places[0]?.name || room.name || room.id), `${room.id} label must contain its displayed name`);
      const position = places[0]?.position || room.transform.position;
      assert.deepEqual(label.position.toArray(), [position[0], room.transform.position[1] + room.bounds.floor + room.bounds.wallHeight + 0.14, position[2]]);
      assert.ok(frustum.intersectsSprite(label), `${room.id} label must be inside the camera frustum`);
      labels.add(label);
    }
    assert.equal(labels.size, 4, 'Three renderer must cover every room with a distinct visible label');
  };
  assertRoomLabels(state);
  let compiled;
  const findCompiled = node => { if (node?.userData?.profile === 'world') compiled = node; node?.children?.forEach(findCompiled); };
  findCompiled(scene);
  assert.ok(compiled);
  const linPart = compiled.userData.parts['character:lin'], xuPart = compiled.userData.parts['character:xu'];
  assert.deepEqual(linPart.position.toArray(), definition.world.places[0].position);
  assert.deepEqual(linPart.userData.authoritativePosition, definition.world.places[0].position);
  assert.notDeepEqual(linPart.userData.displayMarker.position.toArray(), xuPart.userData.displayMarker.position.toArray());
  const preview = structuredClone(state);
  preview.scene.document.objects.find(object => object.id === 'room-hall').bounds.wallHeight = 3;
  view.update(preview);
  assert.deepEqual(compiled.userData.rebuiltParts, ['room:room-hall'], 'room edits must rebuild only their incremental room part');
  assertRoomLabels(preview);
} finally {
  view?.dispose();
  for (const [name, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name];
}

for (const backend of ['solid', 'voxel']) {
  const backendMaterials = createPlainMaterials();
  const world = compileScene(definition.scene, backend, { materials: backendMaterials });
  try {
    for (const room of definition.scene.objects.filter(object => object.kind === 'room')) assert.ok(world.userData.parts[`room:${room.id}`]);
    assert.equal(Object.keys(world.userData.parts).filter(id => id.startsWith('character:')).length, 4);
  } finally {
    disposeWorld(world);
    for (const material of Object.values(backendMaterials)) material.dispose();
  }
}

console.log(JSON.stringify({
  fixture: definition.scene.id,
  schema: 'valid',
  roomCount: definition.scene.objects.filter(object => object.kind === 'room').length,
  actorCount: definition.world.actors.length,
  svgRoomLabels: 4,
  colocatedHallActorsSeparated: true,
  invalidRoomBindingRejected: true,
  overlappingRoomsRejected: true,
  compiledBackends: ['solid', 'voxel'],
}));
