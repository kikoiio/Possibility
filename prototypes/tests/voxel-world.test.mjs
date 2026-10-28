import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVoxelWorldStore } from '../voxel-world.mjs';

const fill = (material, from = [0, 0, 0], to = from) => ({ op: 'fill', from, to, material });
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'voxel-world-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'world.json');
}

test('transactions persist and undo/redo survive reopening', t => {
  const file = setup(t);
  let store = createVoxelWorldStore({ file });
  assert.deepEqual(store.state(), { revision: 0, cells: [], objects: [], canUndo: false, canRedo: false });
  assert.deepEqual(store.apply({ baseRevision: 0, commands: [fill('grass', [0, 0, 0], [1, 0, 0]), fill('glass', [1, 0, 0])] }), {
    revision: 1, cells: [{ position: [0, 0, 0], material: 'grass' }, { position: [1, 0, 0], material: 'glass' }], objects: [], canUndo: true, canRedo: false,
  });
  store = createVoxelWorldStore({ file });
  assert.equal(store.undo({ baseRevision: 1 }).revision, 2);
  assert.deepEqual(store.state().cells, []);
  store = createVoxelWorldStore({ file });
  assert.equal(store.redo({ baseRevision: 2 }).revision, 3);
  assert.equal(store.state().cells.length, 2);
  store.undo({ baseRevision: 3 });
  store.apply({ baseRevision: 4, commands: [fill('roof')] });
  assert.throws(() => store.redo({ baseRevision: 5 }), /没有可重做/);
});

test('invalid edits, stale revisions and no-op edits leave state and file unchanged', t => {
  const file = setup(t), store = createVoxelWorldStore({ file });
  store.apply({ baseRevision: 0, commands: [fill('wood')] });
  const before = store.state(), disk = readFileSync(file, 'utf8');
  assert.throws(() => store.apply({ baseRevision: 0, commands: [fill('stone')] }), /冲突/);
  assert.throws(() => store.undo({ baseRevision: 0 }), /冲突/);
  assert.throws(() => store.apply({ baseRevision: 1, commands: [fill('stone'), fill('invalid')] }), /未注册/);
  assert.deepEqual(store.apply({ baseRevision: 1, commands: [fill('wood')] }), before);
  assert.deepEqual(store.state(), before);
  assert.equal(readFileSync(file, 'utf8'), disk);
  before.cells[0].position[0] = 100;
  assert.equal(store.state().cells[0].position[0], 0);
});

test('failed file replacement does not commit in-memory state', t => {
  const dir = setup(t);
  mkdirSync(dir);
  const file = join(dir, 'missing', 'world.json');
  const store = createVoxelWorldStore({ file });
  assert.throws(() => store.apply({ baseRevision: 0, commands: [fill('stone'), object('failed')] }));
  assert.deepEqual(store.state(), { revision: 0, cells: [], objects: [], canUndo: false, canRedo: false });
});

test('remove and replace can be undone and redone', t => {
  const store = createVoxelWorldStore({ file: setup(t) });
  store.apply({ baseRevision: 0, commands: [fill('water', [0, 0, 0], [1, 0, 0])] });
  store.apply({ baseRevision: 1, commands: [{ op: 'replace', from: [0, 0, 0], to: [1, 0, 0], match: 'water', material: 'leaves' }, fill(null)] });
  assert.deepEqual(store.state().cells, [{ position: [1, 0, 0], material: 'leaves' }]);
  assert.equal(store.undo({ baseRevision: 2 }).cells.length, 2);
  assert.deepEqual(store.redo({ baseRevision: 3 }).cells, [{ position: [1, 0, 0], material: 'leaves' }]);
});


const object = (id, overrides = {}) => ({ op: 'object', id, name: '树屋', kind: 'building', from: [0, 0, 0], to: [2, 3, 2], ...overrides });

test('objects and blocks commit together and persist through update, removal, undo and redo', t => {
  const file = setup(t);
  let store = createVoxelWorldStore({ file });
  let state = store.apply({ baseRevision: 0, commands: [fill('wood'), object('house')] });
  assert.deepEqual(state.objects, [{ id: 'house', name: '树屋', kind: 'building', from: [0, 0, 0], to: [2, 3, 2] }]);
  assert.equal(state.canUndo, true); assert.equal(state.canRedo, false);
  state.objects[0].from[0] = 99;
  assert.equal(store.state().objects[0].from[0], 0);
  store = createVoxelWorldStore({ file });
  state = store.apply({ baseRevision: 1, commands: [fill(null), object('house', { name: '新树屋' })] });
  assert.equal(state.cells.length, 0); assert.equal(state.objects[0].name, '新树屋');
  state = store.apply({ baseRevision: 2, commands: [{ op: 'remove-object', id: 'house' }] });
  assert.deepEqual(state.objects, []);
  state = store.undo({ baseRevision: 3 });
  assert.equal(state.objects[0].name, '新树屋'); assert.equal(state.canRedo, true);
  store = createVoxelWorldStore({ file });
  state = store.undo({ baseRevision: 4 });
  assert.equal(state.cells.length, 1); assert.equal(state.objects[0].name, '树屋');
  state = store.undo({ baseRevision: 5 });
  assert.deepEqual(state.objects, []); assert.deepEqual(state.cells, []); assert.equal(state.canUndo, false);
  state = store.redo({ baseRevision: 6 });
  assert.equal(state.objects[0].name, '树屋'); assert.equal(state.cells.length, 1);
  store = createVoxelWorldStore({ file });
  state = store.redo({ baseRevision: 7 });
  assert.equal(state.objects[0].name, '新树屋'); assert.equal(state.cells.length, 0);
  state = store.redo({ baseRevision: 8 });
  assert.deepEqual(state.objects, []); assert.equal(state.canRedo, false);
});

test('object validation and mixed transaction failures leave file and state untouched', t => {
  const file = setup(t), store = createVoxelWorldStore({ file });
  store.apply({ baseRevision: 0, commands: [object('a')] });
  const before = store.state(), disk = readFileSync(file, 'utf8');
  for (const bad of [object('', {}), object('b', { name: '  ' }), object('b', { kind: 2 }),
    object('b', { from: [1, 0, 0], to: [0, 0, 0] }), object('b', { to: [1025, 0, 0] }),
    { op: 'remove-object', id: '\n' }]) {
    assert.throws(() => store.apply({ baseRevision: 1, commands: [fill('stone'), bad] }));
  }
  assert.throws(() => store.apply({ baseRevision: 1, commands: [object('b'), fill('invalid')] }));
  assert.deepEqual(store.apply({ baseRevision: 1, commands: [object('a'), { op: 'remove-object', id: 'missing' }] }), before);
  assert.deepEqual(store.state(), before); assert.equal(readFileSync(file, 'utf8'), disk);
});

test('5000 cell limit applies to the final transaction without truncation', t => {
  const file = setup(t), store = createVoxelWorldStore({ file });
  let state = store.apply({ baseRevision: 0, commands: [fill('stone', [0, 0, 0], [49, 9, 9]), object('a')] });
  assert.equal(state.cells.length, 5000);
  const disk = readFileSync(file, 'utf8');
  assert.throws(() => store.apply({ baseRevision: 1, commands: [object('b'), fill('wood', [50, 0, 0])] }), /5000/);
  assert.deepEqual(store.state(), state); assert.equal(readFileSync(file, 'utf8'), disk);
  state = store.apply({ baseRevision: 1, commands: [fill('wood', [50, 0, 0]), fill(null)] });
  assert.equal(state.cells.length, 5000);
  assert.ok(state.cells.some(c => c.position[0] === 50));
  assert.equal(store.undo({ baseRevision: 2 }).cells.length, 5000);
});

test('legacy files and cell-only history remain readable and undoable', t => {
  const file = setup(t);
  writeFileSync(file, JSON.stringify({ revision: 1, cells: [{ position: [0, 0, 0], material: 'wood' }],
    undo: [[{ position: [0, 0, 0], before: null, after: 'wood' }]], redo: [] }));
  let store = createVoxelWorldStore({ file });
  assert.equal(store.state().canUndo, true); assert.deepEqual(store.state().objects, []);
  assert.deepEqual(store.undo({ baseRevision: 1 }).cells, []);
  store = createVoxelWorldStore({ file });
  assert.equal(store.redo({ baseRevision: 2 }).cells.length, 1);
});

test('duplicate persisted object IDs are rejected', t => {
  const file = setup(t), o = { id: 'a', name: 'A', kind: 'tree', from: [0, 0, 0], to: [0, 0, 0] };
  writeFileSync(file, JSON.stringify({ revision: 0, cells: [], objects: [o, o], undo: [], redo: [] }));
  assert.throws(() => createVoxelWorldStore({ file }), /无效/);
});


test('new object edits clear redo while no-op edits preserve it', t => {
  const store = createVoxelWorldStore({ file: setup(t) });
  store.apply({ baseRevision: 0, commands: [object('a')] });
  let state = store.undo({ baseRevision: 1 });
  assert.equal(state.canUndo, false); assert.equal(state.canRedo, true);
  state = store.apply({ baseRevision: 2, commands: [{ op: 'remove-object', id: 'absent' }] });
  assert.equal(state.revision, 2); assert.equal(state.canRedo, true);
  state = store.apply({ baseRevision: 2, commands: [object('b')] });
  assert.equal(state.canUndo, true); assert.equal(state.canRedo, false);
});
