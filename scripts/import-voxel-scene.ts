/**
 * 体素场景入库：out/voxel-scenes/mist-manor.json（rebuild-scenes-voxel 产物）
 * → world_scene_revisions 新修订 + world_scenes 当前版本推进 + demo_baselines 同步指向。
 * 直接写库（commitScene 对公共演示基线拒绝写入，这里是有意的策展操作）。
 * wrangler d1 execute 有 SQLITE_TOOBIG 语句长度限制，故直连 miniflare 的 sqlite 文件；
 * dev 服务器（引擎节拍）持有库，靠 busy_timeout + 重试避让。
 * 用法：`node --import tsx scripts/import-voxel-scene.ts [worldId]`
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { isSerializedVoxelSpaces } from '@possibility/voxel-contract'

const WORLD_ID = process.argv[2] ?? '8ff1a23f-f784-44d9-af6d-7a53d6d8dde6'
const BUNDLE_PATH = resolve('out/voxel-scenes/mist-manor.json')
const STATE_DIR = resolve('api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject')

async function hashText(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

/** 引擎节拍持续写库，最新 mtime 的数据文件即当前活库（metadata.sqlite 只有 alarm 表） */
function liveDatabaseFile(): string {
  const candidates = readdirSync(STATE_DIR)
    .filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite')
    .map((name) => ({ name, mtimeMs: statSync(join(STATE_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  if (!candidates.length) throw new Error(`未找到本地 D1 数据文件：${STATE_DIR}`)
  return join(STATE_DIR, candidates[0]!.name)
}

const document: unknown = JSON.parse(readFileSync(BUNDLE_PATH, 'utf8'))
if (!isSerializedVoxelSpaces(document)) throw new Error(`${BUNDLE_PATH} 不是多空间体素包，请先跑 rebuild-scenes-voxel.ts`)

const dbFile = liveDatabaseFile()
const db = new DatabaseSync(dbFile)
db.exec('PRAGMA busy_timeout = 30000')

const current = db.prepare('SELECT current_version AS version, theme_id AS themeId FROM world_scenes WHERE world_id = ?').get(WORLD_ID) as { version: number; themeId: string } | undefined
if (!current) throw new Error(`世界 ${WORLD_ID} 没有场景记录`)

const next = current.version + 1
const requestId = `voxel-rebuild-${WORLD_ID}-v${next}`
if (db.prepare('SELECT version FROM world_scene_revisions WHERE request_id = ?').get(requestId)) {
  console.log(`[import] 已存在 ${requestId}，跳过（幂等）`)
  process.exit(0)
}

// 与 scenes/repository.ts 的 hashStoredDocument 对齐：体素负载哈希 { document, version }
const contentHash = await hashText(JSON.stringify({ document, version: next }))
const now = new Date().toISOString()
const themeId = document.spaces[0]?.document.theme ?? 'mist-manor'

db.exec('BEGIN')
try {
  db.prepare(`INSERT INTO world_scene_revisions (id, world_id, version, parent_version, request_id, content_hash, document_json, summary, kind, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '体素场景重建入库', 'voxel-rebuild', ?)`)
    .run(crypto.randomUUID(), WORLD_ID, next, current.version, requestId, contentHash, JSON.stringify(document), now)
  const moved = db.prepare('UPDATE world_scenes SET current_version = ?, theme_id = ?, updated_at = ? WHERE world_id = ? AND current_version = ?')
    .run(next, themeId, now, WORLD_ID, current.version)
  if (moved.changes !== 1) throw new Error('world_scenes 版本推进失败（并发修改？）')
  db.prepare("UPDATE demo_baselines SET scene_version = ?, content_hash = ? WHERE world_id = ? AND status = 'active'")
    .run(next, contentHash, WORLD_ID)
  db.exec('COMMIT')
} catch (error) {
  db.exec('ROLLBACK')
  throw error
}
console.log(`[import] 体素场景已入库：世界 ${WORLD_ID} v${current.version} → v${next}（主题 ${themeId}，${document.spaces.length} 个空间，库文件 ${dbFile}）`)
