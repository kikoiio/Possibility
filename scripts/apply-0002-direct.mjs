/**
 * 一次性迁移辅助（T1）：直接打开本地 D1 状态文件执行 worlds 表重建。
 * 原因：miniflare 的 D1 持久层在任何 PRAGMA 下都强制即时 FK 校验，
 * DROP TABLE worlds（被 timelines 等引用）经 wrangler 走不通；
 * 直接操作 SQLite 文件时 FK 默认关闭，重建后状态一致性由脚本自查保证。
 * 用法：node scripts/apply-0002-direct.mjs（确保 wrangler dev 未运行）
 */
import { DatabaseSync } from 'node:sqlite'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const stateDir = fileURLToPath(new URL('../api/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/', import.meta.url))
const file = readdirSync(stateDir).find((f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite')
if (!file) throw new Error('未找到 D1 状态文件')
const dbPath = join(stateDir, file)
console.log('打开状态文件:', dbPath)

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA foreign_keys=OFF')
db.exec('BEGIN')
try {
  // 幂等：已重建过（person_id 不存在）则跳过
  const cols = db.prepare("SELECT name FROM pragma_table_info('worlds')").all().map((r) => r.name)
  if (!cols.includes('person_id')) {
    console.log('worlds.person_id 已不存在，跳过重建')
  } else {
    db.exec(`
      CREATE TABLE __new_worlds (
        id text PRIMARY KEY NOT NULL,
        user_id text NOT NULL,
        name text NOT NULL,
        description text NOT NULL,
        locations_json text DEFAULT '[]' NOT NULL,
        status text DEFAULT 'paused' NOT NULL,
        pause_reason text,
        is_demo integer DEFAULT false NOT NULL,
        calls_today integer DEFAULT 0 NOT NULL,
        calls_day text,
        created_at text DEFAULT '' NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
      )
    `)
    db.exec(`INSERT INTO __new_worlds ("id","user_id","name","description","locations_json","status","pause_reason","is_demo","calls_today","calls_day","created_at")
             SELECT "id","user_id","name","description","locations_json","status","pause_reason","is_demo","calls_today","calls_day","created_at" FROM worlds`)
    db.exec('DROP TABLE worlds')
    db.exec('ALTER TABLE __new_worlds RENAME TO worlds')
    console.log('worlds 重建完成（person_id 已移除）')
  }

  const applied = db.prepare("SELECT COUNT(*) AS n FROM d1_migrations WHERE name='0002_fixed_landau.sql'").get().n
  if (applied === 0) {
    db.exec("INSERT INTO d1_migrations (name, applied_at) VALUES ('0002_fixed_landau.sql', datetime('now'))")
    console.log('0002 已登记到 d1_migrations')
  }
  db.exec('COMMIT')
} catch (e) {
  db.exec('ROLLBACK')
  throw e
}

// 一致性自查：FK 检查 + 关键引用抽验
db.exec('PRAGMA foreign_keys=ON')
const violations = db.prepare('PRAGMA foreign_key_check').all()
if (violations.length) {
  console.error('FK 违规:', violations)
  process.exit(1)
}
const w = db.prepare('SELECT COUNT(*) AS n FROM worlds').get().n
const wp = db.prepare('SELECT COUNT(*) AS n FROM world_persons').get().n
console.log(`自查通过：worlds=${w} world_persons=${wp}，无 FK 违规`)
db.close()
