/**
 * 种子脚本：调用本地 Worker 的 dev-only 路由，创建 admin 与可选的随机测试账号。
 * 用法：npm run seed            —— 仅确保 admin 存在
 *       npm run seed -- --random 3 —— admin + 3 个随机账号（打印凭据）
 * 前提：api 已在本地运行（npm run dev:api）。
 */

const args = process.argv.slice(2)
let random = 0
const i = args.indexOf('--random')
if (i >= 0) {
  random = Number.parseInt(args[i + 1] ?? '0', 10) || 0
}

const res = await fetch('http://localhost:8787/api/dev/seed', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ random }),
})

if (!res.ok) {
  console.error(`seed 失败（${res.status}）：${await res.text()}`)
  console.error('请确认 api 正在运行：npm run dev:api')
  process.exit(1)
}

const data = (await res.json()) as { accounts: { username: string; password?: string; note?: string }[] }
console.log('seed 完成，账号列表：')
for (const acc of data.accounts) {
  const credentials = acc.password ? `${acc.username} / ${acc.password}` : acc.username
  console.log(`  ${credentials}${acc.note ? `（${acc.note}）` : ''}`)
}

export {}
