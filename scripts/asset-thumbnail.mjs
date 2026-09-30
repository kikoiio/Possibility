#!/usr/bin/env node
// ── 缩略图子流程(S2a 模块 D)────────────────────
// spawn 临时 vite dev server + Playwright(swiftshader) 打开 /dev/asset-shot,
// 等 __assetShotReady 后对画布截图 512×512。被 asset-import.ts 调用,也可独立补生成。
// 用法:
//   node scripts/asset-thumbnail.mjs --glb /voxel-assets/library/models/<id>.glb --out web/public/voxel-assets/library/thumbnails/<id>.png
//   node scripts/asset-thumbnail.mjs --id veg-tree-a [--out <path>]

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { chromium } from 'playwright'

const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : null
}
const assetId = opt('id')
const glbUrl = opt('glb')
if (!assetId && !glbUrl) {
  console.error('用法:--id <assetId> 或 --glb <url-path>,加 --out <png 路径>')
  process.exit(2)
}
const outPath = resolve(opt('out') ?? `web/public/voxel-assets/library/thumbnails/${assetId}.png`)

const port = 16000 + (process.pid % 2000)
const base = `http://127.0.0.1:${port}`
const query = glbUrl ? `glb=${encodeURIComponent(glbUrl)}` : `asset=${encodeURIComponent(assetId)}`

const vite = spawn('npm', ['run', 'dev', '--', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: resolve('web'),
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true, // 进程组,便于整组清理
})
const killVite = () => { try { process.kill(-vite.pid, 'SIGTERM') } catch { /* 已退出 */ } }
process.on('exit', killVite)
process.on('SIGINT', () => { killVite(); process.exit(130) })

async function waitServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* 尚未就绪 */ }
    if (Date.now() > deadline) throw new Error(`vite dev server 启动超时:${url}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

let browser
try {
  await waitServer(base, 30_000)
  browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--no-sandbox'] })
  const page = await browser.newPage({ viewport: { width: 600, height: 600 } })
  await page.goto(`${base}/dev/asset-shot?${query}`)
  const result = await page.waitForFunction(() => window.__assetShotReady ?? false, null, { timeout: 30_000 })
  const ready = await result.jsonValue()
  if (ready !== true) {
    const detail = await page.locator('[data-testid="asset-shot-error"]').textContent().catch(() => null)
    throw new Error(`快照页渲染失败${detail ? `:${detail}` : ''}`)
  }
  mkdirSync(dirname(outPath), { recursive: true })
  await page.locator('[data-testid="asset-shot-canvas"]').screenshot({ path: outPath })
  console.log(`[asset-thumbnail] ${assetId ?? glbUrl} → ${outPath}`)
} catch (err) {
  console.error(`[asset-thumbnail] 失败:${err.message}`)
  process.exitCode = 1
} finally {
  await browser?.close().catch(() => {})
  killVite()
}
