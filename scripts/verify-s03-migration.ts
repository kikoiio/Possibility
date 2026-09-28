import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'

const migrationsDir = resolve('api/drizzle')

function applyMigration(db: DatabaseSync, filename: string) {
  const sql = readFileSync(resolve(migrationsDir, filename), 'utf8')
  for (const statement of sql.split('--> statement-breakpoint').map(part => part.trim()).filter(Boolean)) db.exec(statement)
}

function verifyOnce() {
  const db = new DatabaseSync(':memory:')
  db.exec('PRAGMA foreign_keys = ON')
  try {
    const migrations = readdirSync(migrationsDir).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort()
    for (const name of migrations.filter(name => Number(name.slice(0, 4)) <= 22)) applyMigration(db, name)

    db.exec(`
      INSERT INTO users (id, username, password_hash, created_at) VALUES ('legacy-user', 'legacy', 'hash', '2024-01-01');
      INSERT INTO persons (id, user_id, name, model_json, created_at) VALUES ('legacy-person', 'legacy-user', 'Legacy Person', '{}', '2024-01-01');
      INSERT INTO worlds (id, user_id, name, description, locations_json, created_at) VALUES ('legacy-world', 'legacy-user', 'Legacy World', 'kept', '[]', '2024-01-01');
      INSERT INTO world_persons (world_id, person_id, joined_at) VALUES ('legacy-world', 'legacy-person', '2024-01-01');
      INSERT INTO timelines (id, world_id, sim_now, created_at) VALUES ('legacy-timeline', 'legacy-world', '2024-01-01T00:00:00.000Z', '2024-01-01');
      INSERT INTO world_scenes (world_id, current_version, theme_id, updated_at) VALUES ('legacy-world', 1, 'contemporary-daily-life', '2024-01-01');
      INSERT INTO world_scene_revisions (id, world_id, version, parent_version, request_id, content_hash, document_json, summary, kind, created_at)
        VALUES ('legacy-scene-revision', 'legacy-world', 1, NULL, 'legacy-request', 'legacy-hash', '{}', 'legacy scene', 'initial', '2024-01-01');
    `)
    const before = db.prepare(`SELECT
      (SELECT count(*) FROM users WHERE id = 'legacy-user') AS users,
      (SELECT count(*) FROM persons WHERE id = 'legacy-person') AS persons,
      (SELECT count(*) FROM worlds WHERE id = 'legacy-world') AS worlds,
      (SELECT count(*) FROM timelines WHERE id = 'legacy-timeline') AS timelines,
      (SELECT count(*) FROM world_scene_revisions WHERE id = 'legacy-scene-revision') AS sceneRevisions`).get() as Record<string, number>

    for (const name of migrations.filter(name => Number(name.slice(0, 4)) >= 23 && Number(name.slice(0, 4)) <= 25)) applyMigration(db, name)

    const after = db.prepare(`SELECT
      (SELECT count(*) FROM users WHERE id = 'legacy-user') AS users,
      (SELECT count(*) FROM persons WHERE id = 'legacy-person') AS persons,
      (SELECT count(*) FROM worlds WHERE id = 'legacy-world') AS worlds,
      (SELECT count(*) FROM timelines WHERE id = 'legacy-timeline') AS timelines,
      (SELECT count(*) FROM world_scene_revisions WHERE id = 'legacy-scene-revision') AS sceneRevisions`).get() as Record<string, number>
    const schema = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')").all() as { name: string }[]
    const names = new Set(schema.map(item => item.name))
    for (const required of ['user_world_preferences', 'demo_baselines', 'guest_sessions', 'demo_sandboxes', 'demo_sandboxes_status_expiry']) {
      if (!names.has(required)) throw new Error(`S03 migration is missing ${required}`)
    }
    if (JSON.stringify(before) !== JSON.stringify(after) || Object.values(after).some(count => count !== 1)) {
      throw new Error(`Legacy rows changed during migration: ${JSON.stringify({ before, after })}`)
    }
    return { legacyRows: after, s03SchemaObjects: ['user_world_preferences', 'demo_baselines', 'guest_sessions', 'demo_sandboxes', 'demo_sandboxes_status_expiry'] }
  } finally {
    db.close()
  }
}

const first = verifyOnce()
const second = verifyOnce()
if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Repeated S03 migration verification produced different results')
console.log(`S03 migration upgrade ok: ${JSON.stringify(first)}`)
