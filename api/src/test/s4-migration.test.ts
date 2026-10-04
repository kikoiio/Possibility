import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const directory = fileURLToPath(new NodeURL('../../drizzle/', import.meta.url))
const files = readdirSync(directory).filter(file => file.endsWith('.sql')).sort()
function apply(db: DatabaseSync, file: string) {
  for (const statement of readFileSync(`${directory}/${file}`, 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

describe('S4 migrations', () => {
  it('upgrades 0031 through 0032 and 0033 without changing legacy history or granting verification', () => {
    const db = new DatabaseSync(':memory:')
    try {
      for (const file of files.filter(file => Number(file.slice(0, 4)) <= 31)) apply(db, file)
      db.exec(`INSERT INTO users (id, username, password_hash, created_at) VALUES ('owner', 'owner', 'x', '2026-01-01');
        INSERT INTO worlds (id, user_id, name, description, created_at) VALUES ('world', 'owner', 'World', '', '2026-01-01');
        INSERT INTO timelines (id, world_id, sim_now, created_at) VALUES ('main', 'world', '2026-01-01T00:00:00Z', '2026-01-01');
        INSERT INTO events (id, timeline_id, sim_time, title, description) VALUES ('event', 'main', '2026-01-01T00:00:00Z', 'History', 'Keep');
        INSERT INTO user_llm_configs (user_id, base_url, api_key, model, daily_call_cap, updated_at) VALUES ('owner', 'https://example.invalid', 'test-key', 'test', 400, '2026-01-01');
        INSERT INTO llm_call_log (id, user_id, purpose, created_at) VALUES ('old-call', 'owner', 'chat', '2026-01-01');`)
      const beforeEvents = db.prepare('SELECT * FROM events').all()
      const beforeTimeline = db.prepare('SELECT * FROM timelines').all()
      apply(db, files.find(file => file.startsWith('0032_'))!)
      expect(db.prepare('SELECT verification_fingerprint, verified_at FROM user_llm_configs').get()).toEqual({ verification_fingerprint: null, verified_at: null })
      expect(db.prepare('SELECT api_key_source, budget_bucket FROM llm_call_log').get()).toEqual({ api_key_source: null, budget_bucket: null })
      apply(db, files.find(file => file.startsWith('0033_'))!)
      expect(db.prepare('SELECT time_zone FROM worlds').get()).toEqual({ time_zone: null })
      expect(db.prepare('SELECT * FROM timelines').all()).toEqual(beforeTimeline)
      expect(db.prepare('SELECT * FROM events').all()).toEqual(beforeEvents)
      for (const table of ['worlds', 'user_llm_configs', 'llm_call_log']) {
        const columns = db.prepare(`PRAGMA table_info(${table})`).all()
        expect(columns.filter(column => ['time_zone', 'verification_fingerprint', 'verified_at', 'api_key_source', 'budget_bucket'].includes(String(column.name))).every(column => column.notnull === 0)).toBe(true)
      }
    } finally { db.close() }
  })

  it('applies the complete migration sequence on a fresh database', () => {
    const db = new DatabaseSync(':memory:')
    try {
      for (const file of files) apply(db, file)
      expect(db.prepare('PRAGMA table_info(worlds)').all().some(column => column.name === 'time_zone')).toBe(true)
      expect(db.prepare('PRAGMA table_info(llm_call_log)').all().some(column => column.name === 'budget_bucket')).toBe(true)
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='resident_memory_safety'").get()).toEqual({ name: 'resident_memory_safety' })
    } finally { db.close() }
  })

  it('quarantines pre-cutover child memories without changing original memory rows', () => {
    const db = new DatabaseSync(':memory:')
    try {
      for (const file of files.filter(file => Number(file.slice(0, 4)) <= 33)) apply(db, file)
      db.exec(`INSERT INTO users (id, username, password_hash, created_at) VALUES ('owner', 'owner', 'x', '2026-01-01');
        INSERT INTO worlds (id, user_id, name, description, created_at) VALUES ('world', 'owner', 'World', '', '2026-01-01');
        INSERT INTO timelines (id, world_id, sim_now, created_at) VALUES ('main', 'world', '2026-01-01T00:00:00Z', '2026-01-01');
        INSERT INTO timelines (id, world_id, parent_timeline_id, fork_scenario_json, sim_now, created_at)
          VALUES ('fork', 'world', 'main', '{"whatIf":"private"}', '2026-01-02T00:00:00Z', '2026-01-02');
        INSERT INTO persons (id, user_id, name, model_json, created_at) VALUES ('ada', 'owner', 'Ada', '{}', '2026-01-01');
        INSERT INTO memories (id, person_id, timeline_id, type, content, created_at)
          VALUES ('legacy', 'ada', 'fork', 'summary', 'Keep untouched', '2026-01-02T00:00:00Z');`)
      const before = db.prepare("SELECT * FROM memories WHERE id='legacy'").get()
      apply(db, files.find(file => file.startsWith('0034_'))!)
      expect(db.prepare("SELECT * FROM resident_memory_safety WHERE timeline_id='fork'").get()).toMatchObject({ timeline_id: 'fork' })
      expect(db.prepare("SELECT * FROM resident_memory_safety WHERE timeline_id='main'").get()).toBeUndefined()
      expect(db.prepare("SELECT * FROM memories WHERE id='legacy'").get()).toEqual(before)
    } finally { db.close() }
  })
})
