import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoxelWorldStore } from '../voxel-world.mjs';
import { inspectVoxelSpaces } from '../geometry/voxel-inspection.js';

function house(extra = []) {
  const store = createVoxelWorldStore({ file: 'unused', onSave() {} });
  return store.apply({ baseRevision: 0, commands: [
    { op: 'fill', from: [-1, 0, -1], to: [5, 0, 5], material: 'grass' },
    { op: 'fill', from: [0, 0, 0], to: [4, 0, 4], material: 'wood', objectId: 'house' },
    { op: 'walls', from: [0, 1, 0], to: [4, 3, 4], material: 'wood', objectId: 'house' },
    { op: 'fill', from: [2, 1, 4], to: [2, 2, 4], material: null },
    { op: 'fill', from: [4, 2, 2], to: [4, 2, 2], material: 'glass', objectId: 'window' },
    { op: 'roof', from: [-1, 4, -1], to: [5, 7, 5], material: 'roof', objectId: 'roof' },
    { op: 'object', id: 'house', name: '木屋', kind: 'building', from: [0, 0, 0], to: [4, 7, 4] },
    { op: 'object', id: 'window', name: '侧窗', kind: 'window', from: [4, 2, 2], to: [4, 2, 2] },
    { op: 'object', id: 'roof', name: '屋顶', kind: 'roof', from: [-1, 4, -1], to: [5, 7, 5] },
    ...extra,
  ] });
}

test('single-level checks find actual headroom, an outside route, embedded glass and roof coverage', () => {
  const report = inspectVoxelSpaces(house());
  assert.deepEqual(report.issues, []);
  assert.equal(report.buildings[0].walkableCells, 9);
  assert.equal(report.buildings[0].entrances, 1);
});

test('solid interiors, sealed doors, missing roof, floating windows and intersecting water are diagnosed', () => {
  const fill = (from, to, material) => ({ op: 'fill', from, to, material });
  const cases = [
    [fill([1, 1, 1], [3, 3, 3], 'wood'), 'no-headroom'],
    [fill([2, 1, 4], [2, 2, 4], 'wood'), 'no-entrance'],
    [fill([-1, 4, -1], [5, 7, 5], null), 'roof-gap'],
    [{ op: 'object', id: 'floating', name: '悬空窗', kind: 'window', from: [2, 2, 2], to: [2, 2, 2] }, 'window-unverified'],
    [fill([1, 1, 1], [1, 1, 1], 'water'), 'water-inside'],
    [fill([0, 3, 0], [0, 3, 4], null), 'wall-gap'],
  ];
  for (const [edit, code] of cases) assert(inspectVoxelSpaces(house([edit])).issues.some(i => i.code === code), code);
});

test('inspection remains bounded and reports unsupported shapes instead of claiming a pass', () => {
  const report = inspectVoxelSpaces({ cells: [], objects: [
    { id: 'large', name: '大屋', kind: 'building', from: [-1024, 0, -1024], to: [1024, 1024, 1024] },
  ] });
  assert.equal(report.issues[0].code, 'unsupported-building');
  assert.equal(report.buildings.length, 0);
});
