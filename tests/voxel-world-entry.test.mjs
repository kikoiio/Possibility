import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPrototypeExperience } from '../server.mjs';
import { createGeneratedFixture } from '../world-definition.mjs';

test('a built voxel origin can enter, reload, archive, and reopen as the same world', async () => {
  const root = resolve('.tmp/prototype'); mkdirSync(root, { recursive: true });
  const dir = mkdtempSync(join(root, 'voxel-entry-'));
  const definition = createGeneratedFixture();
  let discussionTurns = 0;
  const options = {
    stateFile: join(dir, 'state.json'),
    configLoader: () => ({ llm: { baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'synthetic' } }),
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(JSON.parse(init.body).input.at(-1).content);
      if (input.conversation && !input.step) {
        discussionTurns++;
        return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({
          reply: discussionTurns === 1 ? '我先把起点搭出来。' : '起点已经足够清楚，可以生成世界。',
          summary: '一座带木屋的海边起点。', ready: discussionTurns >= 2,
          commands: discussionTurns === 1 ? [
            { op: 'walls', from: [0, 0, 0], to: [4, 3, 4], material: 'wood' },
            { op: 'object', id: 'observatory', name: '观测木屋', kind: 'building', from: [0, 0, 0], to: [4, 3, 4] },
          ] : [],
        }) }] }] });
      }
      return Response.json({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(definition) }] }] });
    },
  };
  let experience = createPrototypeExperience(options);
  try {
    assert.equal((await experience.discussStep({ message: '先建一座木屋。' })).ok, true);
    assert.equal((await experience.discussStep({ message: '木屋放在海边。' })).ok, true);
    const revision = experience.state().creation.dialogue.revision;
    const generated = await experience.worldStep({ conversationRevision: revision });
    assert.equal(generated.ok, true, generated.message);
    const draft = experience.state().creation.draft;
    assert.equal(draft.voxelBindings.anchors[0].id, 'observatory');
    assert.equal(experience.control({ type: 'world-accept', draftId: draft.id }).ok, true);
    const origin = experience.state();
    assert.equal(origin.creation.mode, 'world');
    assert.equal(origin.worldMinute, 0);
    assert.equal(origin.genesis.voxel.cells.length, 64);
    assert.equal(origin.genesis.voxelBindings.actors[0].placeId, 'observatory');

    experience.close();
    experience = createPrototypeExperience(options);
    const restored = experience.state();
    assert.equal(restored.creation.mode, 'world');
    assert.deepEqual(restored.genesis.voxel, origin.genesis.voxel);
    assert.deepEqual(restored.genesis.voxelBindings, origin.genesis.voxelBindings);

    experience.control({ type: 'creation-open' });
    const next = await experience.worldStep({ description: '另一座没有体素改动的世界' });
    assert.equal(next.ok, true);
    const nextDraft = experience.state().creation.draft;
    assert.equal(experience.control({ type: 'world-accept', draftId: nextDraft.id }).ok, true);
    const archiveId = experience.state().creation.worlds[0].id;
    const reopened = experience.control({ type: 'world-open', worldId: archiveId });
    assert.equal(reopened.ok, true);
    assert.deepEqual(reopened.state.genesis.voxel, origin.genesis.voxel);
    assert.deepEqual(reopened.state.genesis.voxelBindings, origin.genesis.voxelBindings);
  } finally {
    experience.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
