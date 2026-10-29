import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareVoxelEdit } from '../voxel-building.mjs';

const types = new Set(['wood', 'stone', 'glass']);
const at = p => p.join(',');

test('sequential operations produce a single reversible change per voxel', () => {
  const world = new Map([['0,0,0', 'stone']]);
  const changes = prepareVoxelEdit([
    { op: 'fill', from: [0, 0, 0], to: [1, 0, 0], material: 'wood' },
    { op: 'replace', from: [1, 0, 0], to: [1, 0, 0], match: 'wood', material: 'glass' },
  ], p => world.get(at(p)) ?? null, types);
  assert.deepEqual(changes, [
    { position: [0, 0, 0], before: 'stone', after: 'wood' },
    { position: [1, 0, 0], before: null, after: 'glass' },
  ]);
  assert.equal(world.get('0,0,0'), 'stone');
});

test('replace only affects matching cells and supports empty space', () => {
  const world = new Map([['0,0,0', 'stone']]);
  const changes = prepareVoxelEdit([{ op: 'replace', from: [0, 0, 0], to: [1, 0, 0], match: null, material: 'wood' }], p => world.get(at(p)) ?? null, types);
  assert.deepEqual(changes, [{ position: [1, 0, 0], before: null, after: 'wood' }]);
});

test('invalid batches and unavailable world data fail without writing', () => {
  let reads = 0;
  assert.throws(() => prepareVoxelEdit([{ op: 'fill', from: [0, 0, 0], to: [1024, 1024, 1024], material: 'wood' }], () => { reads++; return null; }, types), /范围过大/);
  assert.equal(reads, 0);
  assert.throws(() => prepareVoxelEdit([{ op: 'fill', from: [0, 0, 0], to: [0, 0, 0], material: 'unknown' }], () => null, types), /未注册/);
  assert.throws(() => prepareVoxelEdit([{ op: 'fill', from: [0, 0, 0], to: [0, 0, 0], material: 'wood' }], () => undefined, types), /无法读取/);
});
