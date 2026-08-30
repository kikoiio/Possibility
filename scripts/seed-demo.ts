/**
 * 演示世界「雾影庄」种子脚本：调用本地 Worker 的 dev-only 路由（幂等）。
 * 用法：npm run seed:demo
 * 前提：api 已在本地运行（npm run dev:api），且已执行 npm run seed（需要 admin）。
 */

const res = await fetch('http://localhost:8787/api/dev/seed-demo', { method: 'POST' })

if (!res.ok) {
  console.error(`seed:demo 失败（${res.status}）：${await res.text()}`)
  console.error('请确认 api 正在运行：npm run dev:api，且已执行 npm run seed')
  process.exit(1)
}

const data = (await res.json()) as { created: boolean; worldId: string; persons: number; note?: string }
console.log(
  data.created
    ? `雾影庄创建完成：worldId=${data.worldId}，${data.persons} 个人物已入住`
    : `雾影庄已存在（${data.note ?? ''}）：worldId=${data.worldId}`,
)

export {}
