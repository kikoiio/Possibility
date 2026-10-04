import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('E1 return watermark migration', () => {
  it('adds revision_version with zero for visits that already exist', () => {
    const sqlite = new DatabaseSync(':memory:')
    try {
      sqlite.exec(`CREATE TABLE world_visits (
        user_id TEXT NOT NULL,
        timeline_id TEXT NOT NULL,
        event_cursor INTEGER NOT NULL DEFAULT 0,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (user_id, timeline_id)
      )`)
      sqlite.prepare('INSERT INTO world_visits (user_id, timeline_id, event_cursor, seen_at) VALUES (?, ?, ?, ?)')
        .run('owner', 'main', 17, '2026-10-04T00:00:00.000Z')

      sqlite.exec(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../drizzle/0035_e1_return_revision_watermark.sql'), 'utf8'))

      expect(sqlite.prepare('SELECT event_cursor, revision_version FROM world_visits WHERE user_id = ? AND timeline_id = ?')
        .get('owner', 'main')).toEqual({ event_cursor: 17, revision_version: 0 })
    } finally {
      sqlite.close()
    }
  })
})
