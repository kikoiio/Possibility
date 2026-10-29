import test from 'node:test';
import assert from 'node:assert/strict';
import { CampSimulation } from '../core.mjs';
import { observeResident, verifyDecision, createLedgers, buildResidentMessages } from '../actor.mjs';
import { validateGeneratedWorld, validateWorldDefinition, observeGeneratedResident } from '../world-definition.mjs';
import { auditCandidatePrivacy, checkWorldCandidate } from '../world-genesis.mjs';
import { createRedHeadedLeagueDefinition } from '../fixtures/red-headed-league.mjs';
import { createPlainMaterials } from '../geometry/materials.js';
import { compileScene, disposeWorld } from '../geometry/scene-compiler.js';
import { buildSolid } from '../geometry/solid.js';

const definition = createRedHeadedLeagueDefinition();
const actor = (sim, id) => observeResident(sim.snapshot(), id);
const act = (sim, id, action) => sim.act(action, { actorId: id, source: 'resident', decisionId: `${id}-test` });

test('red-headed-league fixture validates and keeps source opening open ended', () => {
  assert.deepEqual(validateWorldDefinition(definition), []);
  assert.equal(definition.world.story.conversations.length, 0);
  assert.equal(definition.world.actors.length, 3);
});

test('victorian scene compiles a readable district vocabulary from the shared document', () => {
  const materials = createPlainMaterials();
  const source = buildSolid(materials, false, true, false, definition.scene, {
    parts: ['terrain', 'room:space-pawnshop', 'room:space-basement', 'room:space-bank'],
  });
  const compiled = compileScene(definition.scene, 'solid', { materials, details: true });
  try {
    const sourceNames = [];
    source.traverse(node => sourceNames.push(node.name));
    assert.ok(sourceNames.includes('paved-district'));
    assert.ok(sourceNames.includes('pawnshop-sign'));
    assert.ok(sourceNames.includes('tunnel-mouth'));
    assert.ok(sourceNames.includes('bank-column'));
    assert.ok(sourceNames.includes('front-street'));
    assert.ok(sourceNames.some(name => name.startsWith('street-lamp-')));
    assert.deepEqual(Object.keys(compiled.userData.parts).sort(), [
      'character:clay', 'character:holmes', 'character:wilson',
      'bridge', 'interior', 'library', 'nature', 'porch', 'room:space-bank',
      'room:space-basement', 'room:space-pawnshop', 'terrain',
    ].sort());
  } finally {
    disposeWorld(source);
    disposeWorld(compiled);
    Object.values(materials).forEach(material => material.dispose());
  }
});

test('origin privacy audit accepts the fixture and rejects a private phrase copied into public premise', () => {
  const checked = checkWorldCandidate(definition);
  assert.equal(checked.ok, true);
  assert.equal(checked.privacyAudit.ok, true);
  assert.ok(checked.privacyAudit.limitations.length >= 2);
  const leaked = structuredClone(definition);
  leaked.world.story.premise += ' 地下计划正在推进。';
  const rejected = checkWorldCandidate(leaked);
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'privacy-audit-failed');
  assert.ok(rejected.diagnostics.some((error) => error.code === 'privacy-leak'));
  assert.equal(auditCandidatePrivacy(leaked).ok, false);
});

test('visibility and performer references are strict data, not executable rules', () => {
  const world = structuredClone(definition.world);
  world.resources[0].visibility.actors = ['missing'];
  world.actions[0].performers = ['missing'];
  world.actions[1].visibility = { actors: [], clues: [] };
  world.actions[1].script = 'eval()';
  const errors = validateGeneratedWorld(world);
  assert.ok(errors.some((error) => error.code === 'reference' && error.path.includes('visibility.actors')));
  assert.ok(errors.some((error) => error.code === 'reference' && error.path.includes('performers')));
  assert.ok(errors.some((error) => error.code === 'visibility-target'));
  assert.ok(errors.some((error) => error.code === 'unknown-field' && error.path.endsWith('.script')));
});

test('secret resources and actions are actor-scoped without hiding the physical place', () => {
  const sim = new CampSimulation({ world: definition.world });
  const wilson = actor(sim, 'wilson');
  const clay = actor(sim, 'clay');
  assert.equal(wilson.places.some((place) => place.id === 'basement'), true);
  assert.equal(wilson.resources.some((resource) => resource.id === 'tunnel-progress'), false);
  assert.equal(wilson.availableActions.some((action) => action.id === 'dig-tunnel'), false);
  assert.equal(clay.resources.some((resource) => resource.id === 'tunnel-progress'), true);
  assert.equal(clay.resources.some((resource) => resource.id === 'spade'), true);
  assert.equal(clay.availableActions.some((action) => action.id === 'dig-tunnel'), true);
  assert.equal(act(sim, 'clay', { type: 'perform', actionId: 'dig-tunnel' }).ok, true);
  assert.equal(sim.snapshot().world.resources.find((resource) => resource.id === 'tunnel-progress').quantity, 1);
});

test('checking a clue grants knowledge while performer authorization stays separate', () => {
  const sim = new CampSimulation({ world: definition.world });
  assert.equal(act(sim, 'wilson', { type: 'moveTo', location: 'basement' }).ok, true);
  let wilson = actor(sim, 'wilson');
  assert.equal(wilson.story.visibleClues.some((clue) => clue.id === 'mud-on-floor'), true);
  assert.equal(wilson.resources.some((resource) => resource.id === 'tunnel-progress'), false);
  assert.equal(wilson.availableActions.some((action) => action.id === 'dig-tunnel'), false);
  assert.equal(act(sim, 'wilson', { type: 'inspect', clueId: 'mud-on-floor' }).ok, true);
  wilson = actor(sim, 'wilson');
  assert.equal(wilson.story.knownClues.some((clue) => clue.id === 'mud-on-floor'), true);
  assert.equal(wilson.resources.some((resource) => resource.id === 'tunnel-progress'), true);
  assert.equal(wilson.availableActions.some((action) => action.id === 'dig-tunnel'), false);
  const before = sim.snapshot();
  const rejected = act(sim, 'wilson', { type: 'perform', actionId: 'dig-tunnel' });
  assert.equal(rejected.reason, 'action-unavailable');
  assert.equal(rejected.message.includes('挖掘工具'), false);
  assert.deepEqual(sim.snapshot(), before);
});

test('hidden action attempts and hidden dependencies do not leak through resident observations or decisions', () => {
  const sim = new CampSimulation({ world: definition.world });
  const wilson = actor(sim, 'wilson');
  const proposal = { observationMinute: wilson.worldMinute, action: { type: 'perform', actionId: 'dig-tunnel' }, reason: '我想试试。', memory: '我还不知道这里有什么。' };
  assert.equal(verifyDecision(proposal, wilson).ok, false);
  assert.equal(JSON.stringify(buildResidentMessages(sim.snapshot(), 'wilson', createLedgers(sim.snapshot().world), { initialMemories: definition.initialMemories })).includes('挖掘工具'), false);
});

test('author prose cannot smuggle hidden premise or place descriptions into resident input', () => {
  const world = structuredClone(definition.world);
  world.story.premise = 'SECRET: Spaulding is tunneling under the bank.';
  world.places.find((place) => place.id === 'basement').description = 'SECRET: the tunnel is already open.';
  const sim = new CampSimulation({ world });
  const text = JSON.stringify(observeResident(sim.snapshot(), 'wilson'));
  assert.equal(text.includes('SECRET'), false);
  assert.equal(text.includes('tunneling'), false);
  assert.equal(text.includes('已经打开'), false);
});

test('secret progress can trigger an independent cross-location consequence', () => {
  const sim = new CampSimulation({ world: definition.world });
  for (let i = 0; i < 4; i++) assert.equal(act(sim, 'clay', { type: 'perform', actionId: 'dig-tunnel' }).ok, true);
  sim.advanceWorld(1);
  assert.equal(sim.snapshot().world.resources.find((resource) => resource.id === 'bank-alert').quantity, 1);
  const holmes = actor(sim, 'holmes');
  assert.equal(holmes.resources.find((resource) => resource.id === 'bank-alert').quantity, 1);
  assert.equal(holmes.availableActions.some((action) => action.id === 'raise-alarm'), true);
  assert.equal(act(sim, 'holmes', { type: 'perform', actionId: 'raise-alarm' }).ok, true);
  assert.equal(sim.snapshot().world.resources.find((resource) => resource.id === 'bank-guard').quantity, 1);
});

test('counterfactual branches preserve the same origin and expose different consequences', () => {
  const origin = new CampSimulation({ world: definition.world });
  const attendance = origin.copy();
  assert.equal(act(attendance, 'wilson', { type: 'perform', actionId: 'attend-red-haired-office' }).ok, true);
  assert.equal(attendance.snapshot().world.resources.find((resource) => resource.id === 'league-attendance').quantity, 1);
  assert.equal(actor(attendance, 'holmes').resources.some((resource) => resource.id === 'league-attendance'), false);

  const clue = origin.copy();
  assert.equal(act(clue, 'holmes', { type: 'moveTo', location: 'pawnshop' }).ok, true);
  assert.equal(act(clue, 'holmes', { type: 'moveTo', location: 'basement' }).ok, true);
  assert.equal(act(clue, 'holmes', { type: 'inspect', clueId: 'mud-on-floor' }).ok, true);
  const holmesAfterClue = actor(clue, 'holmes');
  assert.equal(holmesAfterClue.resources.some((resource) => resource.id === 'tunnel-progress'), true);
  assert.equal(holmesAfterClue.availableActions.some((action) => action.id === 'dig-tunnel'), false);

  const digging = origin.copy();
  for (let i = 0; i < 4; i++) assert.equal(act(digging, 'clay', { type: 'perform', actionId: 'dig-tunnel' }).ok, true);
  digging.advanceWorld(1);
  assert.equal(digging.snapshot().world.resources.find((resource) => resource.id === 'tunnel-progress').quantity, 4);
  assert.equal(digging.snapshot().world.resources.find((resource) => resource.id === 'bank-alert').quantity, 1);

  assert.equal(origin.snapshot().revision, 0);
  assert.equal(origin.snapshot().world.resources.find((resource) => resource.id === 'tunnel-progress').quantity, 0);
  assert.equal(attendance.snapshot().revision, 1);
  assert.equal(clue.snapshot().revision, 3);
  assert.equal(digging.snapshot().revision, 5);
});

test('visibility remains stable after save-compatible world copies', () => {
  const sim = new CampSimulation({ world: definition.world });
  const copy = sim.copy();
  assert.deepEqual(observeGeneratedResident(copy.snapshot(), 'wilson'), observeGeneratedResident(sim.snapshot(), 'wilson'));
  act(copy, 'wilson', { type: 'moveTo', location: 'basement' });
  act(copy, 'wilson', { type: 'inspect', clueId: 'mud-on-floor' });
  assert.equal(observeGeneratedResident(copy.snapshot(), 'wilson').resources.some((resource) => resource.id === 'tunnel-progress'), true);
  assert.equal(observeGeneratedResident(sim.snapshot(), 'wilson').resources.some((resource) => resource.id === 'tunnel-progress'), false);
});
