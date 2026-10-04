import { DatabaseSync } from 'node:sqlite'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const directory = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
const migrations = readdirSync(directory).filter(file => file.endsWith('.sql')).sort()

function apply(db: DatabaseSync, file: string) {
  for (const statement of readFileSync(join(directory, file), 'utf8').split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement)
  }
}

describe('K2 chat channel migration', () => {
  it('assigns legacy requests unknown and permits explicit phone requests', () => {
    const db = new DatabaseSync(':memory:')
    try {
      for (const file of migrations.filter(file => Number(file.slice(0, 4)) <= 35)) apply(db, file)
      db.exec('PRAGMA foreign_keys = OFF')
      db.exec(`INSERT INTO chat_requests (request_id, conversation_id, user_id, world_id, timeline_id, person_id,
        content_hash, user_message_id, reply_message_id, status, heartbeat_at, created_at, updated_at)
        VALUES ('legacy', 'conversation', 'owner', 'world', 'timeline', 'resident', 'hash', 'user-message',
          'reply-message', 'completed', 1, '2026-01-01', '2026-01-01')`)
      apply(db, migrations.find(file => file.startsWith('0036_'))!)
      expect(db.prepare('SELECT channel FROM chat_requests WHERE request_id = ?').get('legacy'))
        .toEqual({ channel: 'unknown' })
      db.prepare(`INSERT INTO chat_requests (request_id, conversation_id, user_id, world_id, timeline_id, person_id,
        channel, content_hash, user_message_id, reply_message_id, status, heartbeat_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('phone', 'conversation', 'owner', 'world', 'timeline',
        'resident', 'phone', 'hash', 'user-message-2', 'reply-message-2', 'pending', 2, '2026-01-02', '2026-01-02')
      expect(db.prepare('SELECT channel FROM chat_requests WHERE request_id = ?').get('phone'))
        .toEqual({ channel: 'phone' })
    } finally { db.close() }
  })
})
