// Explicit live observation using a public seed in an isolated save. Each command
// performs only the requested step; no automatic retry or fixture substitution.
import { createPrototypeExperience } from '../server.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const [operation, ...words] = process.argv.slice(2);
const directory = resolve('.tmp/prototype/conversation-live'); mkdirSync(directory, { recursive: true });
const experience = createPrototypeExperience({ stateFile: join(directory, 'state.json') });
let lastProgress = 0;
const onProgress = p => {
  if (performance.now() - lastProgress > 12000 || p.phase === 'verifying') {
    lastProgress = performance.now();
    console.log(JSON.stringify({ phase: p.phase, seconds: Math.round(p.elapsedMs / 1000), characters: p.outputCharacters }));
  }
};
try {
  let result;
  if (operation === 'chat') result = await experience.discussStep({ message: words.join(' ') }, { onProgress });
  else if (operation === 'generate') result = await experience.worldStep({ conversationRevision: experience.state().creation.dialogue.revision }, { onProgress });
  else if (operation === 'confirm') result = experience.control({ type: 'world-accept', draftId: experience.state().creation.draft?.id });
  else if (operation === 'step') result = await experience.actorStep(words[0] ? { actorId: words[0] } : {}, { onProgress });
  else if (operation === 'retry') result = experience.control({ type: 'actor-retry' });
  else if (operation !== 'inspect') throw Error('Use chat <public text>, generate, confirm, step [actor], retry, or inspect.');
  const state = experience.state();
  const proof = { observedAt: new Date().toISOString(), operation, result: result ? { ok: result.ok, reason: result.reason, message: result.message, diagnostics: result.diagnostics } : null,
    dialogue: state.creation.dialogue, draft: state.creation.draft, world: state.world, worldMinute: state.worldMinute,
    activity: state.activity ?? [], actors: state.actors, modelPending: state.model.pending };
  writeFileSync(join(directory, 'proof.json'), JSON.stringify(proof, null, 2)+'\n', { mode: 0o600 });
  console.log(JSON.stringify({ ...proof, draft: proof.draft ? { id: proof.draft.id, title: proof.draft.definition.world.title, places: proof.draft.definition.world.places.length, actors: proof.draft.definition.world.actors.length, processes: proof.draft.definition.world.processes.length } : null,
    world: proof.world ? { title: proof.world.title, resources: proof.world.resources, processes: proof.world.processes, actions: proof.world.actions } : null,
    actors: Object.fromEntries(Object.entries(proof.actors).map(([id, actor]) => [id, actor.lastDecision?.decision?.action ?? null])) }, null, 2));
  if (result?.ok === false) process.exitCode = 1;
} finally { experience.close(); }
