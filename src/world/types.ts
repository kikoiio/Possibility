// src/world/types.ts — 世界相关共享类型

/** 居民的在场状态 */
export interface Presence {
  location: string;
  activity: string;
  since: number;
}

/** 引擎维护的权威世界状态（快照持久化的对象） */
export interface WorldState {
  /** 上次心跳时刻（epoch ms） */
  lastTickTs: number;
  weather: string;
  season: string;
  residents: Record<string, Presence>;
  /** 本 tick 的世界事件（供居民感知） */
  pendingEvents: string[];
  /** 今日已产出独白的居民 id（防重复） */
  monologuedToday: Record<string, string>; // residentId → YYYY-MM-DD
  /** 今日已生成计划的居民 id */
  plannedToday: Record<string, string>; // residentId → YYYY-MM-DD
  /** 相遇对话冷却：pairKey(id1|id2) → 上次对话 ts */
  lastConverseTs: Record<string, number>;
}

/** cognition 感知世界的视图（assemble 的输入之一） */
export interface WorldView {
  localTime: string; // 例：2026-08-24 周一 14:30
  period: string; // 清晨/上午/午后/傍晚/夜晚
  weather: string;
  season: string;
  /** 当前居民所在地点 */
  location: string;
  /** 同地点的其他居民名字 */
  coPresent: string[];
  /** 本 tick 世界事件 */
  events: string[];
}
