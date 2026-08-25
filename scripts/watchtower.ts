// scripts/watchtower.ts — 虚拟邻居监测程序（瞭望塔）
// 区分三种状态：活着（ALIVE）/ 按设计静默（QUIET）/ 真停了（STALLED 或 FAILING）
//
// 用法：
//   pnpm exec tsx scripts/watchtower.ts [baseUrl] [--expect-every-min 5] [--watch-min 2]
// 退出码：0 = 正常（含 QUIET）；1 = STALLED/FAILING（可接告警）
//
// 判定逻辑：
//   STALLED — 距上次心跳 > 3 × 期望间隔（cron 没跑或 tick 崩溃）
//   FAILING — 最近 10 次心跳里 ≥3 次带错误
//   QUIET   — 心跳正常但最新条目 > 65 分钟（限频下的正常静默）
//   ALIVE   — 心跳正常且信息流有新内容

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const baseUrl = (args.find((a) => !a.startsWith('--')) ?? 'http://localhost:8787').replace(/\/$/, '');
const flag = (name: string, def: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : def;
};
const expectEveryMin = flag('--expect-every-min', 5);
const watchMin = flag('--watch-min', 0);

function loadToken(): string {
  for (const line of readFileSync('.dev.vars', 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === 'ADMIN_TOKEN') return line.slice(i + 1).trim();
  }
  console.error('✗ .dev.vars 缺少 ADMIN_TOKEN');
  process.exit(1);
}
const token = loadToken();

const fmtAge = (ts: number) => `${Math.floor((Date.now() - ts) / 60000)} 分钟前`;
const fmtTime = (ts: number) =>
  new Date(ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

interface TickRow {
  ts: number;
  slept: boolean;
  entriesPublished: number;
  durationMs: number;
  error: string | null;
}

async function round(): Promise<number> {
  const auth = { Authorization: `Bearer ${token}` };
  const [now, timeline, tickLog, usage] = await Promise.all([
    fetch(`${baseUrl}/api/now`).then((r) => r.json() as Promise<{ localTime: string; period: string; weather: string; residents: { name: string; location: string; activity: string; since: number | null }[] }>),
    fetch(`${baseUrl}/api/timeline?limit=1`).then((r) => r.json() as Promise<{ entries: { ts: number; content: string }[] }>),
    fetch(`${baseUrl}/api/admin/tick-log?limit=20`, { headers: auth }).then((r) => r.json() as Promise<{ ticks: TickRow[] }>),
    fetch(`${baseUrl}/api/admin/usage/daily`, { headers: auth }).then((r) => r.json() as Promise<{ totals: { calls: number; estCost: number } }>),
  ]);

  const lastTick = tickLog.ticks[0];
  const lastEntry = timeline.entries[0];
  const tickAgeMin = lastTick ? (Date.now() - lastTick.ts) / 60000 : Infinity;
  const recentErrors = tickLog.ticks.slice(0, 10).filter((t) => t.error).length;

  let verdict: string;
  let code: number;
  if (tickAgeMin > expectEveryMin * 3) {
    verdict = `STALLED（上次心跳 ${lastTick ? fmtAge(lastTick.ts) : '从未'}，超过 ${expectEveryMin * 3} 分钟阈值）`;
    code = 1;
  } else if (recentErrors >= 3) {
    verdict = `FAILING（最近 10 次心跳 ${recentErrors} 次报错）`;
    code = 1;
  } else if (lastEntry && Date.now() - lastEntry.ts > 65 * 60000) {
    verdict = 'QUIET（心跳正常，信息流按限频静默中）';
    code = 0;
  } else {
    verdict = 'ALIVE';
    code = 0;
  }

  console.log(`\n[${fmtTime(Date.now())}] ${verdict}`);
  console.log(`  世界时间 ${now.localTime}（${now.period}，${now.weather}）`);
  for (const r of now.residents) {
    console.log(`  · ${r.name} @ ${r.location}：${r.activity.slice(0, 36)}${r.since ? `（${fmtAge(r.since)}）` : ''}`);
  }
  if (lastEntry) console.log(`  最新条目：${fmtAge(lastEntry.ts)}｜${lastEntry.content.split('\n')[0]!.slice(0, 40)}`);
  if (lastTick) {
    console.log(
      `  上次心跳：${fmtAge(lastTick.ts)}（${lastTick.slept ? '休眠' : `发布 ${lastTick.entriesPublished} 条`}，耗时 ${(lastTick.durationMs / 1000).toFixed(1)}s${lastTick.error ? `，错误：${lastTick.error}` : ''}）`,
    );
  }
  console.log(`  今日用量：${usage.totals.calls} 次调用，约 ¥${usage.totals.estCost.toFixed(3)}`);
  return code;
}

async function main(): Promise<void> {
  console.log(`监测目标：${baseUrl}（期望心跳间隔 ${expectEveryMin} 分钟）`);
  let code = await round();
  if (watchMin > 0) {
    console.log(`\n持续监测中，每 ${watchMin} 分钟一轮（Ctrl+C 退出）…`);
    setInterval(() => {
      round().catch((e) => console.error('监测轮询失败：', e));
    }, watchMin * 60000);
    return;
  }
  process.exit(code);
}

main().catch((e) => {
  console.error('✗ 监测失败：', e instanceof Error ? e.message : e);
  process.exit(1);
});
