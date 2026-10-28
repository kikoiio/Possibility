import test from 'node:test';
import assert from 'node:assert/strict';
import { expandVoxelTools } from '../voxel-tools.mjs';

const shape = (op, from, to) => ({ op, from, to, material: 'wood' });
function cells(commands) {
  const seen = new Set();
  for (const c of commands) {
    assert.equal(c.op, 'fill');
    for (let x = c.from[0]; x <= c.to[0]; x++) for (let y = c.from[1]; y <= c.to[1]; y++) for (let z = c.from[2]; z <= c.to[2]; z++) {
      const key = `${x},${y},${z}`;
      assert(!seen.has(key), `overlapping cell ${key}`);
      seen.add(key);
    }
  }
  return seen;
}

test('walls cover only four vertical faces, including degenerate dimensions', () => {
  for (const [x1, y1, z1] of [[4, 2, 3], [0, 2, 3], [4, 0, 0], [0, 0, 0]]) {
    const actual = cells(expandVoxelTools([shape('walls', [0, 0, 0], [x1, y1, z1])]));
    const expected = new Set();
    for (let x = 0; x <= x1; x++) for (let y = 0; y <= y1; y++) for (let z = 0; z <= z1; z++) {
      if (x === 0 || x === x1 || z === 0 || z === z1) expected.add(`${x},${y},${z}`);
    }
    assert.deepEqual(actual, expected);
  }
});

test('hollow is the complete shell, including thin boxes', () => {
  for (const [x1, y1, z1] of [[3, 3, 3], [3, 0, 3], [1, 3, 3], [3, 3, 1]]) {
    const actual = cells(expandVoxelTools([shape('hollow', [0, 0, 0], [x1, y1, z1])]));
    const expected = new Set();
    for (let x = 0; x <= x1; x++) for (let y = 0; y <= y1; y++) for (let z = 0; z <= z1; z++) {
      if (x === 0 || x === x1 || y === 0 || y === y1 || z === 0 || z === z1) expected.add(`${x},${y},${z}`);
    }
    assert.deepEqual(actual, expected);
  }
});

test('roof is symmetric along x, capped at to.y, and extends along z', () => {
  for (const [width, cap, heights] of [[5, 9, [0, 1, 2, 1, 0]], [6, 9, [0, 1, 2, 2, 1, 0]], [7, 1, [0, 1, 1, 1, 1, 1, 0]], [3, 0, [0, 0, 0]], [1, 9, [0]]]) {
    const result = expandVoxelTools([shape('roof', [-2, 4, -1], [-2 + width - 1, 4 + cap, 1])]);
    assert.deepEqual(result.map(c => c.from[1] - 4), heights);
    assert(result.every(c => c.from[2] === -1 && c.to[2] === 1 && c.from[1] === c.to[1]));
    assert.equal(cells(result).size, width * 3);
  }
});

test('passes base commands through unchanged and in order', () => {
  const commands = [shape('fill', [-1024, 0, 0], [-1024, 0, 0]), { ...shape('replace', [0, 0, 0], [0, 0, 0]), match: null },
    { op: 'object', id: 'a', name: 'A', kind: 'building', from: [0, 0, 0], to: [1, 1, 1] }, { op: 'remove-object', id: 'a' }];
  const result = expandVoxelTools(commands);
  assert.deepEqual(result, commands);
  result.forEach((c, i) => assert.strictEqual(c, commands[i]));
});

test('rejects invalid inputs, coordinates, materials and copy', () => {
  for (const input of [null, [], [null], [{ op: 'unknown' }], [{ op: 'copy', from: [0, 0, 0], to: [1, 1, 1], offset: [1, 0, 0] }],
    [shape('walls', [-1025, 0, 0], [0, 0, 0])], [shape('roof', [0, 0.5, 0], [1, 1, 1])],
    [shape('hollow', [2, 0, 0], [1, 1, 1])], [{ ...shape('walls', [0, 0, 0], [1, 1, 1]), material: undefined }],
    [{ ...shape('replace', [0, 0, 0], [0, 0, 0]), match: undefined }], [{ op: 'remove-object', id: '' }]]) {
    assert.throws(() => expandVoxelTools(input));
  }
});

test('bounds input, expanded count and combined scan including passthrough', () => {
  const unit = shape('fill', [0, 0, 0], [0, 0, 0]);
  assert.equal(expandVoxelTools(Array(128).fill(unit)).length, 128);
  assert.throws(() => expandVoxelTools(Array(129).fill(unit)), /无效/);
  assert.throws(() => expandVoxelTools([shape('roof', [0, 0, 0], [128, 1, 0])]), /数量/);
  assert.equal(expandVoxelTools([shape('fill', [0, 0, 0], [31, 31, 31])]).length, 1);
  assert.throws(() => expandVoxelTools([shape('fill', [0, 0, 0], [31, 31, 31]), unit]), /扫描/);
  assert.throws(() => expandVoxelTools([shape('walls', [-1024, -1024, -1024], [1024, 1024, 1024])]), /扫描/);
});
