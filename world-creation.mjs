import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CampSimulation } from './core.mjs';
import { callModel } from './model/model-client.mjs';
import { loadModelConfig } from './model/config.mjs';
import { checkWorldCandidate, buildGenesisMessages } from './world-genesis.mjs';
import { parseGeneratedJSON } from './model/generated-json.mjs';
import { parseGenesisOutput, compileGenesisRecords, GENESIS_STAGES, readGenesisStage } from './genesis-records.mjs';
import { emptyDialogue, validDialogue, checkDiscussion, normalizeDiscussion, buildDiscussionMessages } from './creation-dialogue.mjs';
import { createVoxelWorldStore } from './voxel-world.mjs';
import { bindVoxelWorld } from './voxel-bindings.mjs';
import { retrieveSource } from './model/source-retrieval.mjs';
import { normalizeBuildingCommands, describeChanges, recoverableAttempt } from './creation-attempt.mjs';
import { inspectVoxelSpaces } from './geometry/voxel-inspection.js';
const clone = value => structuredClone(value);
const MAX_SOURCE_CHARACTERS = 5_000_000;

function compactModelAudit(role, audit, extra = {}) {
  const requestBody = audit?.request?.body;
  const input = Array.isArray(requestBody?.input) ? requestBody.input : [];
  return {
    role,
    ...extra,
    id: audit?.id ?? null,
    startedAt: audit?.startedAt ?? null,
    model: audit?.model ?? null,
    reasoningEffort: requestBody?.reasoning?.effort ?? null,
    requestSent: Boolean(audit?.requestSent),
    responseStatus: audit?.responseStatus ?? null,
    elapsedMs: audit?.elapsedMs ?? 0,
    headersReceivedMs: audit?.headersReceivedMs ?? null,
    firstEventMs: audit?.firstEventMs ?? null,
    firstTextMs: audit?.firstTextMs ?? null,
    streamedResponse: Boolean(audit?.streamedResponse),
    eventsReceived: audit?.eventsReceived ?? 0,
    finishReason: audit?.finishReason ?? null,
    incompleteReason: audit?.incompleteReason ?? null,
    usage: audit?.usage ?? null,
    error: audit?.error ?? null,
    request: {
      model: requestBody?.model ?? null,
      messageCount: input.length,
      inputCharacters: input.reduce((sum, message) => sum + String(message?.content ?? '').length, 0),
    },
    responseCharacters: typeof audit?.rawResponse === 'string' ? audit.rawResponse.length : null,
  };
}

export function createWorldCreation({ stateFile, createExperience, configLoader = loadModelConfig, fetchImpl = globalThis.fetch } = {}) {
  const directory = dirname(stateFile), stagingFile = join(directory, 'creation.json');
  const save = value => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${stagingFile}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(value)+'\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, stagingFile); }
    finally { rmSync(temp, { force: true }); }
  };
  let saved = null;
  if (existsSync(stagingFile)) {
    try {
      saved = JSON.parse(readFileSync(stagingFile, 'utf8'));
      if (saved?.schemaVersion !== 1) throw new Error('不支持的创建存档版本');
    } catch (cause) { throw new Error('创建存档无法读取或格式损坏，原文件已保留；请恢复 creation.json 后重启。', { cause }); }
  }
  let creation = { mode: 'create', draft: null, lastResult: null, worlds: [], dialogue: emptyDialogue(), source: null, attempts: [], generation: null };
  if (saved?.schemaVersion === 1) {
    creation.mode = saved.mode === 'world' ? 'world' : 'create';
    if (saved.draft?.id && checkWorldCandidate(saved.draft.definition).ok) creation.draft = saved.draft;
    if (Array.isArray(saved.worlds)) creation.worlds = saved.worlds.filter(w => /^[0-9a-f-]{36}$/.test(w?.id) && typeof w.title === 'string' && Number.isSafeInteger(w.worldMinute));
    creation.lastResult = saved.pending ? { ok: false, message: '上次创建世界的请求中断，没有自动重试。' } : saved.lastResult ?? null;
    if (validDialogue(saved.dialogue)) creation.dialogue = saved.dialogue;
    if (Array.isArray(saved.attempts)) creation.attempts = saved.attempts.filter(a => typeof a?.id === 'string' && typeof a.userMessageId === 'string' && typeof a.outcome === 'string').slice(-80);
    if (saved.generation?.id && Array.isArray(saved.generation.records) && Array.isArray(saved.generation.completedStages) && Array.isArray(saved.generation.timings?.calls)) creation.generation = saved.generation;
    if (typeof saved.source?.name === 'string' && saved.source.name.length <= 120 && typeof saved.source?.text === 'string' && saved.source.text.length <= MAX_SOURCE_CHARACTERS && saved.source.text.trim()) creation.source = saved.source;
    if (saved.pending && saved.pendingKind !== 'creation') creation.dialogue.ready = false;
  }
  creation.voxelId = /^[0-9a-f-]{36}$/.test(saved?.voxelId || '') ? saved.voxelId : randomUUID();
  const openVoxel = (id, expected = 0, snapshot) => {
    const file = join(directory, `voxel-${id}.json`);
    try {
      if (snapshot !== undefined && snapshot?.revision !== expected) throw Error('体素草稿版本不一致');
      if (snapshot === undefined && expected > 0 && !existsSync(file)) throw Error('已保存的体素草稿文件缺失');
      return createVoxelWorldStore({ file, snapshot, onSave: next => persist(next) });
    } catch {
      const message = '建造草稿文件缺失或损坏；原文件已保留，请恢复后重启。';
      creation.lastResult = { ok: false, reason: 'voxel-recovery', message };
      const fail = () => { throw Error(message); };
      return { state: () => ({ revision: expected, cells: [], objects: [], canUndo: false, canRedo: false, error: message }), apply: fail, undo: fail, redo: fail };
    }
  };
  let voxel = openVoxel(creation.voxelId, Number.isSafeInteger(saved?.voxelRevision) ? saved.voxelRevision : 0, saved?.voxelSnapshot);
  for (const attempt of creation.attempts) if (attempt.outcome === 'pending') {
    Object.assign(attempt, { outcome: 'failed', reason: 'interrupted', message: '上次请求中断，输入已保留。可以重试这次请求，或调整后发送。', finishedAt: new Date().toISOString() });
    creation.dialogue.messages.push({ id: randomUUID(), role: 'assistant', text: attempt.message, attemptId: attempt.id });
    creation.lastResult = { ok: false, reason: attempt.reason, message: attempt.message, attemptId: attempt.id };
  }
  if (creation.generation?.outcome === 'pending') {
    creation.generation.outcome = 'failed';
    creation.lastResult = { ok: false, reason: 'interrupted', message: '上次起点生成中断，已完成的步骤已保存。可点击继续生成，没有自动重试。', generationId: creation.generation.id };
  }
  // Fixed experiments are backups, never an active world in the creation flow.
  // Move the original bytes before opening a runtime (which could resume autonomy).
  if (existsSync(stateFile)) {
    const head = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (head.scenario === 'beast-camp-v1') {
      const retired = join(directory, 'retired');
      mkdirSync(retired, { recursive: true, mode: 0o700 });
      renameSync(stateFile, join(retired, `beast-camp-${randomUUID()}.json`));
      creation.mode = 'create';
    }
  }
  const isGeneratedArchive = id => {
    try {
      const head = JSON.parse(readFileSync(join(directory, 'worlds', `${id}.json`), 'utf8'));
      return head.scenario === 'generated-world-v1' && head.world?.profile === 'generated-world';
    } catch { return false; }
  };
  creation.worlds = creation.worlds.filter(w => isGeneratedArchive(w.id));
  let inner = existsSync(stateFile) ? createExperience({ stateFile, configLoader, fetchImpl }) : null;
  if (inner && creation.draft?.id === inner.state().genesis?.draftId) { creation.draft = null; creation.mode = 'world'; }
  if (!inner) creation.mode = 'create';
  if (inner && creation.mode === 'create') inner.control({ type: 'pause' });
  let active = null, epoch = 0;
  const model = { pending: false, kind: 'creation', actorId: null, progress: null, lastResult: creation.lastResult };
  const persist = (snapshot = voxel.snapshot?.()) => save({ schemaVersion: 1, ...creation,
    voxelRevision: snapshot?.revision ?? voxel.state().revision,
    ...(snapshot ? { voxelSnapshot: snapshot } : saved?.voxelSnapshot ? { voxelSnapshot: saved.voxelSnapshot } : {}),
    pending: Boolean(active && !active.finalizing), pendingKind: active ? model.kind : null });
  const state = () => ({ ...(inner?.state() ?? { world: null, worldMinute: 0, revision: 0, paused: true, speed: 24, waiting: null, actors: {}, autonomy: { enabled: false, waitingReason: null }, scene: null, model: { pending: false } }),
    creation: { ...clone({ ...creation, source: creation.source ? { name: creation.source.name, characters: creation.source.text.length } : null }), voxel: voxel.state(), hasWorld: Boolean(inner) },
    ...(active || creation.mode === 'create' ? { model: { ...clone(model), progress: model.progress && active ? { ...model.progress, elapsedMs: performance.now()-active.startedAt } : null } } : {}) });
  const response = (ok, message, extra = {}) => ({ ok, message, ...extra, state: state() });
  const invalidateGeneration = (generation, result) => {
    if (!['invalid-world', 'invalid-world-scene', 'privacy-audit-failed', 'world-compile-failed'].includes(result?.reason) || !generation.completedStages.length) return;
    const stageFor = path => /^(world\.(actors|story\.(clues|facts))|initialMemories)(\.|\[|$)/.test(path) ? 1
      : /^world\.(resources|processes|actions)(\.|\[|$)/.test(path) ? 2 : 0;
    const firstInvalid = result.diagnostics?.length ? Math.min(...result.diagnostics.map(d => stageFor(d.path || ''))) : 0;
    const retained = GENESIS_STAGES.slice(0, firstInvalid), types = new Set(retained.flatMap(s => s.types));
    generation.completedStages = generation.completedStages.filter(id => retained.some(s => s.id === id));
    generation.records = generation.records.filter(r => types.has(r.type));
    generation.adjustments = [];
  };
  if (creation.generation?.outcome === 'failed') invalidateGeneration(creation.generation, creation.lastResult);
  const blocked = () => Boolean(active || inner?.state().model.pending);
  function archiveCurrent() {
    if (!inner) return;
    inner.close();
    const snapshot = CampSimulation.load(stateFile);
    const s = inner.state(), id = randomUUID();
    const folder = join(directory, 'worlds'); mkdirSync(folder, { recursive: true, mode: 0o700 });
    snapshot.save(join(folder, `${id}.json`));
    creation.worlds.push({ id, title: s.world.title || s.scene?.document?.title || '之前的旅途', worldMinute: s.worldMinute });
    persist(); // The archive index must be durable before replacing the active world.
  }
  const control = body => {
    switch (body?.type) {
      case 'creation-open': case 'reset':
        if (blocked()) return response(false, '请先完成或取消当前模型调用。');
        if (creation.mode === 'world' || body.type === 'reset') { creation.dialogue = emptyDialogue(); creation.attempts = []; creation.generation = null; creation.draft = null; creation.source = null; creation.voxelId = randomUUID(); voxel = openVoxel(creation.voxelId); }
        inner?.control({ type: 'pause' }); creation.mode = 'create'; creation.lastResult = null; epoch++; persist();
        return response(true, '从一个新想法开始，现有世界已暂停并保留。');
      case 'creation-resume':
        if (blocked() || !inner) return response(false, '当前没有可返回的世界，或调用尚未结束。');
        creation.mode = 'world'; persist(); return response(true, '已返回现有世界。');
      case 'source-set': {
        if (blocked() || creation.mode !== 'create') return response(false, '请先结束当前请求，再更换素材。');
        if (body.source !== null && (!body.source || typeof body.source.name !== 'string' || !body.source.name.trim() || body.source.name.length > 120 || typeof body.source.text !== 'string' || !body.source.text.trim() || body.source.text.length > MAX_SOURCE_CHARACTERS)) return response(false, '请选择不超过 500 万字的非空文本文件；大文本会按需检索，不会整篇发送给模型。');
        creation.source = body.source ? { name: body.source.name.trim(), text: body.source.text } : null;
        creation.dialogue.revision++; creation.dialogue.ready = false; creation.dialogue.summary = ''; creation.draft = null; creation.generation = null; epoch++; persist();
        return response(true, creation.source ? '素材已保存，现有建造保留。告诉我想从哪里开始。' : '素材已移除，现有建造保留。');
      }
      case 'voxel-undo': case 'voxel-redo': {
        if (blocked() || creation.mode !== 'create') return response(false, '请先结束当前请求，再修改建造草稿。');
        try {
          voxel[body.type === 'voxel-undo' ? 'undo' : 'redo']({ baseRevision: body.baseRevision });
          persist(); return response(true, body.type === 'voxel-undo' ? '已撤销上一次建造。' : '已恢复上一次建造。');
        } catch (error) { return response(false, error.message || '修改未完成。'); }
      }
      case 'world-discard':
        if (blocked() || !creation.draft || creation.draft.id !== body.draftId) return response(false, '这个世界草稿已经变化。');
        creation.draft = null; persist(); return response(true, '草稿已放弃。');
      case 'world-accept': {
        if (blocked() || !creation.draft || creation.draft.id !== body.draftId) return response(false, '这个世界草稿已经变化，不能创建。');
        const voxelSnapshot = voxel.state();
        if (voxelSnapshot.error) return response(false, voxelSnapshot.error);
        if (creation.draft.baseConversationRevision !== undefined && creation.draft.baseConversationRevision !== creation.dialogue.revision) return response(false, '讨论已经更新，请先按新的设定生成草稿，再确认进入。');
        if (creation.draft.baseVoxelId !== undefined && (creation.draft.baseVoxelId !== creation.voxelId || creation.draft.baseVoxelRevision !== voxelSnapshot.revision)) return response(false, '建造草稿已经改变，请重新检查起点。');
        const checked = checkWorldCandidate(creation.draft.definition);
        if (!checked.ok) return response(false, '草稿未通过检查。', checked);
        const { definition } = checked;
        const next = new CampSimulation({ world: definition.world }); next.pause();
        const origin = next.view(1);
        const genesis = { draftId: creation.draft.id, description: creation.draft.description, initialMemories: definition.initialMemories, instanceId: origin.instanceId, worldTitle: definition.world.title, scene: clone(definition.scene), voxel: voxelSnapshot, voxelBindings: clone(creation.draft.voxelBindings || bindVoxelWorld({ definition, voxel: voxelSnapshot })), adjustments: clone(creation.draft.adjustments || []), dialogue: clone(creation.dialogue) };
        const ledgers = Object.fromEntries(definition.world.actors.map(a => [a.id, { entries: [], lastDecision: null }]));
        const experience = { ledgers, autonomy: { enabled: false, waitingReason: null, nextActorId: definition.world.actors[0].id }, lastResult: null, recovery: null,
          pending: false, pendingKind: null, genesis, scene: { document: definition.scene, revision: 0, draft: null, lastResult: null } };
        // The old world is archived before the single authoritative save is replaced.
        try { archiveCurrent(); next.save(stateFile, { experience }); }
        catch (error) { inner = existsSync(stateFile) ? createExperience({ stateFile, configLoader, fetchImpl }) : null; throw error; }
        inner = createExperience({ stateFile, configLoader, fetchImpl });
        creation.draft = null; creation.mode = 'world'; creation.lastResult = { ok: true, message: '世界已创建，时间停在起源，随时可以开始。' }; epoch++; persist();
        return response(true, creation.lastResult.message);
      }
      case 'world-open': {
        if (blocked() || !creation.worlds.some(w => w.id === body.worldId)) return response(false, '找不到这个已保存的世界。');
        if (!isGeneratedArchive(body.worldId)) return response(false, '旧实验不属于已创建的世界，请重新生成。');
        const selected = CampSimulation.load(join(directory, 'worlds', `${body.worldId}.json`));
        try { archiveCurrent(); selected.pause(); selected.save(stateFile); }
        catch (error) { inner = existsSync(stateFile) ? createExperience({ stateFile, configLoader, fetchImpl }) : null; throw error; }
        inner = createExperience({ stateFile, configLoader, fetchImpl }); creation.mode = 'world'; epoch++; persist();
        return response(true, '已切换到保存的世界。');
      }
      default:
        if (creation.mode !== 'world' || !inner) return response(false, '先创建或打开一个世界。');
        { const result = inner.control(body); return { ...result, state: state() }; }
    }
  };
  const cancelModel = () => {
    if (!active) { const result = inner?.cancelModel(); return result ? { ...result, state: state() } : response(false, '没有进行中的模型调用。'); }
    active.controller.abort();
    // Finalization may have prepared a successful outcome whose voxel snapshot
    // is not committed yet. Only its atomic commit/failure path can save it.
    if (!active.finalizing) persist();
    return response(true, '已请求取消创建世界。');
  };
  const discussStep = async ({ message, mode = 'auto', retryAttemptId, baseVoxelRevision, voxelId: clientVoxelId, conversationRevision } = {}, { onProgress, signal } = {}) => {
    if (blocked() || creation.mode !== 'create') return response(false, '先结束当前请求，再继续讨论。', { reason: 'busy' });
    if (voxel.state().error) return response(false, voxel.state().error, { reason: 'voxel-recovery' });
    if (baseVoxelRevision !== undefined && baseVoxelRevision !== voxel.state().revision || clientVoxelId !== undefined && clientVoxelId !== creation.voxelId || conversationRevision !== undefined && conversationRevision !== creation.dialogue.revision) return response(false, '场景或讨论已经更新，请检查当前画面后再发送。', { reason: 'stale-basis' });
    const previous = retryAttemptId && creation.attempts.find(a => a.id === retryAttemptId);
    if (retryAttemptId) {
      if (!recoverableAttempt(previous) || previous !== creation.attempts.at(-1)) return response(false, '这次意图已有后续处理，请按当前想法发送新消息。', { reason: 'stale-attempt' });
      message = creation.dialogue.messages.find(m => m.id === previous.userMessageId)?.text;
      mode = previous.mode;
    }
    if (!['auto', 'discuss', 'build'].includes(mode)) return response(false, '请选择讨论或建造。', { reason: 'invalid-mode' });
    if (typeof message !== 'string' || !message.trim() || message.length > 8000) return response(false, '写下你的想法或想调整的细节。', { reason: 'invalid-message' });
    if (creation.dialogue.messages.length >= 78 || creation.dialogue.messages.reduce((n, m) => n + m.text.length, 0) + message.length > 40000) return response(false, '这段讨论已经很长，请先生成并确认这一小片起点。', { reason: 'conversation-limit' });
    const controller = new AbortController(), startEpoch = epoch, startedAt = performance.now();
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const user = retryAttemptId ? creation.dialogue.messages.find(m => m.id === previous.userMessageId) : { id: randomUUID(), role: 'user', text: message.trim() };
    if (!retryAttemptId) creation.dialogue.messages.push(user);
    creation.dialogue.revision++; creation.dialogue.ready = false;
    const voxelBasis = voxel.state(), voxelId = creation.voxelId;
    const attempt = { id: randomUUID(), userMessageId: user.id, mode, retryOf: previous?.id ?? null, outcome: 'pending',
      voxelId, fromRevision: voxelBasis.revision, toRevision: voxelBasis.revision, message: '请求已保存，尚未修改场景。',
      createdAt: new Date().toISOString(), diagnostics: [], adjustments: [],
      timings: { totalMs: 0, modelMs: 0, validationMs: 0, commitMs: 0, calls: [] } };
    creation.attempts.push(attempt); creation.attempts = creation.attempts.slice(-80);
    active = { controller, startedAt }; model.pending = true; model.kind = 'discussion'; model.lastResult = null;
    const publish = progress => { model.progress = { ...progress, elapsedMs: performance.now() - startedAt, callCount: active?.callIndex || 1 }; try { onProgress?.(model.progress); } catch {} };
    const fail = (reason, message, diagnostics = []) => ({ ok: false, reason, message, diagnostics });
    let result = fail('request-failed', '请求没有完成，输入已保留。可以重试这次请求，或调整后发送。');
    let explanation = '', value, prepared, commitStarted, durable = false;
    const dialogueBeforeReply = clone(creation.dialogue);
    const request = async (llm, sourceContext, retrievalRound = false) => {
      active.callIndex = attempt.timings.calls.length + 1;
      const r = await callModel({ llm, messages: buildDiscussionMessages(creation.dialogue, creation.draft, creation.source, voxelBasis,
        { sourceContext, retrievalRound, mode, previousAttempt: previous, attempts: creation.attempts.filter(a => a.id !== attempt.id) }), fetchImpl, signal: controller.signal, onProgress: publish });
      const audit = compactModelAudit(retrievalRound ? 'world-discussion-retrieval' : 'world-discussion', r.audit, { attemptId: attempt.id });
      attempt.timings.calls.push({ model: audit.model, elapsedMs: audit.elapsedMs, headersReceivedMs: audit.headersReceivedMs,
        firstEventMs: audit.firstEventMs, firstTextMs: audit.firstTextMs, requestSent: audit.requestSent, reasoningEffort: audit.reasoningEffort, reason: audit.error?.code ?? null });
      attempt.timings.modelMs += audit.elapsedMs;
      appendFileSync(join(directory, 'model-calls.jsonl'), JSON.stringify(audit)+'\n', { mode: 0o600 });
      return r;
    };
    const basisCurrent = () => epoch === startEpoch && voxelId === creation.voxelId && voxel.state().revision === voxelBasis.revision;
    publish({ phase: 'connecting', eventsReceived: 0, outputCharacters: 0, preview: '' });
    try {
      persist();
      const { llm } = configLoader();
      let r = await request(llm, retrieveSource(creation.source, [message, creation.dialogue.summary]));
      const parse = content => { try {
        const parsed = parseGeneratedJSON(content, { allowEmbeddedObject: true, requiredKeys: ['reply'] });
        attempt.adjustments = parsed.adjustments.map(message => ({ path: 'response', message }));
        return normalizeDiscussion(parsed.value, creation.dialogue.summary);
      } catch { return null; } };
      if (r.ok) value = parse(r.content);
      if (!controller.signal.aborted && basisCurrent() && checkDiscussion(value) && value.retrievalQueries?.length && creation.source) {
        r = await request(llm, retrieveSource(creation.source, value.retrievalQueries), true);
        value = r.ok ? parse(r.content) : null;
      }
      const validationStarted = performance.now();
      publish({ ...model.progress, phase: 'verifying' });
      if (controller.signal.aborted) result = fail('cancelled', '这次请求已取消，场景没有变化。输入已保留，可重试或调整。');
      else if (!basisCurrent()) result = fail('stale-basis', '场景或讨论已经变化，这次结果未采用。重试会重新读取当前场景。');
      else if (!r.ok) result = fail(r.audit.error?.code ?? 'request-failed', '模型回复未完成，场景没有变化。输入已保留，可检查连接后重试。');
      else if (!checkDiscussion(value)) result = fail('invalid-discussion', '模型回复格式不完整，场景没有变化。可以按原意图重试，无需重新描述。', [{ path: 'discussion', message: '需要非空 reply、summary 和布尔 ready；commands 若提供必须是数组。' }]);
      else {
        explanation = value.reply.trim();
        if (/commands\s*[:：]|```|["']op["']\s*:/.test(explanation)) explanation = explanation.split(/\n\s*(?:commands\s*[:：]|```|\[?\s*\{)/i)[0].trim() || '模型提供了建造方案，实际执行结果见下方。';
        if (mode !== 'discuss' && value.commands?.length) {
          if (voxelBasis.cells.length > 5000) result = fail('scene-too-large', '当前场景超过单次编辑范围，这次没有修改。请缩小场景后再试。');
          else {
            try {
              const normalized = normalizeBuildingCommands(value.commands);
              attempt.adjustments.push(...normalized.adjustments);
              prepared = voxel.prepare({ baseRevision: voxelBasis.revision, commands: normalized.commands });
              attempt.changes = describeChanges(prepared.changes);
              attempt.toRevision = prepared.state.revision;
              const inspection = inspectVoxelSpaces(prepared.state);
              result = { ok: true, message: prepared.state.revision === voxelBasis.revision ? '已检查建造步骤，场景没有变化。' :
                `已保存本次建造：新增 ${attempt.changes.added}、替换 ${attempt.changes.replaced}、移除 ${attempt.changes.removed} 个方块；更新 ${attempt.changes.objects} 个对象。${inspection.issues.length ? ` 空间检查还有 ${inspection.issues.length} 项待处理，请查看画布下方。` : ''}`,
                diagnostics: inspection.issues.map(i => ({ path: `objects.${i.objectId}.${i.code}`, message: i.message })) };
              attempt.outcome = prepared.state.revision === voxelBasis.revision ? 'unchanged' : 'committed';
            } catch (error) { result = fail('invalid-building', error.diagnostics ? error.message : '建造步骤未通过检查，这次没有修改。可重试或缩小范围。', error.diagnostics ?? [{ path: 'commands', message: error.message }]); }
          }
        } else if (mode === 'build') {
          result = fail('no-building-commands', '这次只收到文字说明，没有可执行的建造步骤，场景没有变化。可以重试建造，或补充最想先看见的部分。');
          attempt.outcome = 'not-built';
        } else { result = { ok: true, message: '本轮仅讨论，场景未修改。' }; attempt.outcome = 'discussion'; }
      }
      attempt.timings.validationMs = performance.now() - validationStarted;
    } catch (error) {
      result = fail(['EISDIR', 'ENOSPC', 'EDQUOT', 'EACCES', 'EROFS', 'ENOENT', 'EPERM'].includes(error.code) ? 'save-error' : 'configuration-or-save-error', '请求或保存未完成，场景没有变化。输入已保留，请检查模型连接与本地存储后重试。');
    }
    const recordResult = () => {
      if (!result.ok && !['not-built', 'cancelled'].includes(attempt.outcome)) attempt.outcome = result.reason === 'cancelled' ? 'cancelled' : 'failed';
      Object.assign(attempt, { reason: result.reason ?? null, message: result.message, diagnostics: result.diagnostics ?? [], finishedAt: new Date().toISOString() });
      attempt.timings.totalMs = performance.now() - startedAt;
      creation.dialogue.messages.push({ id: randomUUID(), role: 'assistant', text: result.ok || attempt.outcome === 'not-built' ? explanation || result.message : result.message, attemptId: attempt.id });
      if (result.ok || attempt.outcome === 'not-built') {
        creation.dialogue.summary = value.summary.trim();
        creation.dialogue.ready = value.ready && (mode === 'build' && result.ok || creation.dialogue.messages.filter(m => m.role === 'user').length >= 2);
      }
      creation.lastResult = { ...result, attemptId: attempt.id }; model.lastResult = creation.lastResult;
    };
    try {
      recordResult(); active.finalizing = true;
      if (result.ok && prepared && attempt.outcome === 'committed') {
        publish({ ...model.progress, phase: 'committing' }); commitStarted = performance.now();
        if (controller.signal.aborted || !basisCurrent()) throw Object.assign(new Error('commit interrupted'), { reason: controller.signal.aborted ? 'cancelled' : 'stale-basis' });
        prepared.commit(); durable = true;
        attempt.timings.commitMs = performance.now() - commitStarted;
      } else { commitStarted = performance.now(); persist(); durable = true; attempt.timings.commitMs = performance.now() - commitStarted; }
      attempt.timings.totalMs = performance.now() - startedAt;
      // The first save is authoritative; a failed metrics update cannot uncommit it.
      try { persist(); } catch { /* Durable scene and outcome already agree. */ }
    } catch (error) {
      if (!durable) {
        creation.dialogue = dialogueBeforeReply;
        attempt.outcome = 'failed'; attempt.toRevision = voxelBasis.revision; delete attempt.changes;
        result = error.reason ? fail(error.reason, error.reason === 'cancelled' ? '这次请求已取消，场景没有变化。输入已保留，可重试或调整。' : '场景已经变化，这次结果未采用。') : fail('save-error', '这次保存没有完成，场景没有变化。输入已保留，请恢复本地存储后重试。');
        recordResult();
        try { persist(); } catch { /* Keep the intent visible in this session; the last durable attempt recovers on restart. */ }
      }
    } finally {
      signal?.removeEventListener('abort', abort); active = null; model.pending = false;
    }
    return { ...result, reply: explanation, attempt: clone(attempt), state: state() };
  };
  const worldStep = async ({ description, conversationRevision, retryGenerationId, authorRequested = false } = {}, { onProgress, signal } = {}) => {
    if (blocked() || creation.mode !== 'create') return response(false, '请先进入创建页并结束当前调用。', { reason: 'busy' });
    if (voxel.state().error) return response(false, voxel.state().error, { reason: 'voxel-recovery' });
    const conversational = creation.dialogue.messages.length > 0 || conversationRevision !== undefined;
    if (conversational) {
      if (conversationRevision !== creation.dialogue.revision || !creation.dialogue.summary.trim() || !creation.dialogue.messages.some(m => m.role === 'user') || !creation.dialogue.ready && authorRequested !== true) return response(false, '先保存起点想法，再选择查看当前设定的草稿。', { reason: 'discussion-required' });
      description = creation.dialogue.summary;
    }
    if (typeof description !== 'string' || !description.trim() || description.length > 8000) return response(false, '写下一段想要的世界，再开始创建。', { reason: 'invalid-description' });
    const oldGeneration = creation.generation;
    if (retryGenerationId && (!oldGeneration || oldGeneration.id !== retryGenerationId || !['failed', 'cancelled'].includes(oldGeneration.outcome) || oldGeneration.description !== description.trim() || oldGeneration.conversationRevision !== creation.dialogue.revision || oldGeneration.voxelId !== creation.voxelId || oldGeneration.voxelRevision !== voxel.state().revision)) return response(false, '起点基准已经变化，请根据当前设定重新生成。', { reason: 'stale-basis' });
    if (retryGenerationId) invalidateGeneration(oldGeneration, creation.lastResult);
    const controller = new AbortController(), startEpoch = epoch;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    // A new request must never leave an older draft looking like the failed result.
    const previousDraft = creation.draft?.definition;
    const dialogueBeforeGeneration = clone(creation.dialogue);
    const generation = retryGenerationId ? oldGeneration : { id: randomUUID(), description: description.trim(), conversationRevision: creation.dialogue.revision,
      voxelId: creation.voxelId, voxelRevision: voxel.state().revision, records: [], completedStages: [], adjustments: [], timings: { totalMs: 0, calls: [] } };
    generation.outcome = 'pending'; creation.generation = generation;
    creation.draft = null;
    active = { controller, startedAt: performance.now() }; model.pending = true; model.kind = 'creation'; model.lastResult = null;
    const publish = p => { model.progress = p; try { onProgress?.(p); } catch { /* signal handles disconnect */ } };
    publish({ phase: 'connecting', elapsedMs: 0, eventsReceived: 0, outputCharacters: 0, preview: '' });
    let result = { ok: false, reason: 'request-failed', message: '创建世界没有完成，没有自动重试。' };
    try {
      persist(); const { llm } = configLoader();
      const records = clone(generation.records), adjustments = [...generation.adjustments];
      let definition = null, failed = false;
      for (const stage of GENESIS_STAGES) {
        if (controller.signal.aborted) { result = { ok: false, reason: 'cancelled', message: '创建世界已取消，现有世界保持原样。' }; failed = true; break; }
        if (generation.completedStages.includes(stage.id)) continue;
        const stageProgress = p => publish({ ...p, stageLabel: stage.label, elapsedMs: performance.now() - active.startedAt });
        stageProgress({ phase: 'connecting', outputCharacters: 0 });
        const sourceContext = retrieveSource(creation.source, [description, creation.dialogue.summary, stage.label]);
        const r = await callModel({ llm, messages: buildGenesisMessages(description.trim(), {
          dialogue: conversational ? creation.dialogue : null, source: creation.source, sourceContext, previousDraft,
          diagnostics: creation.lastResult?.diagnostics ?? [], stage, previousRecords: records, voxel: voxel.state(),
        }), fetchImpl, jsonMode: false, signal: controller.signal, onProgress: stageProgress });
        const audit = compactModelAudit('world-genesis', r.audit, { stage: stage.id, generationId: generation.id });
        generation.timings.calls.push({ stage: stage.id, model: audit.model, elapsedMs: audit.elapsedMs, headersReceivedMs: audit.headersReceivedMs, firstTextMs: audit.firstTextMs, reason: audit.error?.code ?? null });
        appendFileSync(join(directory, 'model-calls.jsonl'), JSON.stringify(audit)+'\n', { mode: 0o600 });
        if (controller.signal.aborted) result = { ok: false, reason: 'cancelled', message: '创建世界已取消，现有世界保持原样。' };
        else if (!r.ok) result = { ok: false, reason: r.audit.error?.code ?? 'request-failed', message: `${stage.label.replace('正在', '')}未完成，请继续讨论或重新生成。` };
        else if (epoch !== startEpoch) result = { ok: false, reason: 'stale-basis', message: '创建基准已变化，旧草稿未保留。' };
        else {
          try {
            const parsed = parseGenesisOutput(r.content, { partial: true });
            adjustments.push(...parsed.adjustments);
            // Older model responses and regression fixtures may supply a complete
            // definition. It still passes the same full validation below.
            if (parsed.value && !records.length) { definition = parsed.value; break; }
            records.push(...readGenesisStage(parsed.records, stage, records));
            generation.records = clone(records); generation.adjustments = [...adjustments]; generation.completedStages.push(stage.id);
            persist();
            continue;
          } catch (error) { result = { ok: false, reason: 'invalid-json', message: error.message, diagnostics: [{ path: stage.id, message: error.message }] }; }
        }
        failed = true; break; // One attempt per step; never retry silently.
      }
      if (!failed) {
        publish({ ...model.progress, phase: 'verifying' });
        if (controller.signal.aborted) result = { ok: false, reason: 'cancelled', message: '创建世界已取消，现有世界保持原样。' };
        else {
          if (!definition) {
            try { definition = compileGenesisRecords(records); }
            catch (error) { result = { ok: false, reason: 'invalid-world', message: error.message, diagnostics: [{ path: 'world', message: error.message }] }; }
          }
          const checked = definition ? checkWorldCandidate(definition) : null;
          if (checked && !checked.ok) result = { ...checked, message: '生成结果未通过世界规则或三维场景检查，请调整想法后再试。' };
          else if (checked) {
            const voxelSnapshot = voxel.state();
            creation.draft = { id: randomUUID(), description: description.trim(), definition: checked.definition,
              baseVoxelId: creation.voxelId, baseVoxelRevision: voxelSnapshot.revision,
              ...(conversational ? { baseConversationRevision: creation.dialogue.revision } : {}),
              voxelBindings: bindVoxelWorld({ definition: checked.definition, voxel: voxelSnapshot }),
              adjustments: [...adjustments, ...checked.adjustments], privacyAudit: checked.privacyAudit, createdAt: new Date().toISOString() };
            result = { ok: true, message: '这一片起点已生成。看看画面和规律，可以继续告诉我哪里要改，满意后再进入。' };
            if (conversational) creation.dialogue.messages.push({ id: randomUUID(), role: 'assistant', text: result.message });
          }
        }
      }
    } catch { result = { ok: false, reason: 'configuration-or-save-error', message: '创建世界的请求或保存未完成，请检查配置与本地存储；没有自动重试。' }; }
    finally {
      signal?.removeEventListener('abort', abort);
      generation.outcome = result.ok ? 'ready' : result.reason === 'cancelled' ? 'cancelled' : 'failed';
      invalidateGeneration(generation, result);
      generation.timings.totalMs += performance.now() - active.startedAt;
      result.generationId = generation.id;
      active.finalizing = true; model.lastResult = result; creation.lastResult = result;
      try { persist(); }
      catch {
        creation.draft = null; creation.dialogue = dialogueBeforeGeneration; generation.outcome = 'failed';
        result = { ok: false, reason: 'save-error', generationId: generation.id, message: '起点草稿未能保存，不能确认进入。请恢复本地存储后重试。' };
        model.lastResult = result; creation.lastResult = result;
        try { persist(); } catch { /* Keep the last durable origin intact. */ }
      }
      active = null; model.pending = false;
    }
    return { ...result, state: state() };
  };
  const delegate = name => async (body, options) => {
    if (active || creation.mode !== 'world' || !inner) return response(false, '先进入世界，再进行操作。');
    const result = await inner[name](body, options); return { ...result, state: state() };
  };
  return { state, control, discussStep, worldStep, actorStep: delegate('actorStep'), sceneStep: delegate('sceneStep'), cancelModel,
    close() { if (active) active.controller.abort(); inner?.close(); persist(); } };
}
