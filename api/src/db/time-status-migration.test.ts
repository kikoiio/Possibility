import { afterEach, describe, expect, it } from 'vitest'
import { worldVisitSessions } from './schema'
import { createTestDb } from '../test/db'

let fixture: ReturnType<typeof createTestDb> | undefined
afterEach(() => { fixture?.close(); fixture = undefined })

describe('time/status migration', () => {
  it('installs the visit session table and its uniqueness/index constraints', async () => {
    fixture = createTestDb()
    const table = fixture.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_visit_sessions'").all()
    expect(table).toHaveLength(1)
    const indexes = fixture.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'world_visit_session_%' ORDER BY name").all() as Array<{ name: string }>
    expect(indexes.map(item => item.name)).toEqual([
      'world_visit_session_client',
      'world_visit_session_scope',
      'world_visit_session_status',
    ])
  })

  it('enforces duplicate browser sessions at the database boundary', async () => {
    const f = createTestDb()
    fixture = f
    const columns = await f.db.select().from(worldVisitSessions).all()
    expect(columns).toEqual([])
    f.sqlite.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES ('u', 'u', 'x', '2026-01-01T00:00:00Z')")
    f.sqlite.exec("INSERT INTO worlds(id, user_id, name, description, status, created_at) VALUES ('w', 'u', 'W', '', 'running', '2026-01-01T00:00:00Z')")
    f.sqlite.exec("INSERT INTO timelines(id, world_id, sim_now, created_at, status) VALUES ('t', 'w', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'active')")
    const row = "('s1', 'user:u', 'u', NULL, 'w', 't', 'browser', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL, 'r1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
    f.sqlite.exec(`INSERT INTO world_visit_sessions(id, principal_key, user_id, guest_session_id, world_id, timeline_id, client_session_id, status, entered_sim_time, entered_at, exited_sim_time, exited_at, last_request_id, created_at, updated_at) VALUES ${row}`)
    expect(() => f.sqlite.exec(`INSERT INTO world_visit_sessions(id, principal_key, user_id, guest_session_id, world_id, timeline_id, client_session_id, status, entered_sim_time, entered_at, exited_sim_time, exited_at, last_request_id, created_at, updated_at) VALUES ('s2', 'user:u', 'u', NULL, 'w', 't', 'browser', 'open', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, NULL, 'r2', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)).toThrow()
  })
})
