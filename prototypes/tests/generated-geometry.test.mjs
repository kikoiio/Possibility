import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createPlainMaterials } from '../geometry/materials.js';
import { compileScene, prepareSceneUpdate, disposeWorld } from '../geometry/scene-compiler.js';
import * as compiler from '../geometry/scene-compiler.js';
import { validateSceneDocument, validateSpatialLayout } from '../geometry/scene-validation.js';
import { validateCompiledSpatial } from '../geometry/compiled-spatial.js';
import { libraryScene } from '../geometry/scene-document.js';
import { buildWorldThree, projectWorldDocument, projectWorldState, renderWorldSVG, worldSceneBounds } from '../ui/world-scene.js';
import { createScene } from '../ui/scene.js';
import { createMansionFixture } from '../fixtures/mansion-fixture.mjs';

function fixture(count = 3) {
  const places = [
    { id: 'square', name: '广场', description: '树旁空地', position: [0, 0, 4], visibleFrom: ['well'] },
    { id: 'well', name: '井边', description: '村井', position: [5, 0, 4], visibleFrom: ['square'] },
  ];
  const actors = Array.from({ length: count }, (_, i) => ({ id: `person-${i}`, name: `居民${i}`, role: 'gardener', goal: '种菜', background: '生于此地', location: i % 2 ? 'well' : 'square', fatigue: i * 10 }));
  const scene = {
    schemaVersion: 1, profile: 'world', id: 'quiet-grove', title: '雾中村庄', style: { voxelUnit: 0.7, seed: 29 },
    regions: [{ id: 'land', kind: 'island', center: [0, 0], elevation: 0, radius: 12, irregularity: 0.02 }],
    objects: [
      { id: 'bakery', kind: 'house', name: '面包屋', transform: { position: [-4, 0, -3], rotation: 0.12 }, bounds: { width: 4, depth: 3, wallHeight: 2.8, floor: 0.8 }, roof: { kind: 'gable', rise: 1, overhang: 0.3 }, entrance: { wall: 'front', width: 1.5, height: 2.1 } },
      { id: 'oak', kind: 'tree', position: [5, 0, -4], scale: 0.5, seed: 93 },
      { id: 'lane', kind: 'path', points: [[0, 4], [5, 4]], width: 1 },
      ...actors.map(a => ({ id: a.id, kind: 'character', position: [...places.find(p => p.id === a.location).position], route: [[0, 4], [5, 4]], speed: 5 })),
    ],
  };
  return { world: { profile: 'generated-world', title: '村人的春天', description: '一座变化中的村庄', environment: { weather: '细雨' }, places, actors, resources: [{ id: 'grain', name: '麦粒', unit: '袋', location: 'square', quantity: 7, capacity: 20 }] }, scene: { document: scene }, paused: true, speed: 2, worldMinute: 47, revision: 8, genesis: { fixture: true } };
}
function disposeMaterials(materials) { Object.values(materials).forEach(m => m.dispose()); }
const node = (doc, id) => doc.objects.find(o => o.id === id);

for (const backend of ['solid', 'voxel']) test(`world ${backend}: optional legacy landmarks absent, actual land support and variable actors compile`, () => {
  const materials = createPlainMaterials();
  try {
    assert.ok(Object.values(materials).every(m => !m.map));
    for (const count of [0, 1, 5]) {
      const state = fixture(count), doc = state.scene.document;
      assert.deepEqual(validateSceneDocument(doc), []); assert.deepEqual(validateSpatialLayout(doc), []);
      const world = compileScene(doc, backend, { materials });
      try {
        assert.equal(Object.keys(world.userData.parts).filter(id => id.startsWith('character:')).length, count);
        assert.deepEqual(validateCompiledSpatial(doc, world.userData.parts), []);
        const names = []; world.traverse(o => names.push(o.name));
        assert.ok(!names.includes('island-path')); assert.ok(!names.includes('island-garden'));
        assert.ok(world.userData.parts['house:bakery'].children.length);
        // The probe must fail for a displaced real terrain, not accept declarations.
        world.userData.parts.terrain.position.x += 100;
        assert.ok(validateCompiledSpatial(doc, world.userData.parts).some(e => e.requirementId === 'world.land.support'));
        world.userData.parts.terrain.position.x -= 100;
      } finally { disposeWorld(world); }
    }
  } finally { disposeMaterials(materials); }
});

test('world optional library, porch, bridge and water still use both original backends', () => {
  const doc = structuredClone(libraryScene); doc.profile = 'world';
  // World adds stricter physical ground attachment than the legacy experiment.
  node(doc, 'library').bounds.floor = 1.48;
  node(doc, 'porch').bounds.floor = 1.2;
  // Optional porch uses the same declared connection, aligned at the front door.
  node(doc, 'porch').transform.position[2] = 4.8;
  const materials = createPlainMaterials();
  try {
    assert.deepEqual(validateSceneDocument(doc), []);
    assert.deepEqual(validateSpatialLayout(doc), []);
    for (const backend of ['solid', 'voxel']) { const world = compileScene(doc, backend, { materials }); disposeWorld(world); }
  } finally { disposeMaterials(materials); }
});

test('world malformed structure, unbounded work, floating actors, collisions and blocked paths reject before build', () => {
  const edits = [
    d => { d.regions.push({ id: 'water', kind: 'water', center: [0, 0], elevation: 1, size: [40, 40] }); },
    d => { d.regions.push({ id: 'water', kind: 'water', center: [0, 0], elevation: -1, size: [5, 5] }); },
    d => { node(d, 'person-0').route = [[-250, 0], [250, 0], [-250, 0]]; },
    d => { d.regions = []; }, d => { d.objects.push(null); }, d => { d.regions.push(null); },
    d => { d.objects[0].bounds.width = Infinity; }, d => { d.objects[0].roof = null; },
    d => { d.objects[0].transform.rotationY = 2; }, d => { d.regions[0].radius = 1e7; },
    d => { d.regions[0].radius = 40; d.style.voxelUnit = 0.2; },
    d => { d.objects = Array.from({ length: 129 }, (_, i) => ({ id: `p-${i}`, kind: 'character', position: [0, 0, 4] })); },
    d => { node(d, 'person-0').position = [0, 4, 4]; },
    d => { node(d, 'oak').position = [5, 2, -4]; },
    d => { node(d, 'person-0').position = [-4, 0, -3]; },
    d => { node(d, 'person-0').position = [50, 0, 4]; },
    d => { node(d, 'bakery').transform.position[1] = 10; },
    d => { node(d, 'lane').points = [[-9, -3], [8, -3]]; },
    d => { node(d, 'lane').points = [[4, -4], [6, -4]]; },
    d => { const house = structuredClone(node(d, 'bakery')); house.id = 'collision'; d.objects.push(house); },
    d => { const tree = structuredClone(node(d, 'oak')); tree.id = 'collision'; d.objects.push(tree); },
    d => { node(d, 'oak').scale = NaN; }, d => { node(d, 'bakery').windows = [null]; },
    d => { node(d, 'bakery').attachments = [null]; }, d => { d.regions = null; },
  ];
  for (const edit of edits) {
    const doc = fixture(1).scene.document; edit(doc);
    assert.doesNotThrow(() => validateSceneDocument(doc));
    assert.throws(() => compileScene(doc, 'solid', { materials: {} }), error => error.name === 'SceneCompileError' && error.diagnostics.length > 0);
  }
  for (const input of [null, false, [], {}, { profile: 'world' }, { profile: 'world', regions: [], objects: [] }]) assert.throws(() => compileScene(input, 'solid'), /schemaVersion|场景|world|数组|世界|体素/);
});

test('world incremental recipes retain unchanged meshes; move/remove/add and cancellation are atomic', () => {
  const materials = createPlainMaterials(), doc = fixture(2).scene.document, world = compileScene(doc, 'solid', { materials });
  try {
    const before = { ...world.userData.parts };
    doc.title = '改名'; prepareSceneUpdate(doc, 'solid', { world, materials }).commit();
    assert.deepEqual(world.userData.rebuiltParts, []);
    node(doc, 'bakery').roof.rise = 1.4;
    const canceled = prepareSceneUpdate(doc, 'solid', { world, materials }); canceled.cancel();
    assert.deepEqual(world.userData.parts, before);
    prepareSceneUpdate(doc, 'solid', { world, materials }).commit();
    assert.deepEqual(world.userData.rebuiltParts, ['house:bakery']);
    assert.equal(world.userData.parts.terrain, before.terrain);
    node(doc, 'person-0').position = [3, 0, 4];
    prepareSceneUpdate(doc, 'solid', { world, materials }).commit();
    assert.deepEqual(world.userData.rebuiltParts, ['character:person-0']);
    doc.objects = doc.objects.filter(o => o.id !== 'person-1');
    doc.objects.push({ id: 'new-person', kind: 'character', position: [-2, 0, 5] });
    prepareSceneUpdate(doc, 'solid', { world, materials }).commit();
    assert.equal(world.userData.parts['character:person-1'], undefined); assert.ok(world.userData.parts['character:new-person']);
    const accepted = { ...world.userData.parts }; node(doc, 'bakery').transform.position = [0, 0, 4];
    assert.throws(() => prepareSceneUpdate(doc, 'solid', { world, materials }));
    assert.deepEqual(world.userData.parts, accepted);
  } finally { disposeWorld(world); disposeMaterials(materials); }
});

test('projection maps only current actor locations, preserves all view facts and never mutates source', () => {
  const input = fixture(4), before = structuredClone(input), materials = createPlainMaterials();
  const world = compileScene(input.scene.document, 'solid', { materials }), parts = { ...world.userData.parts };
  try {
    projectWorldState(world, input); assert.deepEqual(input, before);
    input.world.actors[0].location = 'well'; input.world.actors[0].fatigue = 61;
    input.world.resources[0].quantity = 3; input.paused = false; input.speed = 20; input.worldMinute = 83; input.revision++;
    projectWorldState(world, input);
    assert.deepEqual(world.userData.parts['character:person-0'].position.toArray(), [5, 0, 4]);
    assert.deepEqual(world.userData.parts, parts); assert.equal(world.userData.parts['character:person-0'].userData.route, null);
    assert.deepEqual(world.userData.viewFacts.world, input.world); assert.equal(world.userData.viewFacts.worldMinute, 83);
    assert.equal(node(input.scene.document, 'person-0').position[0], 0);
    const svg = renderWorldSVG(input);
    assert.match(svg, /data-object-id="person-0" data-world-x="5" data-world-y="0" data-world-z="4"/);
    assert.match(svg, /麦粒 3\/20/); assert.match(svg, /疲劳 61/); assert.match(svg, /速度 20/);
    assert.match(svg, /细雨/); assert.match(svg, /第 83 分钟/);
    input.world.actors[0].location = 'missing'; assert.throws(() => projectWorldDocument(input), /location/);
    input.world.actors[0].id = 'unmatched'; assert.throws(() => projectWorldDocument(input), /一一对应/);
  } finally { disposeWorld(world); disposeMaterials(materials); }
});

class Element {
  style = {}; dataset = {}; events = {}; attributes = {}; children = []; clientWidth = 900; clientHeight = 600;
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, fn) { this.events[type] = fn; } removeEventListener(type) { delete this.events[type]; }
  append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children = children; } remove() { this.removed = true; }
}
async function environment(fn) {
  const names = ['document', 'window', 'ResizeObserver'], saved = new Map(names.map(n => [n, Object.getOwnPropertyDescriptor(globalThis, n)]));
  globalThis.document = Object.assign(new Element(), { hidden: false, createElement: () => new Element() });
  globalThis.window = { devicePixelRatio: 1 }; globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  try { return await fn(); } finally { for (const [name, prop] of saved) if (prop) Object.defineProperty(globalThis, name, prop); else delete globalThis[name]; }
}

test('world real renderer lifecycle uses CPU sink: movement, preview, invalid draft, orbit, loss, disposal', () => environment(() => {
  let rendered, renders = 0, released = 0;
  class Renderer {
    domElement = new Element(); setPixelRatio() {} setSize() {}
    render(scene, camera) { rendered = { scene, camera }; renders++; }
    dispose() { released++; } forceContextLoss() {}
  }
  const shell = { root: new Element(), stage: new Element(), reset: new Element() }, input = fixture(3), before = structuredClone(input);
  const view = buildWorldThree({ ...THREE, WebGLRenderer: Renderer }, shell, input, compiler, { createPlainMaterials });
  assert.equal(view.mode, '3d'); assert.deepEqual(input, before);
  let world; rendered.scene.traverse(o => { if (o.userData.profile === 'world') world = o; });
  const parts = { ...world.userData.parts }, canvas = shell.stage.children[0];
  input.world.actors[0].location = 'well'; view.update(input);
  assert.deepEqual(world.userData.parts['character:person-0'].position.toArray(), [5, 0, 4]);
  assert.equal(world.userData.parts['character:person-0'], parts['character:person-0']);
  const preview = structuredClone(input); preview.scene.document.title = '试看的村庄'; node(preview.scene.document, 'bakery').roof.rise = 1.3;
  view.update(preview);
  assert.notEqual(world.userData.parts['house:bakery'], parts['house:bakery']); assert.equal(world.userData.parts.terrain, parts.terrain);
  assert.deepEqual(world.userData.parts['character:person-0'].position.toArray(), [5, 0, 4]);
  // Weather and totals are chips inside the scene, and the drag hint is a
  // legend element rather than free-floating caption text.
  const row = shell.stage.children.find(child => child.className === 'scene-overlay');
  assert.equal(row.hidden, false);
  assert.equal(row.children[0], shell.reset);
  assert.equal(row.children[1].textContent, '细雨'); assert.equal(row.children[2].children.map(c => c.textContent).join(''), '麦粒 7袋');
  // The drag hint is the row's last item, never a floating element of its own.
  assert.match(row.children.at(-1).textContent, /拖动环视/); assert.match(row.children.at(-1).className, /scene-legend/);
  const accepted = world.userData.parts['house:bakery']; node(preview.scene.document, 'bakery').bounds.width = Infinity;
  view.update(preview); assert.equal(world.userData.parts['house:bakery'], accepted); assert.ok(shell.root.dataset.sceneError);
  view.update(input); assert.equal(shell.root.dataset.sceneError, undefined);
  const cameraBefore = rendered.camera.position.clone(); canvas.events.wheel({ preventDefault() {}, deltaY: 150 });
  assert.ok(cameraBefore.distanceTo(rendered.camera.position) > 1);
  canvas.events.pointerdown({ button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  canvas.events.pointermove({ pointerId: 1, clientX: 100, clientY: 50 }); canvas.events.pointerup({ pointerId: 1 }); assert.ok(renders > 5);
  const resources = new Set(); world.traverse(o => { if (o.geometry) resources.add(o.geometry); if (o.material) resources.add(o.material); });
  const freed = new Map(); resources.forEach(r => r.addEventListener('dispose', () => freed.set(r, (freed.get(r) || 0) + 1)));
  canvas.events.webglcontextlost({ preventDefault() {} });
  assert.equal(view.mode, 'fallback'); assert.equal(released, 1); resources.forEach(r => assert.equal(freed.get(r), 1));
  input.world.actors[0].location = 'square'; view.update(input); assert.match(shell.stage.innerHTML, /data-object-id="person-0" data-world-x="0"/);
  view.dispose(); view.dispose(); assert.equal(released, 1); assert.equal(shell.root.removed, true);
}));

test('createScene selects generic fallback and escapes generated text with the same positions', () => environment(async () => {
  const input = fixture(5); input.world.title = '<script>bad</script>'; input.world.actors[0].name = '" onload="bad';
  const original = structuredClone(input), host = new Element(), view = await createScene(host, input);
  try {
    assert.equal(view.mode, 'fallback'); const shell = host.children[0], stage = shell.children[0];
    assert.equal(shell.children[1].attributes['aria-label'], '重置世界视角');
    assert.equal((stage.innerHTML.match(/data-object-id="person-/g) || []).length, 5);
    assert.ok(!stage.innerHTML.includes('<script>')); assert.ok(stage.innerHTML.includes('&lt;script&gt;'));
    assert.deepEqual(input, original);
    input.world.actors[0].location = 'well'; view.update(input);
    assert.match(stage.innerHTML, /data-object-id="person-0" data-world-x="5"/);
    const valid = stage.innerHTML; node(input.scene.document, 'bakery').bounds.width = -1; view.update(input);
    assert.ok(shell.dataset.sceneError); assert.equal(stage.innerHTML, valid);
    const b = worldSceneBounds(original.scene.document); assert.ok(b.span >= 18 && b.span < 30, `户外取景应围绕内容，实际 span=${b.span}`); assert.ok(b.center.every(Number.isFinite));
  } finally { view.dispose(); }
}));

test('indoor world bounds focus the room cross-section instead of the support island', () => {
  const state = createMansionFixture();
  const focused = worldSceneBounds(state.scene);
  assert.ok(focused.span < 24, `室内镜头应聚焦房间，实际 span=${focused.span}`);
  assert.ok(Math.abs(focused.center[0]) < 0.1);
  assert.ok(Math.abs(focused.center[2]) < 0.1);
  assert.ok(focused.center[1] > 1 && focused.center[1] < 2.5);
});


test('mixed bounds include outdoor geometry and empty outdoor places, preserving pure interiors', () => {
  const doc = createMansionFixture().scene;
  const indoor = worldSceneBounds(doc);
  assert.ok(indoor.span < 24);
  // Outdoor frames are content-driven, so the same far object must land on the
  // same frame whether it is a built tree or an unbuilt place: neither may be
  // cropped, and neither may be framed by the island's outer radius alone.
  const mixed = structuredClone(doc);
  mixed.objects.push({ id: 'outside-tree', kind: 'tree', position: [11, .8, 0], scale: .2 });
  const withTree = worldSceneBounds(mixed), withPlace = worldSceneBounds(doc, [{ position: [11, .8, 0] }]);
  assert.ok(withTree.span >= 27 && withTree.span < 34, `远处对象应留在画面内，实际 span=${withTree.span}`);
  assert.ok(Math.abs(withTree.span - withPlace.span) < 1.5);
  const moved = structuredClone(doc);
  moved.objects.find(o => o.kind === 'character').position = [11, .8, 0];
  assert.ok(worldSceneBounds(moved).span >= 27);
  const near = structuredClone(doc);
  near.objects.push({ id: 'near-tree', kind: 'tree', position: [2, .8, 1], scale: .2 });
  // A far object drives the frame; a near one inside the rooms must not shrink it.
  assert.ok(worldSceneBounds(near).span <= withPlace.span);
  assert.deepEqual(worldSceneBounds(doc), indoor);
});

test('live labels follow committed positions and occupancy; resource labels refresh and dispose', () => environment(() => {
  document.createElement = () => Object.assign(new Element(), {
    drawnText: [],
    getContext() { return { clearRect() {}, fillRect() {}, fillText: text => this.drawnText.push(text) }; },
  });
  let rendered;
  class Renderer {
    domElement = new Element(); setPixelRatio() {} setSize() {}
    render(scene) { rendered = scene; } dispose() {} forceContextLoss() {}
  }
  const definition = createMansionFixture();
  const input = { world: definition.world, scene: { document: definition.scene }, paused: true, worldMinute: 0, revision: 0 };
  const place = input.world.places[0], other = input.world.places[1];
  input.world.actors.forEach(actor => { actor.location = place.id; });
  input.world.resources = [{ id: 'water', name: '饮水', quantity: 7, capacity: 9, unit: '杯', location: place.id }];
  const shell = { root: new Element(), stage: new Element(), reset: new Element() };
  const view = buildWorldThree({ ...THREE, WebGLRenderer: Renderer }, shell, input, compiler, { createPlainMaterials });
  const actor = input.world.actors[0], label = rendered.getObjectByName(`actor-label:${actor.id}`);
  const assertLabels = () => {
    for (const person of input.world.actors) {
      const part = rendered.getObjectByName(`character:${person.id}`);
      const actual = rendered.getObjectByName(`actor-label:${person.id}`);
      assert.deepEqual(actual.position.toArray(), [part.position.x + part.userData.displayOffset[0], part.position.y + 2.05, part.position.z + part.userData.displayOffset[2]]);
    }
  };
  try {
    assertLabels();
    const oldPlaceLabel = rendered.getObjectByName(`place-label:${place.id}`);
    assert.ok(oldPlaceLabel.material.map.image.drawnText.some(text => text.includes('饮水 7杯')));
    let disposed = 0;
    oldPlaceLabel.material.map.addEventListener('dispose', () => disposed++);
    actor.location = other.id;
    input.world.resources[0].quantity = 0;
    view.update(input);
    assertLabels();
    assert.equal(rendered.getObjectByName(`actor-label:${actor.id}`), label, 'movement reuses label texture');
    assert.deepEqual(label.position.toArray(), [other.position[0], other.position[1] + 2.05, other.position[2]]);
    assert.equal(disposed, 1);
    const newPlaceLabel = rendered.getObjectByName(`place-label:${place.id}`);
    assert.ok(newPlaceLabel.material.map.image.drawnText.some(text => text.includes('饮水 0杯')));
    view.update(input);
    assert.equal(rendered.getObjectByName(`place-label:${place.id}`), newPlaceLabel);
    const svg = renderWorldSVG(input);
    assert.match(svg, /饮水 0杯/);
    assert.ok(svg.includes(`data-actor-label="${actor.id}"`));
    input.world.resources = []; view.update(input);
    assert.ok(!rendered.getObjectByName(`place-label:${place.id}`).material.map.image.drawnText.some(text => text.includes('饮水')));
    let finalDisposed = 0;
    label.material.map.addEventListener('dispose', () => finalDisposed++);
    view.dispose(); assert.equal(finalDisposed, 1);
  } finally { view.dispose(); }
}));
