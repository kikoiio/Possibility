// src/llm/usage.ts — LLM 用量按天统计

import { usageByDay, type UsageSummaryRow } from '../store/db';

export interface DailyUsageReport {
  day: string; // YYYY-MM-DD（按传入时区）
  rows: UsageSummaryRow[];
  totals: {
    calls: number;
    tokensIn: number;
    tokensOut: number;
    estCost: number;
  };
}

/**
 * 生成某天的用量日报。day 为 YYYY-MM-DD，按 UTC+offset 切天
 * （本期固定用 +08:00，与默认时区一致；时区可配置化是后续项）。
 */
export async function dailyReport(db: D1Database, day: string): Promise<DailyUsageReport> {
  const start = Date.parse(`${day}T00:00:00+08:00`);
  const end = start + 24 * 3600 * 1000;
  const rows = await usageByDay(db, start, end);
  const totals = rows.reduce(
    (acc, r) => ({
      calls: acc.calls + r.calls,
      tokensIn: acc.tokensIn + r.tokensIn,
      tokensOut: acc.tokensOut + r.tokensOut,
      estCost: acc.estCost + r.estCost,
    }),
    { calls: 0, tokensIn: 0, tokensOut: 0, estCost: 0 },
  );
  return { day, rows, totals };
}
