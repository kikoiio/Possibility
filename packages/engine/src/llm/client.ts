import type {
  ChatMessage,
  EditProposal,
  EpochMs,
  LlmCall,
  Minutes,
  Plan,
} from '@wispiva/contract';
import { assembleBeatMessages, type BeatInput } from './assemble.js';

export type EditInput = {
  lineId: string;
  baseRevisionId: string;
  draftId: string;
  worldTimeMinutes: Minutes;
  world: BeatInput['world'];
  prompt: string;
};

export interface LlmSettings {
  models: string[];
  baseUrl: string;
  apiKey: string;
  segmentWorldMinutes: number;
  minIntervalSeconds: number;
  hourlyLimit: number;
  dailyLimit: number;
  concurrency: number;
}

export interface LlmGateway {
  beat(input: BeatInput): Promise<{ plan: Plan; callId: string }>;
  edit(input: EditInput): Promise<EditProposal>;
}

export interface CallAuditStore {
  createCall(call: LlmCall): Promise<void>;
  updateCall(id: string, patch: Partial<Pick<LlmCall, 'status' | 'attempts' | 'usage' | 'error' | 'finishedAt'>>): Promise<void>;
}

export class BudgetExhaustedError extends Error {
  constructor(readonly reason: 'hourly' | 'daily' | 'concurrency') {
    super(`LLM ${reason} budget exhausted.`);
    this.name = 'BudgetExhaustedError';
  }
}

type GatewayOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  createId?: () => string;
  requestTimeoutMs?: number;
  contextBudgetTokens?: number;
};

type Ledger = { starts: number[]; active: number; lastRequestAt: number };
const globalLedger: Ledger = { starts: [], active: 0, lastRequestAt: 0 };
const FALLBACK_STATUSES = new Set([404, 429, 503]);

function responseContent(data: unknown): { content: string; usage?: LlmCall['usage'] } {
  if (typeof data !== 'object' || data === null) throw new Error('Invalid OpenAI-compatible response.');
  const choices = (data as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) throw new Error('Response has no choices.');
  const message = (choices[0] as { message?: { content?: unknown } }).message;
  if (!message || typeof message.content !== 'string') throw new Error('Response choice has no text content.');
  const rawUsage = (data as { usage?: Record<string, unknown> }).usage;
  const usage = rawUsage ? {
    ...(typeof rawUsage.prompt_tokens === 'number' ? { promptTokens: rawUsage.prompt_tokens } : {}),
    ...(typeof rawUsage.completion_tokens === 'number' ? { completionTokens: rawUsage.completion_tokens } : {}),
    ...(typeof rawUsage.total_tokens === 'number' ? { totalTokens: rawUsage.total_tokens } : {}),
  } : undefined;
  return { content: message.content, usage };
}

function parseJson<T>(content: string): T {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed) as T;
}

function retryAfterMs(response: Response, now: number): number {
  const raw = response.headers.get('retry-after');
  if (!raw) return 0;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

function makeId(): string {
  return `call_${globalThis.crypto.randomUUID()}`;
}

export class OpenAiLlmGateway implements LlmGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly createId: () => string;
  private readonly requestTimeoutMs: number;
  private readonly contextBudgetTokens: number;

  constructor(
    private readonly settings: LlmSettings,
    private readonly store: CallAuditStore,
    options: GatewayOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.createId = options.createId ?? makeId;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.contextBudgetTokens = options.contextBudgetTokens ?? 16_000;
  }

  async beat(input: BeatInput): Promise<{ plan: Plan; callId: string }> {
    const callId = this.createId();
    const messages = assembleBeatMessages(input, this.contextBudgetTokens);
    const result = await this.call('beat', input.lineId, input.baseRevisionId, input.worldTimeMinutes, messages, callId);
    const plan = await this.parseAudited<Plan>(callId, result.content);
    return { plan: { ...plan, callId }, callId };
  }

  async edit(input: EditInput): Promise<EditProposal> {
    const callId = this.createId();
    const messages: ChatMessage[] = [
      { role: 'system', content: '依据草稿提出 JSON 编辑提议。只返回 EditProposal JSON。' },
      { role: 'user', content: JSON.stringify({ draftId: input.draftId, baseRevisionId: input.baseRevisionId, world: input.world, prompt: input.prompt }) },
    ];
    const result = await this.call('edit', input.lineId, input.baseRevisionId, input.worldTimeMinutes, messages, callId);
    const proposal = await this.parseAudited<EditProposal>(callId, result.content);
    return { ...proposal, proposalId: callId, draftId: input.draftId, baseRevisionId: input.baseRevisionId };
  }

  private pruneBudget(now: number): void {
    while (globalLedger.starts.length && now - globalLedger.starts[0]! >= 86_400_000) globalLedger.starts.shift();
  }

  private async parseAudited<T>(callId: string, content: string): Promise<T> {
    try {
      return parseJson<T>(content);
    } catch (error) {
      await this.store.updateCall(callId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: this.now(),
      });
      throw error;
    }
  }

  private async acquire(): Promise<void> {
    while (true) {
      const current = this.now();
      this.pruneBudget(current);
      const dailyStarts = globalLedger.starts.length;
      const hourlyStarts = globalLedger.starts.filter((at) => current - at < 3_600_000).length;
      if (dailyStarts >= this.settings.dailyLimit) throw new BudgetExhaustedError('daily');
      if (hourlyStarts >= this.settings.hourlyLimit) throw new BudgetExhaustedError('hourly');
      if (globalLedger.active >= this.settings.concurrency) {
        await this.sleep(10);
        continue;
      }
      const intervalLeft = globalLedger.lastRequestAt === 0
        ? 0
        : this.settings.minIntervalSeconds * 1000 - (current - globalLedger.lastRequestAt);
      if (intervalLeft > 0) {
        await this.sleep(intervalLeft);
        continue;
      }
      globalLedger.active += 1;
      globalLedger.starts.push(current);
      globalLedger.lastRequestAt = current;
      return;
    }
  }

  private async waitForNextRequest(delay = 0): Promise<void> {
    const retryAt = this.now() + delay;
    while (true) {
      const current = this.now();
      this.pruneBudget(current);
      if (globalLedger.starts.length >= this.settings.dailyLimit) throw new BudgetExhaustedError('daily');
      if (globalLedger.starts.filter((at) => current - at < 3_600_000).length >= this.settings.hourlyLimit) {
        throw new BudgetExhaustedError('hourly');
      }
      const intervalAt = globalLedger.lastRequestAt + this.settings.minIntervalSeconds * 1000;
      const waitMs = Math.max(0, retryAt - current, intervalAt - current);
      if (waitMs > 0) {
        await this.sleep(waitMs);
        continue;
      }
      globalLedger.starts.push(current);
      globalLedger.lastRequestAt = current;
      return;
    }
  }

  private async call(
    kind: 'beat' | 'edit',
    lineId: string,
    baseRevisionId: string,
    startMinutes: number,
    messages: ChatMessage[],
    callId: string,
  ): Promise<{ content: string }> {
    await this.acquire();
    const startedAt = this.now() as EpochMs;
    const attempts: LlmCall['attempts'] = [];
    const call: LlmCall = {
      id: callId, kind, lineId, baseRevisionId, startMinutes, status: 'pending', messages,
      attempts, startedAt,
    };
    try {
      await this.store.createCall(call);
      let lastError = 'No candidate model completed the request.';
      for (let index = 0; index < this.settings.models.length; index += 1) {
        const model = this.settings.models[index]!;
        const body = JSON.stringify({ model, messages });
        const requestStarted = this.now();
        let response: Response;
        let raw = '';
        let status = 0;
        try {
          response = await this.fetchImpl(`${this.settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${this.settings.apiKey}` },
            body,
            signal: AbortSignal.timeout(this.requestTimeoutMs),
          });
          status = response.status;
          raw = await response.text();
          attempts.push({ model, status, latencyMs: this.now() - requestStarted, raw, request: body });
          await this.store.updateCall(callId, { attempts: [...attempts] });
          if (!response.ok) {
            lastError = `HTTP ${status}: ${raw}`;
            if (FALLBACK_STATUSES.has(status) && index + 1 < this.settings.models.length) {
              await this.waitForNextRequest(status === 429 ? retryAfterMs(response, this.now()) : 0);
              continue;
            }
            break;
          }
          const parsed = responseContent(JSON.parse(raw) as unknown);
          await this.store.updateCall(callId, {
            status: 'accepted', attempts: [...attempts],
            ...(parsed.usage ? { usage: parsed.usage } : {}),
            finishedAt: this.now(),
          });
          return { content: parsed.content };
        } catch (error) {
          if (error instanceof BudgetExhaustedError) throw error;
          if (attempts.length === 0 || attempts[attempts.length - 1]?.request !== body) {
            attempts.push({ model, status, latencyMs: this.now() - requestStarted, raw, request: body });
            await this.store.updateCall(callId, { attempts: [...attempts] });
          }
          lastError = error instanceof Error ? error.message : String(error);
          break;
        }
      }
      throw new Error(lastError);
    } catch (error) {
      await this.store.updateCall(callId, {
        status: 'failed', attempts: [...attempts], error: error instanceof Error ? error.message : String(error), finishedAt: this.now(),
      });
      throw error;
    } finally {
      globalLedger.active -= 1;
    }
  }
}
