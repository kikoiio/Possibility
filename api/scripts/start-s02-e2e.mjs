import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const persistTo = process.argv[2] ?? '/tmp/s02-wrangler-e2e-default'
const port = process.argv[3] ?? '8787'
// 数据模式：standard（既有 s02 回归）| scene-compatibility-legacy（A1 真实旧数据库隔离模式）
const dataMode = process.argv[4] ?? 'standard'
const config = 'wrangler.s02-e2e.toml'
const LEGACY_DATA_MODE = 'scene-compatibility-legacy'
const LEGACY_MIGRATION_CEILING = 36
const FIXTURE_MODE_VALUE = 'compatibility-legacy'
const fixtureProfile = dataMode === LEGACY_DATA_MODE ? 'compatibility-life-v1' : 'standard'
const KNOWN_MODES = new Set(['standard', LEGACY_DATA_MODE])

if (!KNOWN_MODES.has(dataMode)) {
  console.error(`未知数据模式 "${dataMode}"，可选: ${[...KNOWN_MODES].join(' | ')}`)
  process.exit(1)
}

const markerPath = join(persistTo, 's02-e2e-launch.json')
let tempRoot = null

function cleanupTemp() {
  if (tempRoot) {
    try { rmSync(tempRoot, { recursive: true, force: true }) } catch { /* best effort */ }
    tempRoot = null
  }
}

function fail(message, code = 1) {
  console.error(message)
  cleanupTemp()
  process.exit(code)
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: packageRoot, stdio: 'inherit' })
  if (result.status !== 0) {
    cleanupTemp()
    process.exit(result.status ?? 1)
  }
}

// 复用前核实服务身份与数据模式：健康且标记相符才复用；身份/模式不符拒绝启动，绝不覆盖。
async function probeServiceIdentity() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) })
    if (!response.ok) return null
    const body = await response.json().catch(() => null)
    return body && body.ok === true ? body : null
  } catch {
    return null
  }
}

const healthy = await probeServiceIdentity()
if (healthy) {
  const marker = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null
  if (marker?.mode === dataMode && marker?.port === Number(port) && marker?.fixtureProfile === fixtureProfile) {
    console.log(`复用已在运行的 s02-e2e 服务（mode=${dataMode}, port=${port}, pid=${marker.pid}）`)
    process.exit(0)
  }
  fail(`端口 ${port} 上的服务身份/数据模式不符（marker=${JSON.stringify(marker)}），拒绝复用或覆盖；请先停止该服务`)
}

function generateFixtureSql(outDir) {
  run('npx', ['tsx', 'scripts/prepare-scene-compatibility-fixture.ts', '--out-dir', outDir])
}

if (dataMode === LEGACY_DATA_MODE) {
  // A1(B66)：仅含 0000–0036 的临时 migrations_dir（保留相同迁移文件名与 D1 迁移记账，不关触发器）
  tempRoot = mkdtempSync(join(tmpdir(), 'a1-legacy-s02-'))
  const legacyMigrationsDir = join(tempRoot, 'migrations')
  mkdirSync(legacyMigrationsDir, { recursive: true })
  const drizzleDir = join(packageRoot, 'drizzle')
  const legacyFiles = readdirSync(drizzleDir)
    .filter(name => name.endsWith('.sql') && Number.parseInt(name.slice(0, 4), 10) <= LEGACY_MIGRATION_CEILING)
    .sort()
  if (legacyFiles.length === 0 || !legacyFiles.at(-1).startsWith('0036')) {
    fail(`旧迁移集合异常：${JSON.stringify(legacyFiles.at(-1))}，期望以 0036 结尾`)
  }
  for (const file of legacyFiles) copyFileSync(join(drizzleDir, file), join(legacyMigrationsDir, file))
  const tempConfig = join(tempRoot, 'wrangler.legacy-migrations.toml')
  const toml = readFileSync(join(packageRoot, config), 'utf8')
  if (!toml.includes('migrations_dir = "drizzle"')) fail(`${config} 缺少 migrations_dir = "drizzle"，无法生成旧迁移配置`)
  writeFileSync(tempConfig, toml.replace('migrations_dir = "drizzle"', `migrations_dir = "${legacyMigrationsDir}"`))

  // 旧迁移 → 导入原始旧资料 → 完整迁移（0037 起继续，同一 persistTo/数据库身份）
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', tempConfig, '--persist-to', persistTo])
  generateFixtureSql(tempRoot)
  run('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--config', config, '--persist-to', persistTo, '--file', join(tempRoot, 'legacy-fixture.sql')])
} else {
  tempRoot = mkdtempSync(join(tmpdir(), 's02-policy-'))
  generateFixtureSql(tempRoot)
}

// 完整迁移（两种模式都执行；不执行生产迁移，仅 --local 隔离库）
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--config', config, '--persist-to', persistTo])
// 所有 s02 回归模式都由隔离启动显式安装测试发布策略；普通 Worker 请求不创建/降级策略
run('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--config', config, '--persist-to', persistTo, '--file', join(tempRoot, 'activate-test-policy.sql')])

const devArgs = ['wrangler', 'dev', '--config', config, '--ip', '127.0.0.1', '--port', port, '--persist-to', persistTo]
if (dataMode === LEGACY_DATA_MODE) {
  // 仅 s02-e2e 的明确 deterministic fixture 模式（模式取自启动参数 → 环境变量，绝不取 HTTP body）
  devArgs.push('--var', `SCENE_COMPATIBILITY_FIXTURE:${FIXTURE_MODE_VALUE}`)
  // Enables only the deterministic reply used by the authenticated A1 conversation journey.
  devArgs.push('--var', 'A1_E2E_LIFE_FIXTURE:on')
}
const server = spawn('npx', devArgs, { cwd: packageRoot, stdio: 'inherit' })

mkdirSync(persistTo, { recursive: true })
writeFileSync(markerPath, JSON.stringify({ mode: dataMode, port: Number(port), fixtureProfile, pid: server.pid, startedAt: new Date().toISOString() }))

function cleanup() {
  try { rmSync(markerPath, { force: true }) } catch { /* best effort */ }
  cleanupTemp()
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { cleanup(); server.kill(signal) })
server.on('exit', code => { cleanup(); process.exit(code ?? 0) })
