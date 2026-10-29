import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPrototypeExperience } from '../server.mjs';

const fill = { op: 'fill', from: [0, 0, 0], to: [2, 0, 0], material: 'wood' };
const building = { reply: '本次方案是一面木墙。', summary: '一面木墙作为起点。', ready: true, commands: [fill] };
const reply = value => Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: typeof value === 'string' ? value : JSON.stringify(value) }] }] });

function fixture(t, handler = () => building) {
  const base = resolve('.tmp/prototype');
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, 'creation-interruption-'));
  const file = join(directory, 'creation.json');
  const inputs = [];
  const options = {
    stateFile: join(directory, 'state.json'),
    configLoader: () => ({ llm: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic' } }),
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(JSON.parse(init.body).input.at(-1).content);
      inputs.push(input);
      return reply(await handler(input));
    },
  };
  let experience = null;
  const open = () => (experience = createPrototypeExperience(options));
  const close = () => {
    const current = experience;
    experience = null;
    current?.close();
  };
  t.after(() => {
    try { close(); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  });
  return { directory, file, inputs, open, close };
}

test('a damaged creation save survives startup and close byte-for-byte', async t => {
  const f = fixture(t);
  const built = await f.open().discussStep({ message: '搭木墙', mode: 'build' });
  assert.equal(built.ok, true);
  f.close();
  // Preserve the saved voxel content but remove the final JSON delimiter.
  const damaged = readFileSync(f.file, 'utf8').trimEnd().slice(0, -1);
  assert.throws(() => JSON.parse(damaged), SyntaxError);
  writeFileSync(f.file, damaged);
  try {
    try { f.open(); }
    catch (error) { assert.ok(error instanceof Error, 'startup may reject an unreadable save'); }
  } finally { f.close(); }
  assert.equal(readFileSync(f.file, 'utf8') === damaged, true,
    'startup/close must preserve the damaged creation.json bytes for recovery');
});

test('cancelling at commit with failed correction cannot leave committed plus an old snapshot on disk', async t => {
  const f = fixture(t);
  const experience = f.open();
  const durableFile = join(f.directory, 'last-durable-creation.json');
  let cancellation, blocked = false, result;
  try {
    result = await experience.discussStep({ message: '搭木墙', mode: 'build' }, {
      onProgress(progress) {
        if (progress.phase !== 'committing') return;
        cancellation = experience.cancelModel();
        // Preserve the last successful write, then force correction saves to fail
        // at rename, independently of root privileges and available disk space.
        renameSync(f.file, durableFile);
        mkdirSync(f.file);
        blocked = true;
      },
    });
  } finally {
    if (blocked) {
      rmSync(f.file, { recursive: true });
      renameSync(durableFile, f.file);
    }
  }
  assert.equal(blocked, true, 'the commit callback must inject the save failure');
  assert.equal(cancellation.ok, true);
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.attempt.outcome, 'cancelled');
  assert.equal(result.state.creation.voxel.revision, 0);
  assert.deepEqual(result.state.creation.voxel.cells, []);
  // Inspect before cleanup closes the instance and can persist a correction.
  const disk = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(disk.attempts.at(-1).id, result.attempt.id);
  assert.deepEqual(disk.voxelSnapshot.cells, []);
  assert.equal(disk.attempts.at(-1).outcome === 'committed' && disk.voxelSnapshot.revision === 0, false,
    'the durable attempt must not claim committed while its voxel snapshot is still revision 0');
});

test('an already cancelled complete-checkpoint recovery cannot publish a draft', async t => {
  const stages = {
    places: [
      { type: 'world', title: '海边灯室', description: '一个小起点。', weather: '海风', premise: '守灯人开始值班。', landscape: 'coast' },
      { type: 'place', id: 'lamp-room', name: '灯室', description: '值班的房间。', space: 'room', grid: [0, 0], landmark: 'none' },
    ],
    people: [{ type: 'actor', id: 'keeper', name: '守灯人', role: '值班者', goal: '维持灯光。', background: '在此值班。', location: 'lamp-room', fatigue: 0 }],
    rules: [],
  };
  const f = fixture(t, input => [...stages[input.step], { type: 'complete' }].map(record => JSON.stringify(record)).join('\n'));
  const description = '海边灯室。';
  let checkpoint;
  const generated = await f.open().worldStep({ description }, {
    onProgress(progress) {
      // This is the actual durable checkpoint after rules, before draft creation.
      if (progress.phase === 'verifying') checkpoint = readFileSync(f.file, 'utf8');
    },
  });
  assert.equal(generated.ok, true, 'the seed world must pass full validation');
  assert.equal(f.inputs.length, 3);
  const saved = JSON.parse(checkpoint);
  assert.deepEqual(saved.generation.completedStages, ['places', 'people', 'rules']);
  assert.equal(saved.generation.outcome, 'pending');
  assert.equal(saved.draft, null);
  f.close();
  writeFileSync(f.file, checkpoint);
  const recovered = f.open();
  assert.equal(recovered.state().creation.generation.outcome, 'failed');
  const controller = new AbortController();
  controller.abort();
  const result = await recovered.worldStep({ description, retryGenerationId: saved.generation.id }, { signal: controller.signal });
  assert.equal(f.inputs.length, 3, 'complete checkpoint recovery must not call the model again');
  assert.equal(result.state.creation.draft, null, 'a cancelled recovery must not offer a draft for acceptance');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'cancelled');
  assert.equal(result.state.creation.generation.outcome, 'cancelled');
});

test('cancelling during final verification cannot publish a generated draft', async t => {
  const { createGeneratedFixture } = await import('../world-definition.mjs');
  const f = fixture(t, () => createGeneratedFixture());
  const e = f.open();
  const result = await e.worldStep({description:'一处小观测站'}, {onProgress(progress) {
    if (progress.phase === 'verifying') e.cancelModel();
  }});
  assert.equal(result.ok,false);
  assert.equal(result.reason,'cancelled');
  assert.equal(result.state.creation.draft,null);
  assert.equal(JSON.parse(readFileSync(f.file,'utf8')).generation.outcome,'cancelled');
});
