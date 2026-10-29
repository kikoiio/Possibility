import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPrototypeExperience } from '../server.mjs';

test('conversation edits persist, undo and reject invalid model operations', async t => {
  const root = resolve('.tmp/prototype'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'voxel-dialogue-'));
  const inputs = [];
  const options = { stateFile: join(dir, 'state.json'), configLoader: () => ({ llm: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic' } }), fetchImpl: async (_url, init) => {
    const input = JSON.parse(JSON.parse(init.body).input.at(-1).content); inputs.push(input);
    const commands = inputs.length === 1 ? [{ op: 'fill', from: [0, 0, 0], to: [1, 0, 0], material: 'wood' }]
      : [{ op: 'fill', from: [0, 0, 0], to: [1, 0, 0], material: 'invalid' }];
    return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ reply: '已建好', summary: '木屋', ready: false, commands }) }] }] });
  } };
  let experience = createPrototypeExperience(options);
  t.after(() => { experience.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = await experience.discussStep({ message: '请先建木墙' });
  assert.equal(first.ok, true); assert.equal(first.state.creation.voxel.cells.length, 2);
  assert.equal(inputs[0].voxel.revision, 0);
  experience.close(); experience = createPrototypeExperience(options);
  assert.equal(experience.state().creation.voxel.cells.length, 2);
  const rejected = await experience.discussStep({ message: '换一种材料' });
  assert.equal(rejected.reason, 'invalid-building'); assert.equal(rejected.state.model.pending, false);
  assert.equal(rejected.state.creation.voxel.cells.length, 2);
  assert.equal(rejected.state.creation.dialogue.messages.at(-1).role, 'assistant');
  const revision = experience.state().creation.voxel.revision;
  assert.equal(experience.control({ type: 'voxel-undo', baseRevision: revision }).state.creation.voxel.cells.length, 0);
  assert.equal(experience.control({ type: 'voxel-redo', baseRevision: revision }).ok, false);
  assert.equal(experience.control({ type: 'voxel-redo', baseRevision: revision + 1 }).state.creation.voxel.cells.length, 2);
  experience.close();
  // Legacy saves still require their external file; new saves embed the snapshot.
  const legacy = JSON.parse(readFileSync(join(dir, 'creation.json'), 'utf8'));
  delete legacy.voxelSnapshot;
  writeFileSync(join(dir, 'creation.json'), JSON.stringify(legacy));
  experience = createPrototypeExperience(options);
  assert.match(experience.state().creation.voxel.error, /缺失或损坏/);
  assert.equal((await experience.discussStep({ message: '继续建造' })).reason, 'voxel-recovery');
  experience.close(); experience = createPrototypeExperience(options);
  assert.match(experience.state().creation.voxel.error, /缺失或损坏/);
});
