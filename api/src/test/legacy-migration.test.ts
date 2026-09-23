import { DatabaseSync } from 'node:sqlite'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const migrationDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
const time = '2026-09-21T08:00:00.000Z'

describe('s01 migration keeps legacy rows intact', () => {
  it('preserves old world, chat, memory, event, state, and commitment rows when adding world state tables', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = ON')
      const files = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
      for (const file of files.filter(name => Number.parseInt(name.slice(0, 4), 10) < 8)) applySqlFile(sqlite, file)

      sqlite.exec(`
        INSERT INTO users (id, username, password_hash, created_at) VALUES ('legacy-user', 'legacy', 'hash', '${time}');
        INSERT INTO persons (id, user_id, name, model_json, created_at, is_user) VALUES
          ('legacy-person', 'legacy-user', 'Resident', '{}', '${time}', 0),
          ('legacy-visitor', 'legacy-user', 'Visitor', '{}', '${time}', 1);
        INSERT INTO worlds (id, user_id, name, description, locations_json, status, created_at) VALUES
          ('legacy-world', 'legacy-user', 'Old world', 'Keep me', '[]', 'paused', '${time}');
        INSERT INTO world_persons (world_id, person_id, joined_at) VALUES ('legacy-world', 'legacy-person', '${time}');
        INSERT INTO timelines (id, world_id, parent_timeline_id, sim_now, created_at, status, ancestor_ids_json)
          VALUES ('legacy-main', 'legacy-world', NULL, '${time}', '${time}', 'active', '[]');
        INSERT INTO person_states (person_id, timeline_id, sim_time, location, activity, mood, goal, updated_real_at)
          VALUES ('legacy-person', 'legacy-main', '${time}', 'Cafe', 'Reading', 'Calm', 'Learn', '${time}');
        INSERT INTO conversations (id, user_id, person_id, timeline_id)
          VALUES ('legacy-chat', 'legacy-user', 'legacy-person', 'legacy-main');
        INSERT INTO messages (id, conversation_id, role, content, created_at)
          VALUES ('legacy-message', 'legacy-chat', 'user', 'Keep this conversation', '${time}');
        INSERT INTO events (id, timeline_id, sim_time, title, description)
          VALUES ('legacy-event', 'legacy-main', '${time}', 'Old event', 'Keep this event');
        INSERT INTO memories (id, person_id, timeline_id, type, content, sim_time, created_at)
          VALUES ('legacy-memory', 'legacy-person', 'legacy-main', 'world', 'Keep this memory', '${time}', '${time}');
        INSERT INTO commitments (id, world_id, timeline_id, person_id, visitor_id, title, kind, location, due_sim,
          status, created_sim, updated_sim, created_at)
          VALUES ('legacy-promise', 'legacy-world', 'legacy-main', 'legacy-person', 'legacy-visitor', 'Meet again',
          'meeting', 'Cafe', '2026-09-21T09:00:00.000Z', 'proposed', '${time}', '${time}', '${time}');
      `)

      const tableNames = ['worlds', 'world_persons', 'timelines', 'person_states', 'conversations', 'messages', 'events', 'memories', 'commitments']
      const before = snapshotRows(sqlite, tableNames)
      const migration = files.find(name => name.startsWith('0008_'))
      expect(migration).toBeTruthy()
      applySqlFile(sqlite, migration!)
      expect(snapshotRows(sqlite, tableNames)).toEqual(before)

      const addedTables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => String(row.name))
      expect(addedTables).toContain('universe_revisions')
      expect(addedTables).toContain('world_facts')
      expect(addedTables).toContain('world_commands')
      expect(addedTables).toContain('world_model_versions')
    } finally {
      sqlite.close()
    }
  })

  it('backfills a revision clock from the preserved current timeline time', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = ON')
      const files = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
      for (const file of files.filter(name => Number.parseInt(name.slice(0, 4), 10) < 11)) applySqlFile(sqlite, file)
      sqlite.exec(`
        INSERT INTO users (id, username, password_hash, created_at) VALUES ('legacy-user', 'legacy', 'hash', '${time}');
        INSERT INTO worlds (id, user_id, name, description, locations_json, status, created_at)
          VALUES ('legacy-world', 'legacy-user', 'Old world', 'Keep me', '[]', 'running', '${time}');
        INSERT INTO timelines (id, world_id, parent_timeline_id, sim_now, created_at, status, ancestor_ids_json)
          VALUES ('legacy-main', 'legacy-world', NULL, '${time}', '${time}', 'active', '[]');
        INSERT INTO universe_revisions (timeline_id, version, world_model_version, updated_at)
          VALUES ('legacy-main', 0, 1, '${time}');
        INSERT INTO world_commands (id, world_id, timeline_id, actor_kind, actor_id, type, payload_json, expected_version, result_version, created_at)
          VALUES ('legacy-command', 'legacy-world', 'legacy-main', 'owner', 'legacy-user', 'environment', '{}', 0, 1, '${time}');
        UPDATE universe_revisions SET version = 1 WHERE timeline_id = 'legacy-main';
        INSERT INTO world_facts (id, timeline_id, version, sim_time, fact_type, subject_id, value_json, source_command_id, visibility)
          VALUES ('legacy-fact', 'legacy-main', 1, '${time}', 'environment', 'world:weather', '{}', 'legacy-command', 'world');
        UPDATE timelines SET sim_now = '2026-09-21T08:15:00.000Z' WHERE id = 'legacy-main';
      `)
      const migration = files.find(name => name.startsWith('0011_'))
      expect(migration).toBeTruthy()
      applySqlFile(sqlite, migration!)
      expect(sqlite.prepare("SELECT sim_time FROM universe_revisions WHERE timeline_id = 'legacy-main'").get()?.sim_time)
        .toBe('2026-09-21T08:15:00.000Z')
      expect(sqlite.prepare("SELECT sim_now FROM timelines WHERE id = 'legacy-main'").get()?.sim_now)
        .toBe('2026-09-21T08:15:00.000Z')
      expect(sqlite.prepare("SELECT sim_time FROM world_facts WHERE id = 'legacy-fact'").get()?.sim_time).toBe(time)
    } finally {
      sqlite.close()
    }
  })

  it('adds the revision-step guard without rewriting an existing head and allows the next valid command', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = ON')
      const files = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
      for (const file of files.filter(name => Number.parseInt(name.slice(0, 4), 10) < 17)) applySqlFile(sqlite, file)
      sqlite.exec(`
        INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'legacy-user', 'hash', '${time}');
        INSERT INTO worlds (id, user_id, name, description, locations_json, status, created_at)
          VALUES ('w', 'u', 'Legacy world', '', '[]', 'running', '${time}');
        INSERT INTO timelines (id, world_id, parent_timeline_id, sim_now, created_at, status, ancestor_ids_json)
          VALUES ('t', 'w', NULL, '${time}', '${time}', 'active', '[]');
        INSERT INTO world_model_versions (world_id, version, model_json, created_at) VALUES ('w', 1, '{}', '${time}');
        INSERT INTO universe_revisions (timeline_id, version, sim_time, world_model_version, updated_at)
          VALUES ('t', 5, '${time}', 1, '${time}');
      `)
      const before = snapshotRows(sqlite, ['worlds', 'timelines', 'world_model_versions', 'universe_revisions'])
      applySqlFile(sqlite, files.find(name => name.startsWith('0017_'))!)
      expect(snapshotRows(sqlite, ['worlds', 'timelines', 'world_model_versions', 'universe_revisions'])).toEqual(before)

      sqlite.exec(`
        INSERT INTO world_commands (id, world_id, timeline_id, actor_kind, actor_id, type, payload_json,
          expected_version, result_version, created_at)
          VALUES ('next', 'w', 't', 'owner', 'u', 'environment', '{"type":"environment","location":null,"condition":"weather","value":"rain"}', 5, 6, '${time}');
        UPDATE universe_revisions SET version = 6 WHERE timeline_id = 't';
        INSERT INTO world_facts (id, timeline_id, version, sim_time, fact_type, subject_id, value_json,
          source_command_id, visibility)
          VALUES ('next-fact', 't', 6, '${time}', 'environment', 'world:weather',
            '{"location":null,"condition":"weather","value":"rain"}', 'next', 'world');
      `)
      expect(sqlite.prepare("SELECT version FROM universe_revisions WHERE timeline_id = 't'").get()?.version).toBe(6)
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM world_facts WHERE timeline_id = 't'").get()?.n).toBe(1)
      expect(() => sqlite.prepare("UPDATE universe_revisions SET version = 5 WHERE timeline_id = 't'").run())
        .toThrow('universe_revision_must_advance_by_one')
      expect(() => sqlite.prepare("UPDATE universe_revisions SET version = 8 WHERE timeline_id = 't'").run())
        .toThrow('universe_revision_must_advance_by_one')
    } finally {
      sqlite.close()
    }
  })

  it('adds the scene recovery heartbeat without dropping old pending requests', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec('PRAGMA foreign_keys = ON')
      const files = readdirSync(migrationDirectory).filter(name => name.endsWith('.sql')).sort()
      for (const file of files.filter(name => Number.parseInt(name.slice(0, 4), 10) < 15)) applySqlFile(sqlite, file)
      sqlite.exec(`
        INSERT INTO users (id, username, password_hash, created_at) VALUES ('u', 'user', 'hash', '${time}');
        INSERT INTO worlds (id, user_id, name, description, created_at) VALUES ('w', 'u', 'World', '', '${time}');
        INSERT INTO timelines (id, world_id, sim_now, created_at, ancestor_ids_json)
          VALUES ('t', 'w', '${time}', '${time}', '[]');
        INSERT INTO dialogues (id, timeline_id, location, participant_ids_json, sim_start, kind)
          VALUES ('d', 't', 'Cafe', '[]', '${time}', 'scene');
        INSERT INTO scene_requests (id, dialogue_id, content_hash, status, created_at)
          VALUES ('pending', 'd', 'hash', 'pending', 123);
      `)
      applySqlFile(sqlite, files.find(name => name.startsWith('0015_'))!)
      expect(sqlite.prepare("SELECT heartbeat_at FROM scene_requests WHERE id = 'pending'").get()?.heartbeat_at).toBe(0)
      expect(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'scene_commit_requires_live_request'").get())
        .toBeTruthy()
    } finally {
      sqlite.close()
    }
  })
})

function applySqlFile(sqlite: DatabaseSync, file: string) {
  const sql = readFileSync(join(migrationDirectory, file), 'utf8')
  for (const statement of sql.split(/--> statement-breakpoint/).map(part => part.trim()).filter(Boolean)) {
    sqlite.exec(statement)
  }
}

function snapshotRows(sqlite: DatabaseSync, tables: string[]) {
  return Object.fromEntries(tables.map(table => [
    table,
    sqlite.prepare(`SELECT * FROM \`${table}\` ORDER BY 1`).all(),
  ]))
}
