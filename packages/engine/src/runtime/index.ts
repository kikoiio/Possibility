import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type {
  CallSummary,
  ConfirmPayload,
  Draft,
  EditProposal,
  EpochMs,
  LogEntry,
  Memory,
  Plan,
  RendererView,
  Revision,
  SseEvent,
  StateSnapshot,
  WorldLine,
  WorldState,
} from '@wispiva/contract';
import { SCHEMA_VERSION } from '@wispiva/contract';
import {
  applyDraft,
  applyOps,
  validateMemories,
  validatePlan,
} from '../domain/index.js';
import { createClockState, dueEvents, sampleClock, type LineClockState } from '../clock/index.js';
import type { BeatInput, EditInput, LlmGateway, LlmSettings } from '../llm/index.js';
import { openStore, type StoreApi } from '../store/index.js';
import type { Store } from '../store/index.js';

export type Projection = (world: WorldState, worldTimeMinutes: number, revisionId: string, recentText: string | null) => { view: RendererView } | { scene: unknown; view: RendererView };

export type RuntimeOptions = {
  store: StoreApi;
  gateway: LlmGateway;
  settings: LlmSettings;
  projectWorld: Projection;
  now?: () => EpochMs;
  createId?: (prefix: string) => string;
  writeSettings?: (settings: LlmSettings) => Promise<void>;
  retryDelayMs?: number;
};

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

function toLogEntry(revision: Revision): LogEntry {
  const { world: _world, ...entry } = revision;
  return entry;
}

function callSummary(id: string, kind: CallSummary['kind'], lineId: string, status: CallSummary['status'], error?: string): CallSummary {
  return { id, kind, lineId, status, ...(error === undefined ? {} : { error }) };
}

export class Runtime {
  readonly events = new EventEmitter();
  readonly store: StoreApi;
  private readonly gateway: LlmGateway;
  private settings: LlmSettings;
  private readonly projectWorld: Projection;
  private readonly now: () => EpochMs;
  private readonly createId: (prefix: string) => string;
  private readonly writeSettings: ((settings: LlmSettings) => Promise<void>) | undefined;
  private readonly retryDelayMs: number;
  private readonly clocks = new Map<string, LineClockState>();
  private readonly proposals = new Map<string, EditProposal>();
  private readonly activeBeats = new Map<string, Promise<void>>();

  constructor(options: RuntimeOptions) {
    this.store = options.store;
    this.gateway = options.gateway;
    this.settings = options.settings;
    this.projectWorld = options.projectWorld;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? id;
    this.writeSettings = options.writeSettings;
    this.retryDelayMs = options.retryDelayMs ?? 60_000;
  }

  async tick(): Promise<void> {
    for (const line of await this.store.listLines()) {
      const clock = this.clocks.get(line.id) ?? createClockState(line.id, {
        speed: line.speed,
        paused: line.paused,
        anchorWallMs: this.now(),
        anchorWorldMinutes: line.worldTimeMinutes,
      });
      const sampled = sampleClock({ ...clock, speed: line.speed, paused: line.paused }, this.now());
      this.clocks.set(line.id, sampled.state);
      const sampledWorldTime = sampled.state.anchorWorldMinutes;
      const elapsed = sampled.newMinutes.length > 0;
      let current = line;
      if (elapsed && sampledWorldTime !== line.worldTimeMinutes) {
        current = { ...line, worldTimeMinutes: sampledWorldTime };
        const due = dueEvents(line.plan, sampledWorldTime);
        if (due.length > 0) {
          await this.commitDueEvents(line, due, sampledWorldTime);
          current = (await this.store.getLine(line.id))!;
          this.clocks.set(line.id, sampled.state);
        } else {
          await this.store.updateLine(line.id, { worldTimeMinutes: sampledWorldTime });
          this.emitLine(current);
        }
      }
      if (!current.paused && current.plan === null && current.status !== 'generating' &&
          (current.status !== 'error' || this.now() >= current.retryAt)) {
        this.launchBeat(current);
      }
    }
  }

  async getState(): Promise<StateSnapshot> {
    const lines = await this.store.listLines();
    const views: StateSnapshot['views'] = {};
    const recentLogs: StateSnapshot['recentLogs'] = {};
    for (const line of lines) {
      const [revision, page] = await Promise.all([
        this.store.getRevision(line.headRevisionId),
        this.store.pageLog(line.id, { limit: 12 }),
      ]);
      if (!revision) continue;
      views[line.id] = this.projectWorld(revision.world, line.worldTimeMinutes, revision.id, revision.event.text).view;
      recentLogs[line.id] = page.entries;
    }
    return { schemaVersion: SCHEMA_VERSION, lines, views, recentLogs };
  }

  getLog(lineId: string, beforeRevisionId?: string, limit = 50) {
    return this.store.pageLog(lineId, { ...(beforeRevisionId ? { beforeRevisionId } : {}), limit });
  }

  async updateSettings(patch: Partial<LlmSettings>): Promise<void> {
    const next = { ...this.settings, ...patch, models: patch.models ? [...patch.models] : [...this.settings.models] };
    await this.writeSettings?.(next);
    Object.assign(this.settings, next);
  }

  async createDraft(lineId?: string): Promise<Draft> {
    const line = lineId ? await this.requireLine(lineId) : null;
    const revision = line ? await this.store.getRevision(line.headRevisionId) : null;
    if (line && !revision) throw new Error(`Head revision not found: ${line.headRevisionId}`);
    const draft: Draft = {
      id: this.createId('draft'),
      lineId: line?.id ?? null,
      baseRevisionId: line?.headRevisionId ?? null,
      worldTimeMinutes: line?.worldTimeMinutes ?? 0,
      speed: line?.speed ?? 24,
      paused: line?.paused ?? false,
      world: revision?.world ?? { entities: {} },
      createdAt: this.now(),
    };
    await this.store.createDraft(draft);
    return draft;
  }

  async editDraft(draftId: string, prompt: string): Promise<EditProposal> {
    const draft = await this.store.getDraft(draftId);
    if (!draft) throw new Error(`Draft not found: ${draftId}`);
    const input: EditInput = {
      lineId: draft.lineId ?? `draft:${draft.id}`,
      baseRevisionId: draft.baseRevisionId ?? draft.id,
      draftId: draft.id,
      worldTimeMinutes: draft.worldTimeMinutes,
      world: draft.world,
      prompt,
    };
    const proposal = await this.gateway.edit(input);
    if (proposal.draftId !== draft.id || proposal.baseRevisionId !== input.baseRevisionId) throw new Error('Edit proposal does not match its draft base.');
    const applied = applyDraft(draft.world, proposal.ops);
    const diagnostics = validateMemories(applied.world, proposal.memories);
    if (diagnostics.length) throw new Error(diagnostics.map((item) => item.message).join('；'));
    const checked = { ...proposal, changedPaths: applied.changes };
    this.proposals.set(checked.proposalId, checked);
    const call = await this.store.getCall(checked.proposalId);
    if (call) this.emit({ type: 'call', data: callSummary(call.id, call.kind, call.lineId, call.status, call.error) });
    return checked;
  }

  async confirm(payload: ConfirmPayload): Promise<WorldLine> {
    const draft = await this.store.getDraft(payload.draftId);
    const proposal = this.proposals.get(payload.proposalId);
    if (!draft || !proposal || proposal.draftId !== draft.id) throw new Error('Draft or edit proposal not found.');
    const applied = applyDraft(draft.world, proposal.ops);
    const revisionId = this.createId('rev');
    const eventId = this.createId('evt');
    const revision: Revision = {
      id: revisionId,
      parentId: draft.baseRevisionId,
      worldTimeMinutes: draft.worldTimeMinutes,
      event: {
        id: eventId,
        kind: 'edit',
        text: payload.ifText,
        ops: proposal.ops,
        changes: applied.changes,
        memories: proposal.memories.map((memory) => ({ ...memory, sourceEventId: eventId })),
        callId: proposal.proposalId,
        atMinutes: draft.worldTimeMinutes,
      },
      world: applied.world,
    };
    const lineId = this.createId('line');
    const line: WorldLine = {
      id: lineId,
      name: payload.name ?? await this.nextLineName(),
      parentLineId: draft.lineId,
      forkRevisionId: draft.baseRevisionId,
      forkTimeMinutes: draft.lineId === null ? null : draft.worldTimeMinutes,
      headRevisionId: draft.baseRevisionId ?? revision.id,
      worldTimeMinutes: draft.worldTimeMinutes,
      speed: draft.speed,
      paused: draft.paused,
      plan: null,
      status: 'ready',
      error: null,
      retryAt: 0,
    };
    await this.store.transaction(async (tx) => {
      await tx.createLine(line);
      await tx.appendRevisions(line.id, [revision]);
      await tx.appendMemories(line.id, proposal.memories, eventId);
      await tx.deleteDraft(draft.id);
    });
    line.headRevisionId = revision.id;
    this.proposals.delete(payload.proposalId);
    this.emit({ type: 'revision', data: { lineId, entry: toLogEntry(revision) } });
    this.emitLine(line);
    return line;
  }

  async control(input: { lineId: string; speed?: number; paused?: boolean; name?: string; retry?: boolean }): Promise<WorldLine> {
    const line = await this.requireLine(input.lineId);
    const patch: Partial<Pick<WorldLine, 'speed' | 'paused' | 'name' | 'status' | 'error' | 'retryAt'>> = {};
    if (input.speed !== undefined) {
      if (!Number.isFinite(input.speed) || input.speed < 0) throw new Error('speed must be a non-negative finite number.');
      patch.speed = input.speed;
    }
    if (input.paused !== undefined) patch.paused = input.paused;
    if (input.name !== undefined) patch.name = input.name;
    if (input.retry && line.status === 'error') Object.assign(patch, { status: 'ready', error: null, retryAt: 0 });
    const next = { ...line, ...patch };
    await this.store.transaction(async (tx) => tx.updateLine(line.id, patch));
    this.clocks.set(line.id, { ...this.clocks.get(line.id) ?? createClockState(line.id, { anchorWorldMinutes: line.worldTimeMinutes, anchorWallMs: this.now() }),
      speed: next.speed, paused: next.paused, anchorWallMs: this.now() });
    this.emitLine(next);
    if (input.retry && next.status === 'ready' && !next.paused && next.plan === null) this.launchBeat(next);
    return next;
  }

  subscribe(listener: (event: SseEvent) => void): () => void {
    this.events.on('event', listener);
    return () => this.events.off('event', listener);
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.activeBeats.values());
    await this.store.close();
  }

  private launchBeat(line: WorldLine): void {
    if (this.activeBeats.has(line.id)) return;
    const task = this.generateBeat(line).finally(() => this.activeBeats.delete(line.id));
    this.activeBeats.set(line.id, task);
  }

  private async generateBeat(line: WorldLine): Promise<void> {
    const baseRevision = await this.store.getRevision(line.headRevisionId);
    if (!baseRevision) return;
    await this.store.updateLine(line.id, { status: 'generating', error: null });
    this.emitLine({ ...line, status: 'generating', error: null });
    let result: { plan: Plan; callId: string } | undefined;
    try {
      const recent = await this.store.pageLog(line.id, { limit: 12 });
      const owners = Object.entries(baseRevision.world.entities)
        .filter(([, entity]) => entity.kind === 'character')
        .map(([owner]) => owner);
      const [memoryRows, reflections] = await Promise.all([
        this.store.getMemories(line.id, owners, 100),
        Promise.all(owners.map((owner) => this.store.getReflection(line.id, owner))),
      ]);
      const input: BeatInput = {
        lineId: line.id,
        baseRevisionId: line.headRevisionId,
        world: baseRevision.world,
        recentEvents: recent.entries,
        memoryRows,
        reflections: reflections.filter((reflection) => reflection !== null),
        worldTimeMinutes: line.worldTimeMinutes,
      };
      result = await this.gateway.beat(input);
      const latest = await this.requireLine(line.id);
      const call = await this.store.getCall(result.callId);
      if (latest.headRevisionId !== line.headRevisionId || latest.paused) {
        if (call) {
          await this.store.updateCall(result.callId, { status: 'discarded', finishedAt: this.now() });
          this.emit({ type: 'call', data: callSummary(call.id, call.kind, call.lineId, 'discarded') });
        }
        await this.store.updateLine(line.id, { status: 'ready', error: null, retryAt: 0 });
        this.emitLine({ ...latest, status: 'ready', error: null, retryAt: 0 });
        return;
      }
      const diagnostics = result.plan.fromMinutes === line.worldTimeMinutes
        ? validatePlan(baseRevision.world, result.plan)
        : [{ message: 'fromMinutes 必须等于基准 worldTimeMinutes。' }];
      if (diagnostics.length > 0) throw new Error(diagnostics.map((item) => item.message).join('；'));
      const acceptedPlan = { ...result.plan, callId: result.callId };
      await this.store.transaction(async (tx) => {
        await tx.updateLine(line.id, { plan: acceptedPlan, status: 'ready', error: null, retryAt: 0 });
        if (call) await tx.updateCall(result!.callId, { status: 'accepted', finishedAt: this.now() });
      });
      this.emitLine({ ...latest, plan: acceptedPlan, status: 'ready', error: null, retryAt: 0 });
      this.emit({ type: 'call', data: callSummary(result.callId, 'beat', line.id, 'accepted') });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const retryAt = this.now() + this.retryDelayMs;
      const latest = await this.requireLine(line.id);
      await this.store.updateLine(line.id, { status: 'error', error: message, retryAt });
      this.emitLine({ ...latest, status: 'error', error: message, retryAt });
      const callId = result?.callId;
      if (callId) {
        const call = await this.store.getCall(callId);
        if (call?.status !== 'failed') await this.store.updateCall(callId, { status: 'failed', error: message, finishedAt: this.now() });
        this.emit({ type: 'call', data: callSummary(callId, 'beat', line.id, 'failed', message) });
      }
    }
  }

  private async commitDueEvents(line: WorldLine, due: Plan['events'], sampledWorldTime: number): Promise<void> {
    if (!line.plan) return;
    const base = await this.store.getRevision(line.headRevisionId);
    if (!base) throw new Error(`Head revision not found: ${line.headRevisionId}`);
    let world = base.world;
    let parentId = base.id;
    const revisions: Revision[] = [];
    const dueIds = new Set(due.map((event) => event.id));
    for (const event of due) {
      const applied = applyOps(world, event.ops);
      world = applied.world;
      const memories: Memory[] = event.memories.map((memory) => ({ ...memory, sourceEventId: event.id }));
      revisions.push({
        id: this.createId('rev'),
        parentId,
        worldTimeMinutes: event.atMinutes,
        event: { id: event.id, kind: 'story', text: event.text, ops: event.ops, memories, callId: line.plan.callId, atMinutes: event.atMinutes },
        world,
      });
      parentId = revisions.at(-1)!.id;
    }
    const remaining = line.plan.events.filter((event) => !dueIds.has(event.id));
    const last = revisions.at(-1)!;
    await this.store.transaction(async (tx) => {
      await tx.appendRevisions(line.id, revisions);
      for (const revision of revisions) {
        const memories = revision.event.memories ?? [];
        if (memories.length) await tx.appendMemories(line.id, memories, revision.event.id);
      }
      await tx.updateLine(line.id, { worldTimeMinutes: sampledWorldTime, plan: remaining.length ? { ...line.plan!, events: remaining } : null, status: 'ready', error: null, retryAt: 0 });
    });
    for (const revision of revisions) this.emit({ type: 'revision', data: { lineId: line.id, entry: toLogEntry(revision) } });
    this.emitLine({ ...line, headRevisionId: last.id, worldTimeMinutes: sampledWorldTime, plan: remaining.length ? { ...line.plan, events: remaining } : null, status: 'ready', error: null, retryAt: 0 });
  }

  private async requireLine(id: string): Promise<WorldLine> {
    const line = await this.store.getLine(id);
    if (!line) throw new Error(`Line not found: ${id}`);
    return line;
  }

  private async nextLineName(): Promise<string> {
    const names = new Set((await this.store.listLines()).map((line) => line.name));
    const candidates = ['α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'ι', 'κ'];
    return candidates.find((name) => !names.has(name)) ?? `线 ${names.size + 1}`;
  }

  private emitLine(line: WorldLine): void {
    this.emit({ type: 'line', data: line });
  }

  private emit(event: SseEvent): void {
    this.events.emit('event', event);
  }
}

export async function startRuntime(options: Omit<RuntimeOptions, 'store'> & { storePath: string }): Promise<Runtime> {
  const store: Store = await openStore(options.storePath);
  return new Runtime({ ...options, store });
}
