/**
 * 引擎节拍器（M8）：每 15 秒串行 POST /api/engine/tick，等待返回后再发起下一次。
 * 密钥解析顺序：process.env.ENGINE_TICK_SECRET → api/.dev.vars 同名键。
 * 用法：npm run dev:engine（通常经根目录 npm run dev 三进程启动）
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const API = process.env.ENGINE_API_URL ?? 'http://localhost:8787'
const INTERVAL_MS = 15_000
// 多世界多线的单拍可能超过 5 分钟（LLM 串行）；单飞机制保证不会重叠，409 时跳过本拍
const TICK_TIMEOUT_MS = 600_000

function resolveSecret(): string {
  if (process.env.ENGINE_TICK_SECRET) return process.env.ENGINE_TICK_SECRET
  try {
    // 脚本固定从仓库根目录启动（npm run dev / dev:engine）
    for (const line of readFileSync(resolve('api/.dev.vars'), 'utf8').split('\n')) {
      const m = line.match(/^\s*ENGINE_TICK_SECRET\s*=\s*(.+)\s*$/)
      if (m) return m[1].replace(/^["']|["']$/g, '')
    }
  } catch {
    // .dev.vars 不存在时走空密钥（会收到 403，提示语在下面打印）
  }
  return ''
}

const secret = resolveSecret()
if (!secret) {
  console.error('[engine] 缺少 ENGINE_TICK_SECRET：请在 api/.dev.vars 中配置（参考 .dev.vars.example），或设置同名环境变量')
  process.exit(1)
}

interface TickSummary {
  at: string
  worlds: {
    id: string
    capped: boolean
    tickCalls: number
    timelines: { id: string; simNow: string; steps: { kind: string; personId: string | null; ok: boolean; note?: string }[] }[]
  }[]
}

async function tick(): Promise<void> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TICK_TIMEOUT_MS)
  try {
    const res = await fetch(`${API}/api/engine/tick`, {
      method: 'POST',
      headers: { 'x-engine-secret': secret },
      signal: controller.signal,
    })
    if (!res.ok) {
      if (res.status === 409) {
        console.log('[engine] 上一拍仍在进行，跳过本拍')
        return
      }
      console.error(`[engine] tick 失败（${res.status}）：${(await res.text()).slice(0, 200)}`)
      return
    }
    const data = (await res.json()) as TickSummary
    const parts: string[] = []
    for (const w of data.worlds) {
      const steps = w.timelines.flatMap((t) => t.steps)
      const okCount = steps.filter((s) => s.ok).length
      const simNow = w.timelines[0]?.simNow?.slice(11, 19) ?? '--:--:--'
      parts.push(
        `世界 ${w.id.slice(0, 8)} simNow=${simNow} 调用=${w.tickCalls}${w.capped ? ' [已触顶]' : ''} 步骤=${okCount}/${steps.length}` +
          (steps.length
            ? `\n  ${steps
                .map((s) => `${s.ok ? '✓' : '✗'} ${s.kind}${s.note ? ` (${s.note})` : ''}`)
                .join(' | ')}`
            : ''),
      )
    }
    console.log(`[engine] ${new Date().toISOString().slice(11, 19)} tick ${parts.length ? parts.join('\n') : '（无运行中的世界）'}`)
  } catch (e) {
    console.error(`[engine] tick 异常：${e instanceof Error ? e.message : e}`)
  } finally {
    clearTimeout(timer)
  }
}

console.log(`[engine] 节拍器启动：${API}，每 ${INTERVAL_MS / 1000}s 一拍（串行）`)
for (;;) {
  const start = Date.now()
  await tick()
  const elapsed = Date.now() - start
  await new Promise((r) => setTimeout(r, Math.max(1000, INTERVAL_MS - elapsed)))
}
