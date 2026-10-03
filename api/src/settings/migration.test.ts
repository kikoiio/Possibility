import { readFileSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, URL as NodeURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const dir = fileURLToPath(new NodeURL('../../drizzle/', import.meta.url))
let sqlite: DatabaseSync | undefined
afterEach(() => { sqlite?.close(); sqlite = undefined })
function apply(file: string) {
  for (const statement of readFileSync(`${dir}/${file}`, 'utf8').split(/--> statement-breakpoint/)) {
    if (statement.trim()) sqlite!.exec(statement)
  }
}

describe('S4A migration 0031 → 0032', () => {
  it('adds nullable verification/source metadata without inventing legacy verification', () => {
    sqlite = new DatabaseSync(':memory:')
    sqlite.exec('PRAGMA foreign_keys = ON')
    for (const file of readdirSync(dir).filter(file => file.endsWith('.sql') && file < '0032').sort()) apply(file)
    sqlite.exec(`INSERT INTO users(id,username,password_hash,created_at) VALUES('legacy','legacy','x','2026-10-01');
      INSERT INTO user_llm_configs(user_id,base_url,model,api_key,daily_call_cap,updated_at)
        VALUES('legacy','https://provider.example','m','sk-legacy',null,'2026-10-01');
      INSERT INTO llm_call_log(id,user_id,purpose,created_at,status) VALUES('legacy-call','legacy','chat','2026-10-01','completed');`)
    apply('0032_s4a_provider_budget.sql')
    expect(sqlite.prepare('SELECT verification_fingerprint,verified_at,daily_call_cap FROM user_llm_configs').get())
      .toMatchObject({ verification_fingerprint: null, verified_at: null, daily_call_cap: null })
    expect(sqlite.prepare('SELECT api_key_source,budget_bucket,status FROM llm_call_log').get())
      .toMatchObject({ api_key_source: null, budget_bucket: null, status: 'completed' })
    const journal = JSON.parse(readFileSync(`${dir}/meta/_journal.json`, 'utf8')) as { entries: { tag: string }[] }
    const tags = journal.entries.map(entry => entry.tag)
    expect(tags.indexOf('0032_s4a_provider_budget')).toBeGreaterThan(tags.findIndex(tag => tag.startsWith('0031_')))
    expect(tags.indexOf('0033_s4b_world_timezone')).toBeGreaterThan(tags.indexOf('0032_s4a_provider_budget'))
  })
})
