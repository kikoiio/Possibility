import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPrototypeExperience } from '../server.mjs';
import { projectVoxelActors } from '../voxel-bindings.mjs';
import { createGeneratedFixture } from '../world-definition.mjs';

const base = resolve('.tmp/prototype');
const fill = { op: 'fill', from: [0, 0, 0], to: [2, 0, 0], material: 'wood' };
const output = (commands, extra = {}) => ({ reply: '已经全部建好了。', summary: '作者要的一小片木屋起点。', ready: true, commands, ...extra });
const reply = value => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
function fixture(t, handler) {
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'creation-recovery-'));
  const inputs = [];
  const options = { stateFile: join(directory, 'state.json'), configLoader: () => ({ llm: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic' } }),
    fetchImpl: async (_url, init) => { const input = JSON.parse(JSON.parse(init.body).input.at(-1).content); inputs.push(input); return reply(await handler(input, inputs.length, directory)); } };
  let experience = createPrototypeExperience(options);
  t.after(() => { experience.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, inputs, get experience() { return experience; }, reload() { experience.close(); experience = createPrototypeExperience(options); return experience; } };
}

test('build results distinguish text-only, committed and identical operations using real revisions', async t => {
  const f = fixture(t, (_input, n) => output(n === 1 ? [] : [fill]));
  const noCommands = await f.experience.discussStep({ message: '现在搭木墙', mode: 'build' });
  assert.equal(noCommands.ok, false);
  assert.equal(noCommands.reason, 'no-building-commands');
  assert.equal(noCommands.attempt.outcome, 'not-built');
  assert.equal(noCommands.state.creation.voxel.revision, 0);
  const built = await f.experience.discussStep({ message: '现在搭木墙', mode: 'build' });
  assert.equal(built.ok, true);
  assert.equal(built.attempt.outcome, 'committed');
  assert.equal(built.attempt.fromRevision, 0);
  assert.equal(built.attempt.toRevision, built.state.creation.voxel.revision);
  assert.equal(built.attempt.changes.cells, 3);
  assert.equal(built.state.creation.dialogue.ready, true);
  const unchanged = await f.experience.discussStep({ message: '同样的木墙', mode: 'build' });
  assert.equal(unchanged.ok, true);
  assert.equal(unchanged.attempt.outcome, 'unchanged');
  assert.equal(unchanged.state.creation.voxel.revision, 1);
  assert.equal(unchanged.attempt.changes.cells, 0);
  assert.equal(unchanged.state.creation.attempts.length, 3);
  assert.deepEqual(f.reload().state().creation.attempts.at(-1), unchanged.attempt);
});

test('discussion mode cannot build even when a model returns commands', async t => {
  const f = fixture(t, () => output([fill]));
  const r = await f.experience.discussStep({ message: '先讨论木墙怎么搭', mode: 'discuss' });
  assert.equal(r.state.creation.voxel.cells.length, 0);
  assert.equal(r.attempt.outcome, 'discussion');
  assert.match(r.attempt.message, /讨论/);
});

test('air is deterministically empty space rather than an invented material', async t => {
  const f = fixture(t, (_input, n) => output([{ ...fill, material: n === 1 ? 'wood' : 'air' }]));
  await f.experience.discussStep({ message: '木墙', mode: 'build' });
  const cleared = await f.experience.discussStep({ message: '清空这面墙', mode: 'build' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.attempt.changes.removed, 3);
  assert.deepEqual(cleared.state.creation.voxel.cells, []);
  assert.match(cleared.attempt.adjustments[0].message, /air/);
});

test('the literal null string clears cells and replace matches without guessing materials', async t => {
  const f = fixture(t, (_input, n) => output(n === 1 ? [fill] : n === 2
    ? [{ ...fill, material: ' null ' }]
    : [{ ...fill, op: 'replace', match: 'null', material: 'glass' }]));
  await f.experience.discussStep({ message: '木墙', mode: 'build' });
  const cleared = await f.experience.discussStep({ message: '清空木墙', mode: 'build' });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.attempt.changes.removed, 3);
  assert.match(cleared.attempt.adjustments[0].message, /null/);
  const replaced = await f.experience.discussStep({ message: '空格放玻璃', mode: 'build' });
  assert.equal(replaced.ok, true);
  assert.equal(replaced.state.creation.voxel.cells.length, 3);
});

test('a material failure remains in the conversation and explicit retry reuses the intent against the latest scene', async t => {
  const f = fixture(t, (_input, n) => output([{ ...fill, material: n === 1 ? 'copper' : 'wood' }]));
  const failed = await f.experience.discussStep({ message: '给木屋加窗', mode: 'build' });
  assert.equal(failed.reason, 'invalid-building');
  assert.equal(failed.state.creation.dialogue.messages.at(-1).attemptId, failed.attempt.id);
  assert.match(failed.attempt.diagnostics[0].path, /commands\[0\].material/);
  assert.match(failed.attempt.diagnostics[0].message, /copper/);
  const originalUserId = failed.attempt.userMessageId;
  const reloaded = f.reload();
  assert.equal(f.inputs.length, 1, 'restart must not retry');
  const retried = await reloaded.discussStep({ retryAttemptId: failed.attempt.id });
  assert.equal(retried.ok, true);
  assert.equal(retried.attempt.userMessageId, originalUserId);
  assert.equal(retried.attempt.retryOf, failed.attempt.id);
  assert.equal(retried.state.creation.dialogue.messages.filter(m => m.role === 'user').length, 1);
  assert.equal(f.inputs[1].previousAttempt.reason, 'invalid-building');
  assert.equal(f.inputs[1].voxel.revision, 0);
  assert.equal((await reloaded.discussStep({ retryAttemptId: failed.attempt.id })).reason, 'stale-attempt');
  assert.equal(f.inputs.length, 2);
});

test('retry after undo observes the current basis rather than replaying old model commands', async t => {
  const f = fixture(t, (_input, n) => output([{ ...fill, material: n === 2 ? 'copper' : 'wood' }]));
  await f.experience.discussStep({ message: '木墙', mode: 'build' });
  const failed = await f.experience.discussStep({ message: '加窗', mode: 'build' });
  f.experience.control({ type: 'voxel-undo', baseRevision: 1 });
  const r = await f.experience.discussStep({ retryAttemptId: failed.attempt.id });
  assert.equal(r.ok, true);
  assert.equal(f.inputs[2].voxel.revision, 2);
  assert.deepEqual(f.inputs[2].voxel.cells, []);
});

test('unordered box corners are normalized; ambiguous roof heights and unknown materials fail atomically', async t => {
  const f = fixture(t, (_input, n) => output(n === 1 ? [{ ...fill, from: [2, 0, 0], to: [0, 0, 0] }]
    : [fill, { op: 'roof', from: [0, 5, 0], to: [4, 2, 4], material: 'wood' }]));
  const r = await f.experience.discussStep({ message: '搭墙', mode: 'build' });
  assert.equal(r.ok, true);
  assert.equal(r.state.creation.voxel.cells.length, 3);
  assert(r.attempt.adjustments.length);
  const failed = await f.experience.discussStep({ message: '搭屋顶', mode: 'build' });
  assert.equal(failed.ok, false);
  assert.equal(failed.state.creation.voxel.revision, r.state.creation.voxel.revision);
  assert.deepEqual(failed.state.creation.voxel.cells, r.state.creation.voxel.cells);
});

test('invalid reply and cancellation retain a recoverable attempt without creating blocks', async t => {
  const f = fixture(t, () => ({ nonsense: true }));
  const failed = await f.experience.discussStep({ message: '搭屋', mode: 'build' });
  assert.equal(failed.reason, 'invalid-discussion');
  assert.equal(failed.state.creation.attempts.at(-1).outcome, 'failed');
  assert.equal(failed.state.creation.dialogue.messages.at(-1).attemptId, failed.attempt.id);
  const controller = new AbortController(); controller.abort();
  const cancelled = await f.experience.discussStep({ retryAttemptId: failed.attempt.id }, { signal: controller.signal });
  assert.equal(cancelled.reason, 'cancelled');
  assert.equal(cancelled.attempt.outcome, 'cancelled');
  assert.equal(cancelled.state.creation.voxel.revision, 0);
  assert.equal(f.inputs.length, 1);
});

test('failed atomic save cannot report or expose a built scene; recovery preserves the intent', async t => {
  const f = fixture(t, (_input, _n, dir) => {
    renameSync(join(dir, 'creation.json'), join(dir, 'creation.backup'));
    mkdirSync(join(dir, 'creation.json'));
    return output([fill]);
  });
  const r = await f.experience.discussStep({ message: '搭墙', mode: 'build' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'save-error');
  assert.equal(r.state.creation.voxel.revision, 0);
  assert.deepEqual(r.state.creation.voxel.cells, []);
  assert.equal(r.state.creation.dialogue.messages[0].text, '搭墙');
  rmSync(join(f.directory, 'creation.json'), { recursive: true });
  renameSync(join(f.directory, 'creation.backup'), join(f.directory, 'creation.json'));
  const recovered = f.reload();
  assert.equal(recovered.state().creation.attempts.at(-1).outcome, 'failed');
  assert.equal(f.inputs.length, 1);
});

test('attempt timing records real calls and validation without inventing first-token measurements', async t => {
  const f = fixture(t, () => output([fill]));
  const r = await f.experience.discussStep({ message: '搭墙', mode: 'build' });
  assert.equal(r.attempt.timings.calls.length, 1);
  assert.equal(r.attempt.timings.calls[0].firstTextMs, null, 'non-stream fixture has no observed first token');
  for (const key of ['totalMs', 'modelMs', 'validationMs', 'commitMs']) assert(r.attempt.timings[key] >= 0, key);
  const disk = JSON.parse(readFileSync(join(f.directory, 'creation.json'), 'utf8'));
  assert.equal(disk.pending, false);
  assert.equal(disk.attempts.at(-1).outcome, 'committed');
});

test('stale client requests do not start a model call and cancelling at commit cannot change the scene', async t => {
  const f = fixture(t, () => output([fill]));
  const stale = await f.experience.discussStep({ message: '木墙', baseVoxelRevision: 7 });
  assert.equal(stale.reason, 'stale-basis'); assert.equal(f.inputs.length, 0);
  const r = await f.experience.discussStep({ message: '木墙', mode: 'build' }, { onProgress(p) { if (p.phase === 'committing') f.experience.cancelModel(); } });
  assert.equal(r.reason, 'cancelled'); assert.equal(r.attempt.outcome, 'cancelled');
  assert.deepEqual(r.state.creation.voxel.cells, []);
  assert.equal(f.reload().state().creation.voxel.revision, 0);
});

test('voxel people use observed locations with exact semantic matches and real headroom', () => {
  const cells = [0, 1, 2].flatMap(x => [0, 1, 2].map(z => ({ position: [x, 0, z], material: 'wood' })));
  const voxel = { cells, objects: [{ id: 'room', name: '木屋', kind: 'building', from: [0, 0, 0], to: [2, 3, 2] }] };
  const world = { places: [{ id: 'room', name: '木屋' }, { id: 'other', name: '未建造地点' }], actors: [{ id: 'old-man', name: '老人', location: 'room' }] };
  assert.deepEqual(projectVoxelActors({ world, voxel })[0].position, [1.5, 1, 1.5]);
  world.actors[0].location = 'other';
  assert.deepEqual(projectVoxelActors({ world, voxel }), [], 'unmatched places cannot invent a position');
  world.actors[0].location = 'room';
  for (let x = 0; x <= 2; x++) for (let z = 0; z <= 2; z++) cells.push({ position: [x, 1, z], material: 'wood' }, { position: [x, 2, z], material: 'wood' });
  assert.deepEqual(projectVoxelActors({ world, voxel }), [], 'solid spaces cannot contain a visible person');
});

test('an unsaved generated origin is not offered for confirmation', async t => {
  const f = fixture(t, (_input, _n, dir) => {
    renameSync(join(dir, 'creation.json'), join(dir, 'creation.backup'));
    mkdirSync(join(dir, 'creation.json'));
    return createGeneratedFixture();
  });
  let r;
  try { r = await f.experience.worldStep({ description: '小型观测站' }); }
  finally {
    rmSync(join(f.directory, 'creation.json'), { recursive: true });
    renameSync(join(f.directory, 'creation.backup'), join(f.directory, 'creation.json'));
  }
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'save-error');
  assert.equal(r.state.creation.draft, null);
  assert.equal(r.state.model.pending, false);
});
