import { spawn, spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const persistTo = process.argv[2] ?? '/tmp/s02-wrangler-e2e-default'
const port = process.argv[3] ?? '8787'
const config = 'wrangler.s02-e2e.toml'
const migrations = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', persistTo], { cwd: packageRoot, stdio: 'inherit' })
if (migrations.status !== 0) process.exit(migrations.status ?? 1)

const server = spawn('npx', ['wrangler', 'dev', '--config', config, '--ip', '127.0.0.1', '--port', port, '--persist-to', persistTo], { cwd: packageRoot, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.on('exit', code => process.exit(code ?? 0))
