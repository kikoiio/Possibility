import { readdir, readFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname)
const config = process.env.S01_REMOTE_D1_CONFIG
const expectedId = process.env.S01_REMOTE_D1_ID
const wrangler = join(root, 'node_modules', '.bin', 'wrangler')
const temp = await mkdtemp(join(tmpdir(), 's01-remote-migrations-'))

function run(args: string[]): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(wrangler, args, { cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', chunk => { output += String(chunk) })
    child.stderr.on('data', chunk => { output += String(chunk) })
    child.once('error', rejectRun)
    child.once('close', code => code === 0 ? resolveRun(output) : rejectRun(new Error(`wrangler exited ${code}: ${output}`)))
  })
}

function rows(output: string): Record<string, unknown>[] {
  const start = output.indexOf('[')
  if (start < 0) throw new Error(`Could not parse D1 JSON result: ${output}`)
  return (JSON.parse(output.slice(start)) as { results?: Record<string, unknown>[] }[]).flatMap(item => item.results ?? [])
}

async function main() {
  if (!config || !expectedId) throw new Error('Set S01_REMOTE_D1_CONFIG and S01_REMOTE_D1_ID explicitly.')
  const configText = await readFile(resolve(root, config), 'utf8')
  if (!configText.includes(`database_id = "${expectedId}"`)) throw new Error('Config database_id does not match S01_REMOTE_D1_ID.')
  const databaseName = configText.match(/database_name\s*=\s*"([^"]+)"/)?.[1] ?? ''
  if (!/(test|staging|acceptance)/i.test(databaseName)) throw new Error(`Refusing migrations on non-test database name: ${databaseName}`)
  await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--command',
    'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)'])
  const applied = new Set(rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    'SELECT name FROM d1_migrations'])).map(row => String(row.name)))
  const migrationNames = (await readdir(join(root, 'api/drizzle'))).filter(name => name.endsWith('.sql')).sort()
  for (const name of migrationNames) {
    if (applied.has(name)) continue
    const sql = await readFile(join(root, 'api/drizzle', name), 'utf8')
    const statements = sql.split('--> statement-breakpoint').map(value => value.trim()).filter(Boolean)
    for (const [index, statement] of statements.entries()) {
      const file = join(temp, `${name}.${String(index + 1).padStart(2, '0')}.sql`)
      await writeFile(file, `${statement}\n`, 'utf8')
      await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--file', file])
    }
    await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--command',
      `INSERT INTO d1_migrations (name) VALUES ('${name.replaceAll("'", "''")}')`])
    applied.add(name)
    console.log(`Applied ${name} (${statements.length} breakpoint statements)`)
  }
  const final = rows(await run(['d1', 'execute', 'DB', '--remote', '--config', config, '--json', '--command',
    'SELECT COUNT(*) AS migrations FROM d1_migrations']))[0]
  console.log(JSON.stringify({ databaseName, migrations: final?.migrations, pending: 0, remote: true }, null, 2))
}

try { await main() }
finally { await rm(temp, { recursive: true, force: true }) }
