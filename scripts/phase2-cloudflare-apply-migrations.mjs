import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const config = process.env.PHASE2_TEMP_WRANGLER_CONFIG
const evidencePath = process.env.PHASE2_MIGRATION_EVIDENCE_PATH
const migrationDir = 'api/drizzle'
// This allowlist is limited to byte-pinned migrations whose trigger contains
// SELECT CASE ... RAISE(...), the syntax confirmed by the D1 splitter issue.
// Plain SELECT RAISE trigger files are intentionally excluded.
const knownParserFallbacks = new Map([
  ['0008_cool_spiral.sql', {
    sha256: '27d6f081d7d5f6c1a4f3b7d5d4d8c8fe0ad36a273d42ef41a3b60af42651c067',
    expectedQueries: 8,
  }],
  ['0011_universe_revision_sim_time.sql', {
    sha256: '896d47d531932ac7361250fb5e1a41d02cea999477720ad6abbe1efa4b574d5b',
    expectedQueries: 3,
  }],
  ['0012_dialogue_recovery_guard.sql', {
    sha256: '603fa9d8361fd835b0bfdb11af6d014bd31f45865f324f1a7e5116a222577490',
    expectedQueries: 1,
  }],
  ['0013_immutable_fork_provenance.sql', {
    sha256: '89a9caaa5ca273da1afe89a2d5f11b3411aa45f430de3bf58e84394c262f6ac8',
    expectedQueries: 1,
  }],
  ['0014_fork_schedule_checkpoint_guard.sql', {
    sha256: '4cbafc4d6b3adbcc83568a1f0a5661cdf2f9fee41fa014f3c944c6e171d91ac4',
    expectedQueries: 1,
  }],
  ['0015_curly_ikaris.sql', {
    sha256: '610c6bb2f2d70f0b1a4b285209a6f1365600726eed6ceb0f6f794445fe0e2e53',
    expectedQueries: 2,
  }],
  ['0016_active_fork_limit_guard.sql', {
    sha256: 'db65ddf9da0f71f004c1dc89ddfe706923eb9b66cc9d1d40160dc5ce9035bc5e',
    expectedQueries: 2,
  }],
  ['0017_universe_revision_step_guard.sql', {
    sha256: '640d2a3ab4df946f50bc3bb57771e373b67b81c9f87890fd86a8f28f0e03c22b',
    expectedQueries: 1,
  }],
  ['0018_smart_queen_noir.sql', {
    sha256: '132b153aa3f1846dbb9137ebdcfedc13a9e6cdfd93048599f3e9a44f09148956',
    expectedQueries: 3,
  }],
  ['0037_scene_compatibility.sql', {
    sha256: 'cdd06fe7b5340eb1c47c4ba704f635d17fdc69b6e4a9528f876b9bded0d32b7e',
    expectedQueries: 15,
  }],
])

if (!config || !evidencePath || !process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('Migration runner is missing its Wrangler config, evidence path, or scoped Cloudflare token')
}

const evidence = {
  status: 'running',
  method: 'standard Wrangler migrations apply with narrowly gated original-file imports',
  fallbackMigrations: [],
  expectedMigrations: [],
  observedLedger: [],
}

function command(args, { json = false } = {}) {
  const result = spawnSync('npx', ['wrangler', ...args], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  const stdout = result.stdout ?? ''
  const stderr = result.stderr ?? ''
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  if (result.error) throw result.error
  if (json && result.status === 0) {
    try {
      return { status: result.status, payload: JSON.parse(stdout) }
    } catch {
      throw new Error(`Wrangler returned non-JSON output for: ${args.join(' ')}`)
    }
  }
  return { status: result.status ?? 1, stdout, stderr }
}

function assertSame(actual, expected, description) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new Error(`${description} mismatch. Expected ${JSON.stringify(expected)}; received ${JSON.stringify(actual)}`)
  }
}

function readExpectedMigrations() {
  const names = readdirSync(migrationDir).filter(name => name.endsWith('.sql')).sort()
  if (names.some(name => !/^\d{4}_[a-z0-9_]+\.sql$/.test(name))) {
    throw new Error(`Migration directory contains an unrecognized SQL filename: ${JSON.stringify(names)}`)
  }
  if (names.length === 0 || new Set(names).size !== names.length) {
    throw new Error('Migration directory is empty or contains duplicate migration filenames')
  }
  const indices = names.map(name => Number(name.slice(0, 4)))
  if (indices.some((value, index) => value !== index)) {
    throw new Error(`Local migration filenames contain a numeric gap: ${JSON.stringify(names)}`)
  }
  return names
}

function readSingleQueryResult(payload, description) {
  // Wrangler v4 --json emits the D1 Query API's QueryResult[] for --command.
  // These calls contain exactly one SQL statement, so the array must contain one result.
  if (!Array.isArray(payload) || payload.length !== 1 || payload[0]?.success !== true
    || !Array.isArray(payload[0]?.results)) {
    throw new Error(`${description} did not return one successful D1 QueryResult`)
  }
  return payload[0]
}

function readLedger() {
  const { payload } = command([
    'd1', 'execute', 'DB', '--remote', '--json',
    '--command', 'SELECT id, name FROM d1_migrations ORDER BY id',
    '--config', config,
  ], { json: true })
  const queryResult = readSingleQueryResult(payload, 'Remote migration ledger query')
  const rows = queryResult.results
  if (rows.some(row => !Number.isInteger(row.id) || typeof row.name !== 'string')) {
    throw new Error(`Remote migration ledger returned malformed rows: ${JSON.stringify(rows)}`)
  }
  return rows
}

function verifyLedgerPrefix(rows, expected, label) {
  const names = rows.map(row => row.name)
  if (new Set(names).size !== names.length) {
    throw new Error(`${label}: remote migration ledger contains duplicate names: ${JSON.stringify(names)}`)
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length
    || rows.some((row, index) => index > 0 && row.id !== rows[index - 1].id + 1)) {
    throw new Error(`${label}: remote migration ledger IDs contain duplicates or gaps: ${JSON.stringify(rows)}`)
  }
  assertSame(names, expected.slice(0, names.length), `${label} ordered ledger prefix`)
}

function readStandardImportQueryCount(output, description) {
  // Wrangler v4's standard remote-file success line is:
  // "Executed N queries in Xms (R rows read, W rows written)".
  const matches = [...output.matchAll(
    /Executed\s+(\d+)\s+queries\s+in\s+[\d.]+\s*ms\s+\(\s*\d+\s+rows read,\s*\d+\s+rows written\s*\)/g,
  )]
  if (matches.length !== 1) {
    throw new Error(`${description} did not emit exactly one Wrangler file-import success line`)
  }
  const count = Number(matches[0][1])
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${description} Wrangler file-import success line has an invalid query count`)
  }
  return count
}

function saveEvidence(status, error = undefined) {
  evidence.status = status
  if (error) evidence.error = error instanceof Error ? error.message : String(error)
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`)
  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '## Temporary D1 migration evidence',
      '',
      `- Status: \`${status}\``,
      `- Expected migration files: \`${evidence.expectedMigrations.length}\``,
      `- Fallback imports: \`${evidence.fallbackMigrations.length}\``,
      `- Remote ledger rows: \`${evidence.observedLedger.length}\``,
    ]
    for (const item of evidence.fallbackMigrations) {
      lines.push(`- Imported original file \`${item.name}\` (SHA-256 \`${item.sha256}\`, ${item.queryCount} queries); ledger row recorded after import success.`)
    }
    if (evidence.error) lines.push(`- Error: \`${evidence.error.replaceAll('`', "'")}\``)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`)
  }
}

async function main() {
  const expected = readExpectedMigrations()
  evidence.expectedMigrations = expected
  const maxAttempts = expected.length + 1

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const applied = command([
      'd1', 'migrations', 'apply', 'DB', '--remote', '--config', config,
    ])
    if (applied.status === 0) {
      const rows = readLedger()
      verifyLedgerPrefix(rows, expected, 'Final remote migration ledger')
      assertSame(rows.map(row => row.name), expected, 'Final remote migration ledger')
      evidence.observedLedger = rows
      saveEvidence('pass')
      process.stdout.write(`Verified exact ordered remote migration ledger (${rows.length} migrations).\n`)
      return
    }

    const log = `${applied.stdout}\n${applied.stderr}`
    if (!/incomplete input:\s*SQLITE_ERROR/i.test(log)) {
      throw new Error(`Wrangler migrations apply failed outside the verified D1 parser signature (exit ${applied.status})`)
    }

    const rowsBefore = readLedger()
    verifyLedgerPrefix(rowsBefore, expected, 'Ledger before parser fallback')
    const nextName = expected[rowsBefore.length]
    const allowlisted = knownParserFallbacks.get(nextName)
    if (!allowlisted) {
      throw new Error(`Parser failure is at unreviewed migration ${nextName ?? '<ledger already complete>'}; refusing file-import fallback`)
    }

    const path = join(migrationDir, nextName)
    const originalBytes = readFileSync(path)
    const sha256 = createHash('sha256').update(originalBytes).digest('hex')
    if (sha256 !== allowlisted.sha256) {
      throw new Error(`Reviewed migration bytes changed for ${nextName}; expected ${allowlisted.sha256}, received ${sha256}`)
    }
    const sql = originalBytes.toString('utf8')
    if (!/CREATE\s+TRIGGER\b/i.test(sql) || !/SELECT\s+CASE\b/i.test(sql) || !/RAISE\s*\(/i.test(sql)) {
      throw new Error(`Reviewed parser-sensitive trigger pattern is absent from ${nextName}`)
    }

    process.stdout.write(`Importing complete original migration file ${path} (SHA-256 ${sha256}).\n`)
    const imported = command([
      'd1', 'execute', 'DB', '--remote', '--file', path, '--config', config,
    ])
    if (imported.status !== 0) {
      throw new Error(`${nextName} Wrangler file import failed with exit ${imported.status}`)
    }
    const executedQueries = readStandardImportQueryCount(
      `${imported.stdout}\n${imported.stderr}`,
      nextName,
    )
    if (executedQueries !== allowlisted.expectedQueries) {
      throw new Error(`${nextName} import did not report the reviewed query count ${allowlisted.expectedQueries}; received ${executedQueries}`)
    }

    // File import must have fully succeeded before this migration is recorded.
    const rowsAfterImport = readLedger()
    verifyLedgerPrefix(rowsAfterImport, expected, `Ledger after ${nextName} file import`)
    assertSame(rowsAfterImport.map(row => row.name), rowsBefore.map(row => row.name),
      `Ledger changed during ${nextName} file import`)
    const escapedName = nextName.replaceAll("'", "''")
    const inserted = command([
      'd1', 'execute', 'DB', '--remote', '--json',
      '--command', `INSERT INTO d1_migrations (name) VALUES ('${escapedName}')`,
      '--config', config,
    ], { json: true })
    readSingleQueryResult(inserted.payload, `Ledger insert for ${nextName}`)

    const rowsAfterLedger = readLedger()
    verifyLedgerPrefix(rowsAfterLedger, expected, `Ledger after recording ${nextName}`)
    assertSame(rowsAfterLedger.map(row => row.name), expected.slice(0, rowsBefore.length + 1),
      `Ledger after recording ${nextName}`)
    evidence.fallbackMigrations.push({ name: nextName, sha256, queryCount: executedQueries })
    evidence.observedLedger = rowsAfterLedger
  }

  throw new Error('Migration apply exceeded the bounded retry count')
}

try {
  await main()
} catch (error) {
  try {
    evidence.observedLedger = readLedger()
  } catch {
    // Preserve the original migration failure if the ledger is unavailable.
  }
  saveEvidence('fail', error)
  throw error
}
