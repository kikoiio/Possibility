import { describe, expect, it } from 'vitest'
import { createTestDb } from '../test/db'

describe('guest claim operation schema', () => {
  it('applies the operation table and staging column', () => {
    const fixture = createTestDb()
    try {
      const columns = fixture.sqlite.prepare("PRAGMA table_info('demo_claim_operations')").all()
      const worlds = fixture.sqlite.prepare("PRAGMA table_info('worlds')").all() as Array<{ name: string }>
      expect(columns.length).toBeGreaterThan(0)
      expect(worlds.some(column => column.name === 'claim_staging_execution_id')).toBe(true)
    } finally { fixture.close() }
  })
})
