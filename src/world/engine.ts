// src/world/engine.ts — tick 主流程：时钟 → 事件 → 居民 → 相遇 → 定时产出 → 发布 → 快照

import { decide, converse, monologue, type Action } from '../cognition/decide';
import { planDay } from '../cognition/plan';
import { getConfig, inSleepWindow, type Config } from '../config';
import type { Env } from '../env';
import { publishAll, type EntryCandidate } from '../feed/entries';
import type { LlmContext } from '../llm/client';
import { maybeReflect, write } from '../memory/store';
import { loadAll, type ResidentProfile } from '../persona/profile';
import { listMysteries, loadSnapshot, saveSnapshot } from '../store/db';
import { rollEvents } from './events';
import { advanceDaily, maybeAdvanceSeasonal, maybeSpawnDaily, markInvestigating } from './mystery';
import type { WorldState, WorldView } from './types';

const CONVERSE_COOLDOWN_MS = 2 * 3600 * 1000;

// ---------------------------------------------------------------------------
// 本地时间
// ---------------------------------------------------------------------------

export interface LocalNow {
  dateStr: string; // YYYY-MM-DD
  hhmm: string; // HH:MM
  hour: number;
  month: number;
  period: string; // 清晨/上午/午后/傍晚/夜晚/深夜
  localTime: string; // 展示用
}

export function localNow(timezone: string, now: number): LocalNow {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hourCycle: 'h23',
  });
  const parts = fmt.formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = parseInt(get('hour'), 10) % 24;
  const month = parseInt(get('month'), 10);
  const hhmm = `${String(hour).padStart(2, '0')}:${get('minute')}`;
  const dateStr = `${get('year')}-${get('month')}-${get('day')}`;

  const period =
    hour >= 5 && hour < 8 ? '清晨'
    : hour >= 8 && hour < 12 ? '上午'
    : hour >= 12 && hour < 17 ? '午后'
    : hour >= 17 && hour < 21 ? '傍晚'
    : hour >= 21 || hour < 1 ? '夜晚'
    : '深夜';

  return {
    dateStr,
    hhmm,
    hour,
    month,
    period,
    localTime: `${dateStr} ${get('weekday')} ${hhmm}`,
  };
}

function periodOf(config: Config, now: number): LocalNow {
  return localNow(config.timezone, now);
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function initialWorld(now: number, local: LocalNow): WorldState {
  return {
    lastTickTs: now,
    weather: '晴',
    season: local.month >= 3 && local.month <= 5 ? '春'
      : local.month >= 6 && local.month <= 8 ? '夏'
      : local.month >= 9 && local.month <= 11 ? '秋' : '冬',
    residents: {},
    pendingEvents: [],
    monologuedToday: {},
    plannedToday: {},
    lastConverseTs: {},
    lastActivityEntryTs: {},
  };
}

/** 当前时刻落在哪个作息块里（schedule 不跨零点） */
function currentScheduleBlock(
  profile: ResidentProfile,
  hhmm: string,
): { location: string; activity: string } | undefined {
  return profile.schedule.find((b) => b.start <= hhmm && hhmm < b.end);
}

function buildView(
  state: WorldState,
  profiles: ResidentProfile[],
  target: ResidentProfile,
  local: LocalNow,
): WorldView {
  const location = state.residents[target.id]?.location ?? target.home;
  const coPresent = profiles
    .filter((p) => p.id !== target.id && (state.residents[p.id]?.location ?? p.home) === location)
    .map((p) => p.name);
  return {
    localTime: local.localTime,
    period: local.period,
    weather: state.weather,
    season: state.season,
    location,
    coPresent,
    events: state.pendingEvents,
  };
}

function add30Minutes(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const total = (h! * 60 + m! + 30) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// tick
// ---------------------------------------------------------------------------

export interface TickResult {
  slept: boolean;
  entriesPublished: number;
  actions: Record<string, Action>;
  events: string[];
  rejectedProfiles: number;
}

export async function tick(
  env: Env,
  opts: { rng?: () => number; fetchImpl?: typeof fetch } = {},
): Promise<TickResult> {
  const db = env.DB;
  const config = await getConfig(env);
  const rng = opts.rng ?? Math.random;
  const ctx: LlmContext = {
    env: { DB: db, LLM_API_KEY: env.LLM_API_KEY },
    config,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  };

  const now = Date.now();
  const local = periodOf(config, now);

  const snap = await loadSnapshot(db);
  const state: WorldState = snap ? (snap.state as WorldState) : initialWorld(now, local);
  // 旧版本快照的字段兜底（新增字段随版本演进）
  state.pendingEvents ??= [];
  state.monologuedToday ??= {};
  state.plannedToday ??= {};
  state.lastConverseTs ??= {};
  state.lastActivityEntryTs ??= {};

  // 休眠窗口：世界暂停，仅推进 lastTickTs（AC1）
  if (inSleepWindow(config, local.hhmm)) {
    state.lastTickTs = now;
    await saveSnapshot(db, now, state);
    return { slept: true, entriesPublished: 0, actions: {}, events: [], rejectedProfiles: 0 };
  }

  // 居民档案（每 tick 从 D1 读，新增居民即时生效）
  const { profiles, rejected } = await loadAll(db);
  if (rejected.length > 0) {
    console.warn('档案拒载', rejected.map((r) => `${r.id}(${r.error.message})`).join('; '));
  }

  const candidates: EntryCandidate[] = [];

  // 1) 每日首个清醒 tick：为每位居民生成当日计划
  for (const p of profiles) {
    if (state.plannedToday[p.id] !== local.dateStr) {
      try {
        await planDay(ctx, p, buildView(state, profiles, p, local));
      } catch (e) {
        console.warn(`planDay 失败 ${p.id}`, e);
      }
      state.plannedToday[p.id] = local.dateStr;
    }
  }

  // 2) 世界事件
  const ev = await rollEvents(ctx, { weather: state.weather, season: state.season }, { month: local.month }, rng);
  state.weather = ev.weather;
  state.season = ev.season;
  state.pendingEvents = ev.events;

  // 3) 日常之谜生成
  try {
    const spawn = await maybeSpawnDaily(ctx, rng);
    if (spawn) candidates.push(spawn);
  } catch (e) {
    console.warn('谜团生成失败', e);
  }

  // 4) 居民循环：决策 → 裁决 → 记忆 → 动态候选（限频）
  const actions: Record<string, Action> = {};
  for (const p of profiles) {
    const presence = state.residents[p.id] ?? { location: p.home, activity: '在家', since: now };
    try {
      const block = currentScheduleBlock(p, local.hhmm);
      const scheduleHint = block
        ? `按你的作息，这个时段你通常在${block.location}（${block.activity}）。`
        : undefined;
      const action = await decide(
        ctx,
        p,
        buildView(state, profiles, p, local),
        presence.activity,
        scheduleHint,
      );
      actions[p.id] = action;
      state.residents[p.id] = { location: action.location, activity: action.activity, since: now };

      // 固定 salience=2（日常琐事），省一次评分调用
      await write(ctx, {
        residentId: p.id,
        kind: 'observation',
        content: `我在${action.location}${action.activity}。${action.remark}`,
        salience: 2,
        tags: `${action.location} 日常`,
      });

      // 动态条目限频：地点变了随时可发；原地不动则需过最小间隔（防重复刷屏）
      const moved = action.location !== presence.location;
      const intervalMs = config.activityEntryIntervalMinutes * 60_000;
      if (moved || now - (state.lastActivityEntryTs[p.id] ?? 0) >= intervalMs) {
        candidates.push({
          type: 'activity',
          residentIds: [p.id],
          location: action.location,
          content: `${p.name}在${action.location}${action.activity}。`,
          ts: now,
        });
      }

      if (action.action === 'investigate') {
        const spawned = (await listMysteries(db, 'spawned')).filter((m) => m.arc === 'daily');
        if (spawned[0]) await markInvestigating(db, spawned[0].id);
        const clue = await advanceDaily(ctx);
        if (clue) candidates.push(clue);
      }
    } catch (e) {
      console.warn(`decide 失败 ${p.id}`, e);
    }
  }

  // 5) 相遇对话（同地 ≥2 人，冷却 2 小时）
  const byLocation = new Map<string, ResidentProfile[]>();
  for (const p of profiles) {
    const location = state.residents[p.id]?.location ?? p.home;
    byLocation.set(location, [...(byLocation.get(location) ?? []), p]);
  }
  for (const [location, group] of byLocation) {
    if (group.length < 2) continue;
    const pairKey = group.map((p) => p.id).sort().join('|');
    if (now - (state.lastConverseTs[pairKey] ?? 0) < CONVERSE_COOLDOWN_MS) continue;
    try {
      const dialogue = await converse(ctx, [group[0]!, group[1]!], buildView(state, profiles, group[0]!, local));
      candidates.push({
        type: 'dialogue',
        residentIds: group.map((p) => p.id),
        location,
        content: dialogue.lines.map((l) => `${l.speaker}：${l.line}`).join('\n'),
      });
      state.lastConverseTs[pairKey] = now;
      for (const p of group) {
        const other = group.find((o) => o.id !== p.id)!;
        await write(ctx, {
          residentId: p.id,
          kind: 'dialogue',
          content: `我和${other.name}在${location}聊了天。${other.name}说：「${dialogue.lines.find((l) => l.speaker === other.name)?.line ?? ''}」`,
          salience: 3,
          tags: `${other.name} 对话`,
          subject: other.id,
        });
      }
    } catch (e) {
      console.warn('converse 失败', e);
    }
  }

  // 6) 独白（每日到点各一篇）
  if (local.hhmm >= config.monologueTimeLocal && local.hhmm < add30Minutes(config.monologueTimeLocal)) {
    for (const p of profiles) {
      if (state.monologuedToday[p.id] === local.dateStr) continue;
      try {
        const text = await monologue(ctx, p, buildView(state, profiles, p, local));
        candidates.push({
          type: 'monologue',
          residentIds: [p.id],
          location: state.residents[p.id]?.location ?? p.home,
          content: text,
        });
        state.monologuedToday[p.id] = local.dateStr;
        await write(ctx, {
          residentId: p.id,
          kind: 'event',
          content: `我写下了一段独白：「${text.slice(0, 60)}…」`,
          salience: 3,
          tags: '独白 今日',
        });
      } catch (e) {
        console.warn(`monologue 失败 ${p.id}`, e);
      }
    }
  }

  // 7) 季度之谜推进
  try {
    const seasonal = await maybeAdvanceSeasonal(ctx, profiles);
    if (seasonal) candidates.push(seasonal);
  } catch (e) {
    console.warn('季度之谜推进失败', e);
  }

  // 8) 反思（阈值触发）
  for (const p of profiles) {
    try {
      await maybeReflect(ctx, p.id);
    } catch (e) {
      console.warn(`maybeReflect 失败 ${p.id}`, e);
    }
  }

  // 9) 发布（护栏 + 激活率）→ 快照
  const { published, blocked } = await publishAll(db, candidates, {
    activationRate: config.activationRate,
    rng,
  });
  if (blocked.length > 0) {
    console.warn('护栏拦截', blocked.map((b) => b.reason).join('; '));
  }
  // 动态条目限频时间戳按实际发布更新
  for (const entry of published) {
    if (entry.type === 'activity' && entry.residentIds[0]) {
      state.lastActivityEntryTs[entry.residentIds[0]] = entry.ts;
    }
  }

  state.lastTickTs = now;
  await saveSnapshot(db, now, state);

  return {
    slept: false,
    entriesPublished: published.length,
    actions,
    events: ev.events,
    rejectedProfiles: rejected.length,
  };
}
