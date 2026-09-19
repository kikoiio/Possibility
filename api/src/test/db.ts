import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createDb } from '../db/client'
import type { Env } from '../index'

/** Real SQLite behind the D1 interface, including atomic batch rollback. No model/network calls.
 * Each fixture applies the checked-in migrations to a fresh in-memory database.
 * This tests SQL and route behavior; it does not emulate D1's distributed runtime.
 */
export function createTestDb() {
  const sqlite = new DatabaseSync(':memory:')
  sqlite.exec('PRAGMA foreign_keys = ON')
  const dir = join(dirname(fileURLToPath(import.meta.url)), '../../drizzle')
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.sql')).sort()) {
    const sql = readFileSync(`${dir}/${file}`, 'utf8')
    for (const statement of sql.split(/--> statement-breakpoint/).map(s => s.trim()).filter(Boolean)) {
      sqlite.exec(statement)
    }
  }

  class Statement {
    constructor(readonly query: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) { return new Statement(this.query, params) }
    execute() {
      const stmt = sqlite.prepare(this.query)
      const results = stmt.all(...this.params as never[])
      return { success: true, results, meta: { changes: Number(sqlite.prepare('SELECT changes() AS n').get()!.n) } }
    }
    async all() { return this.execute() }
    async run() { return this.execute() }
    async raw() {
      const stmt = sqlite.prepare(this.query)
      stmt.setReturnArrays(true)
      return stmt.all(...this.params as never[])
    }
    async first(column?: string) {
      const row = this.execute().results[0] ?? null
      return column && row ? row[column] : row
    }
  }
  const d1 = {
    prepare: (query: string) => new Statement(query),
    async batch(statements: Statement[]) {
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const results = statements.map((statement) => statement.execute())
        sqlite.exec('COMMIT')
        return results
      } catch (error) {
        sqlite.exec('ROLLBACK')
        throw error
      }
    },
    async exec(query: string) { sqlite.exec(query); return { count: 0, duration: 0 } },
  } as unknown as D1Database
  const env: Env = {
    DB: d1, ENVIRONMENT: 'test', LLM_BASE_URL: 'https://llm.invalid', LLM_API_KEY: 'test', LLM_MODEL: 'test',
  }
  return { db: createDb(d1), d1, sqlite, env, close: () => sqlite.close() }
}
