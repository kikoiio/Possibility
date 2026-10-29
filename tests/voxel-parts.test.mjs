import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVoxelWorldStore } from '../voxel-world.mjs';

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'voxel-parts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'world.json');
}
const roof = { op: 'object', id: 'roof', name: '坡屋顶', kind: 'roof', from: [0, 4, 0], to: [4, 6, 2] };
const build = [
  { op: 'roof', from: roof.from, to: roof.to, material: 'wood', objectId: 'roof' },
  { op: 'fill', from: [2, 4, 1], to: [2, 4, 1], material: 'wood' },
  roof,
];

test('part recoloring changes exact slope members, preserving unrelated wood inside its bounds', t => {
  const store = createVoxelWorldStore({ file: setup(t) });
  store.apply({ baseRevision: 0, commands: build });
  assert.equal(store.state().objects[0].members?.length, 15);
  const before = store.state();
  const after = store.apply({ baseRevision: 1, commands: [{ op: 'paint-object', id: 'roof', material: 'roof' }] });
  assert.equal(after.cells.filter(c => c.material === 'roof').length, 15);
  assert.equal(after.cells.find(c => c.position.join() === '2,4,1').material, 'wood');
  assert.equal(after.cells.length, before.cells.length);
  assert.deepEqual(after.objects[0].members, before.objects[0].members);
});

test('direct overwrites invalidate membership, metadata preserves it, and undo/restart restore it', t => {
  const file = setup(t);
  let store = createVoxelWorldStore({ file });
  store.apply({ baseRevision: 0, commands: build });
  store.apply({ baseRevision: 1, commands: [
    { op: 'fill', from: [0, 4, 0], to: [0, 4, 0], material: 'glass' },
    { ...roof, name: '旧屋顶' },
  ] });
  assert.equal(store.state().objects[0].members.length, 14);
  store = createVoxelWorldStore({ file });
  store.undo({ baseRevision: 2 });
  assert.equal(store.state().objects[0].members.length, 15);
  store.redo({ baseRevision: 3 });
  store.apply({ baseRevision: 4, commands: [{ op: 'paint-object', id: 'roof', material: 'roof' }] });
  assert.equal(store.state().cells.find(c => c.position.join() === '0,4,0').material, 'glass');
});

test('legacy bounds never masquerade as exact membership and invalid attribution is atomic', t => {
  const store = createVoxelWorldStore({ file: setup(t) });
  store.apply({ baseRevision: 0, commands: [roof] });
  const before = store.state();
  assert.throws(() => store.apply({ baseRevision: 1, commands: [{ op: 'paint-object', id: 'roof', material: 'roof' }] }), /归属/);
  assert.throws(() => store.apply({ baseRevision: 1, commands: [{ op: 'fill', from: [0, 0, 0], to: [0, 0, 0], material: 'wood', objectId: 'missing' }] }), /对象/);
  assert.throws(() => store.apply({ baseRevision: 1, commands: [{ op: 'fill', from: [0, 0, 0], to: [0, 0, 0], material: 'wood', objectId: 'roof' }] }), /范围/);
  assert.deepEqual(store.state(), before);
});
