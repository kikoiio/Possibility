import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CampSimulation } from './core.mjs';
import { callModel } from './model/model-client.mjs';
import { loadModelConfig } from './model/config.mjs';
import { checkWorldCandidate, buildGenesisMessages } from './world-genesis.mjs';
import { parseGeneratedJSON } from './model/generated-json.mjs';
import { parseGenesisOutput, compileGenesisRecords, GENESIS_STAGES, readGenesisStage } from './genesis-records.mjs';
import { emptyDialogue, validDialogue, checkDiscussion, buildDiscussionMessages } from './creation-dialogue.mjs';
import { createVoxelWorldStore } from './voxel-world.mjs';
const clone = value => structuredClone(value);

export function createWorldCreation({ stateFile, createExperience, configLoader = loadModelConfig, fetchImpl = globalThis.fetch } = {}) {
  const directory = dirname(stateFile), stagingFile = join(directory, 'creation.json');
  const save = value => {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temp = `${stagingFile}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(value)+'\n', { mode: 0o600, flag: 'wx' }); renameSync(temp, stagingFile); }
    finally { rmSync(temp, { force: true }); }
  };
  let saved = null;
  if (existsSync(stagingFile)) { try { saved = JSON.parse(readFileSync(stagingFile, 'utf8')); } catch { /* current world remains untouched */ } }
  let creation = { mode: 'create', draft: null, lastResult: null, worlds: [], dialogue: emptyDialogue(), source: null };
  if (saved?.schemaVersion === 1) {
    creation.mode = saved.mode === 'world' ? 'world' : 'create';
    if (saved.draft?.id && checkWorldCandidate(saved.draft.definition).ok) creation.draft = saved.draft;
    if (Array.isArray(saved.worlds)) creation.worlds = saved.worlds.filter(w => /^[0-9a-f-]{36}$/.test(w?.id) && typeof w.title === 'string' && Number.isSafeInteger(w.worldMinute));
    creation.lastResult = saved.pending ? { ok: false, message: '上次创建世界的请求中断，没有自动重试。' } : saved.lastResult ?? null;
    if (validDialogue(saved.dialogue)) creation.dialogue = saved.dialogue;
    if (typeof saved.source?.name === 'string' && saved.source.name.length <= 120 && typeof saved.source?.text === 'string' && saved.source.text.length <= 100000 && saved.source.text.trim()) creation.source = saved.source;
    if (saved.pending) creation.dialogue.ready = false;
  }
  creation.voxelId = /^[0-9a-f-]{36}$/.test(saved?.voxelId || '') ? saved.voxelId : randomUUID();
  const openVoxel = (id, expected = 0) => {
    const file = join(directory, `voxel-${id}.json`);
    try {
      if (expected > 0 && !existsSync(file)) throw Error('已保存的体素草稿文件缺失');
      return createVoxelWorldStore({ file });
    } catch {
      const message = '建造草稿文件缺失或损坏；原文件已保留，请恢复后重启。';
      creation.lastResult = { ok: false, reason: 'voxel-recovery', message };
      const fail = () => { throw Error(message); };
      return { state: () => ({ revision: expected, cells: [], objects: [], canUndo: false, canRedo: false, error: message }), apply: fail, undo: fail, redo: fail };
    }
  };
  let voxel = openVoxel(creation.voxelId, Number.isSafeInteger(saved?.voxelRevision) ? saved.voxelRevision : 0);
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
  const persist = () => save({ schemaVersion: 1, ...creation, voxelRevision: voxel.state().revision, pending: Boolean(active && !active.controller.signal.aborted) });
  const state = () => ({ ...(inner?.state() ?? { world: null, worldMinute: 0, revision: 0, paused: true, speed: 24, waiting: null, actors: {}, autonomy: { enabled: false, waitingReason: null }, scene: null, model: { pending: false } }),
    creation: { ...clone({ ...creation, source: creation.source ? { name: creation.source.name, characters: creation.source.text.length } : null }), voxel: voxel.state(), hasWorld: Boolean(inner) },
    ...(active || creation.mode === 'create' ? { model: { ...clone(model), progress: model.progress && active ? { ...model.progress, elapsedMs: performance.now()-active.startedAt } : null } } : {}) });
  const response = (ok, message, extra = {}) => ({ ok, message, ...extra, state: state() });
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
        if (creation.mode === 'world' || body.type === 'reset') { creation.dialogue = emptyDialogue(); creation.draft = null; creation.source = null; creation.voxelId = randomUUID(); voxel = openVoxel(creation.voxelId); }
        inner?.control({ type: 'pause' }); creation.mode = 'create'; creation.lastResult = null; epoch++; persist();
        return response(true, '从一个新想法开始，现有世界已暂停并保留。');
      case 'creation-resume':
        if (blocked() || !inner) return response(false, '当前没有可返回的世界，或调用尚未结束。');
        creation.mode = 'world'; persist(); return response(true, '已返回现有世界。');
      case 'source-set': {
        if (blocked() || creation.mode !== 'create') return response(false, '请先结束当前请求，再更换素材。');
        if (body.source !== null && (!body.source || typeof body.source.name !== 'string' || !body.source.name.trim() || body.source.name.length > 120 || typeof body.source.text !== 'string' || !body.source.text.trim() || body.source.text.length > 100000)) return response(false, '请选择不超过 10 万字的非空文本文件。');
        creation.source = body.source ? { name: body.source.name.trim(), text: body.source.text } : null;
        creation.dialogue.revision++; creation.dialogue.ready = false; creation.dialogue.summary = ''; creation.draft = null; epoch++; persist();
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
        if (voxel.state().error) return response(false, voxel.state().error);
        if (creation.draft.baseConversationRevision !== undefined && creation.draft.baseConversationRevision !== creation.dialogue.revision) return response(false, '讨论已经更新，请先按新的设定生成草稿，再确认进入。');
        if (creation.draft.baseVoxelId !== undefined && (creation.draft.baseVoxelId !== creation.voxelId || creation.draft.baseVoxelRevision !== voxel.state().revision)) return response(false, '建造草稿已经改变，请重新检查起点。');
        if (voxel.state().cells.length) return response(false, '体素场景尚未与人物及地点绑定，暂时不能进入模拟；建造草稿已保存。');
        const checked = checkWorldCandidate(creation.draft.definition);
        if (!checked.ok) return response(false, '草稿未通过检查。', checked);
        const { definition } = checked;
        const next = new CampSimulation({ world: definition.world }); next.pause();
        const origin = next.view(1);
        const genesis = { draftId: creation.draft.id, description: creation.draft.description, initialMemories: definition.initialMemories, instanceId: origin.instanceId, worldTitle: definition.world.title, scene: clone(definition.scene), voxel: voxel.state(), adjustments: clone(creation.draft.adjustments || []), dialogue: clone(creation.dialogue) };
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
    active.controller.abort(); persist(); return response(true, '已请求取消创建世界。');
  };
  const discussStep = async ({ message } = {}, { onProgress, signal } = {}) => {
    if (blocked() || creation.mode !== 'create') return response(false, '先结束当前请求，再继续讨论。', { reason: 'busy' });
    if (voxel.state().error) return response(false, voxel.state().error, { reason: 'voxel-recovery' });
    if (typeof message !== 'string' || !message.trim() || message.length > 8000) return response(false, '写下你的想法或想调整的细节。', { reason: 'invalid-message' });
    if (creation.dialogue.messages.length >= 78 || creation.dialogue.messages.reduce((n, m) => n + m.text.length, 0) + message.length > 40000) return response(false, '这段讨论已经很长，请先生成并确认这一小片起点。', { reason: 'conversation-limit' });
    const controller = new AbortController(), startEpoch = epoch;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    creation.dialogue.messages.push({ id: randomUUID(), role: 'user', text: message.trim() });
    creation.dialogue.revision++; creation.dialogue.ready = false;
    active = { controller, startedAt: performance.now() }; model.pending = true; model.kind = 'discussion'; model.lastResult = null;
    const publish = progress => { model.progress = progress; try { onProgress?.(progress); } catch {} };
    publish({ phase: 'connecting', elapsedMs: 0, eventsReceived: 0, outputCharacters: 0, preview: '' });
    let result = { ok: false, reason: 'request-failed', message: '讨论没有完成，你的输入已保留。' };
    try {
      persist(); const { llm } = configLoader();
      const voxelBasis = voxel.state();
      const r = await callModel({ llm, messages: buildDiscussionMessages(creation.dialogue, creation.draft, creation.source, voxelBasis), fetchImpl, signal: controller.signal, onProgress: publish });
      appendFileSync(join(directory, 'model-calls.jsonl'), JSON.stringify({ role: 'world-discussion', ...r.audit })+'\n', { mode: 0o600 });
      if (controller.signal.aborted) result = { ok: false, reason: 'cancelled', message: '已停止回复，你的输入仍保留。' };
      else if (!r.ok) result = { ok: false, reason: r.audit.error?.code ?? 'request-failed', message: '这次回复未完成，可以继续发送消息；没有改变草稿。' };
      else if (epoch !== startEpoch) result = { ok: false, reason: 'stale-basis', message: '讨论起点已经变化，这次回复未采用。' };
      else {
        let value; try { value = parseGeneratedJSON(r.content).value; } catch {}
        if (!checkDiscussion(value)) result = { ok: false, reason: 'invalid-discussion', message: '回复格式不完整，请继续说明你的想法；没有据此生成世界。' };
        else if (value.commands?.length && voxelBasis.cells.length > 5000) result = { ok: false, reason: 'scene-too-large', message: '当前场景过大，无法完整提供给模型；这次没有修改场景。' };
        else {
          try { if (value.commands?.length) voxel.apply({ baseRevision: voxelBasis.revision, commands: value.commands }); }
          catch (error) { result = { ok: false, reason: 'invalid-building', message: `建造未完成：${error.message}` }; }
          if (result.reason !== 'invalid-building') {
            creation.dialogue.messages.push({ id: randomUUID(), role: 'assistant', text: value.reply.trim() });
            creation.dialogue.summary = value.summary.trim();
            creation.dialogue.ready = value.ready && creation.dialogue.messages.filter(m => m.role === 'user').length >= 2;
            result = { ok: true, message: value.reply.trim() };
          }
        }
      }
    } catch { result = { ok: false, reason: 'configuration-or-save-error', message: '回复或保存未完成，请检查模型连接与本地存储。' }; }
    finally { signal?.removeEventListener('abort', abort); active = null; model.pending = false; model.lastResult = result; creation.lastResult = result; persist(); }
    return { ...result, state: state() };
  };
  const worldStep = async ({ description, conversationRevision } = {}, { onProgress, signal } = {}) => {
    if (blocked() || creation.mode !== 'create') return response(false, '请先进入创建页并结束当前调用。', { reason: 'busy' });
    if (voxel.state().error) return response(false, voxel.state().error, { reason: 'voxel-recovery' });
    const conversational = creation.dialogue.messages.length > 0 || conversationRevision !== undefined;
    if (conversational) {
      if (!creation.dialogue.ready || conversationRevision !== creation.dialogue.revision) return response(false, '先把这一小片起点讨论清楚，再按当前设定生成。', { reason: 'discussion-required' });
      description = creation.dialogue.summary;
    }
    if (typeof description !== 'string' || !description.trim() || description.length > 8000) return response(false, '写下一段想要的世界，再开始创建。', { reason: 'invalid-description' });
    const controller = new AbortController(), startEpoch = epoch;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    // A new request must never leave an older draft looking like the failed result.
    const previousDraft = creation.draft?.definition;
    creation.draft = null;
    active = { controller, startedAt: performance.now() }; model.pending = true; model.kind = 'creation'; model.lastResult = null;
    const publish = p => { model.progress = p; try { onProgress?.(p); } catch { /* signal handles disconnect */ } };
    publish({ phase: 'connecting', elapsedMs: 0, eventsReceived: 0, outputCharacters: 0, preview: '' });
    let result = { ok: false, reason: 'request-failed', message: '创建世界没有完成，没有自动重试。' };
    try {
      persist(); const { llm } = configLoader();
      const records = [], adjustments = [];
      let definition = null, failed = false;
      for (const stage of GENESIS_STAGES) {
        if (controller.signal.aborted) { result = { ok: false, reason: 'cancelled', message: '创建世界已取消，现有世界保持原样。' }; failed = true; break; }
        const stageProgress = p => publish({ ...p, stageLabel: stage.label, elapsedMs: performance.now() - active.startedAt });
        stageProgress({ phase: 'connecting', outputCharacters: 0 });
        const r = await callModel({ llm, messages: buildGenesisMessages(description.trim(), {
          dialogue: conversational ? creation.dialogue : null, source: creation.source, previousDraft,
          diagnostics: creation.lastResult?.diagnostics ?? [], stage, previousRecords: records,
        }), fetchImpl, signal: controller.signal, onProgress: stageProgress });
        appendFileSync(join(directory, 'model-calls.jsonl'), JSON.stringify({ role: 'world-genesis', stage: stage.id, ...r.audit })+'\n', { mode: 0o600 });
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
            continue;
          } catch (error) { result = { ok: false, reason: 'invalid-json', message: error.message, diagnostics: [{ path: stage.id, message: error.message }] }; }
        }
        failed = true; break; // One attempt per step; never retry silently.
      }
      if (!failed) {
        publish({ ...model.progress, phase: 'verifying' });
        if (!definition) {
          try { definition = compileGenesisRecords(records); }
          catch (error) { result = { ok: false, reason: 'invalid-world', message: error.message, diagnostics: [{ path: 'world', message: error.message }] }; }
        }
        const checked = definition ? checkWorldCandidate(definition) : null;
        if (checked && !checked.ok) result = { ...checked, message: '生成结果未通过世界规则或三维场景检查，请调整想法后再试。' };
        else if (checked) {
          creation.draft = { id: randomUUID(), description: description.trim(), definition: checked.definition,
            baseVoxelId: creation.voxelId, baseVoxelRevision: voxel.state().revision,
            ...(conversational ? { baseConversationRevision: creation.dialogue.revision } : {}),
            adjustments: [...adjustments, ...checked.adjustments], privacyAudit: checked.privacyAudit, createdAt: new Date().toISOString() };
          result = { ok: true, message: '这一片起点已生成。看看画面和规律，可以继续告诉我哪里要改，满意后再进入。' };
          if (conversational) creation.dialogue.messages.push({ id: randomUUID(), role: 'assistant', text: result.message });
        }
      }
    } catch { result = { ok: false, reason: 'configuration-or-save-error', message: '创建世界的请求或保存未完成，请检查配置与本地存储；没有自动重试。' }; }
    finally { signal?.removeEventListener('abort', abort); active = null; model.pending = false; model.lastResult = result; creation.lastResult = result; persist(); }
    return { ...result, state: state() };
  };
  const delegate = name => async (body, options) => {
    if (active || creation.mode !== 'world' || !inner) return response(false, '先进入世界，再进行操作。');
    const result = await inner[name](body, options); return { ...result, state: state() };
  };
  return { state, control, discussStep, worldStep, actorStep: delegate('actorStep'), sceneStep: delegate('sceneStep'), cancelModel,
    close() { if (active) active.controller.abort(); inner?.close(); persist(); } };
}
