/**
 * 阶段二数据迁移脚本：调用本地 Worker 的 dev-only 路由（幂等，可重跑）。
 * 用法：npm run migrate:p2
 * 前提：api 已在本地运行（npm run dev:api）。
 */

const res = await fetch('http://localhost:8787/api/dev/migrate-p2', { method: 'POST' })

if (!res.ok) {
  console.error(`migrate:p2 失败（${res.status}）：${await res.text()}`)
  console.error('请确认 api 正在运行：npm run dev:api')
  process.exit(1)
}

const data = (await res.json()) as {
  worldsUpdated: number
  details: { locations: number; callsDay: number; status: number }
}
console.log(
  `迁移完成：更新世界 ${data.worldsUpdated} 个（补地点 ${data.details.locations}、补 callsDay ${data.details.callsDay}、修 status ${data.details.status}）`,
)

export {}
