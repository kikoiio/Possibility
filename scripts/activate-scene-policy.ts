/**
 * A1 B33：场景校验策略显式激活脚本。
 *
 * 激活是唯一的策略写入入口：Worker 请求路径永不创建/改写 scene_validation_policy。
 * 脚本在写入前显式核对 rules/assets/templates 指纹：
 *   - 计算当前编译规则/资产清单/模板目录的规范化指纹；
 *   - 调用方通过 --expect-* 传入发布票据上的预期指纹，任何一项不符即拒绝激活；
 *   - 已存在 active 行时一律拒绝（不降级、不覆盖；纯 INSERT，无 OR REPLACE）；
 *   - 成功后输出核实凭据（指纹 + publishedAt + 凭据哈希）供审计留档。
 *
 * 本脚本只对 --db 指定的本地 sqlite 文件操作（例如 miniflare D1 数据文件），
 * 远程环境由管理员凭输出的 SQL/凭据经 wrangler 显式执行——脚本本身不触碰远程。
 *
 * 用法：
 *   npx tsx scripts/activate-scene-policy.ts --db <本地 sqlite 文件> --confirm-activation \
 *     [--expect-rules-version <版本>] [--expect-asset-manifest-hash <sha256>] \
 *     [--expect-template-catalog-hash <sha256>] [--published-at <ISO 时间>]
 */
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { computeFallbackSceneWritePolicy, type SceneWriteProofPolicy } from '../api/src/scenes/compatibility/write-proof'

export interface ScenePolicyActivationReceipt extends SceneWriteProofPolicy {
  id: 'active'
  publishedAt: string
  /** sha256(规范 JSON 凭据)：激活后核对落库行与凭据一致。 */
  receiptHash: string
}

export class ScenePolicyActivationRefusal extends Error {
  constructor(readonly code: 'fingerprint_mismatch' | 'already_active', message: string) {
    super(message)
    this.name = 'ScenePolicyActivationRefusal'
  }
}

async function hashText(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * 显式激活核心（可测试）：计算指纹 → 比对预期 → 拒绝既有 active → 纯 INSERT → 凭据。
 * 指纹只从当前编译产物计算，绝不接受调用方直接提供要写入的指纹。
 */
export async function activateScenePolicy(
  sqlite: DatabaseSync,
  options: { expected?: Partial<SceneWriteProofPolicy>; publishedAt?: string } = {},
): Promise<ScenePolicyActivationReceipt> {
  const fingerprints = await computeFallbackSceneWritePolicy()
  const expected = options.expected ?? {}
  const mismatches = (Object.keys(expected) as Array<keyof SceneWriteProofPolicy>)
    .filter(key => expected[key] !== undefined && expected[key] !== fingerprints[key])
  if (mismatches.length) {
    const detail = mismatches.map(key => `${key}: 预期 ${expected[key]}，实际 ${fingerprints[key]}`).join('；')
    throw new ScenePolicyActivationRefusal('fingerprint_mismatch', `策略指纹与发布票据不符，拒绝激活：${detail}`)
  }
  const existing = sqlite.prepare('SELECT rules_version, asset_manifest_hash, template_catalog_hash, published_at FROM scene_validation_policy WHERE id = ?').get('active') as
    { rules_version: string; asset_manifest_hash: string; template_catalog_hash: string; published_at: string } | undefined
  if (existing) {
    throw new ScenePolicyActivationRefusal(
      'already_active',
      `scene_validation_policy 已存在 active 行（rules=${existing.rules_version}, published_at=${existing.published_at}）：拒绝降级或覆盖，请先走显式退役流程`,
    )
  }
  const publishedAt = options.publishedAt ?? new Date().toISOString()
  // 纯 INSERT：主键冲突即失败，绝不 INSERT OR REPLACE
  sqlite.prepare(
    'INSERT INTO scene_validation_policy (id, rules_version, asset_manifest_hash, template_catalog_hash, published_at) VALUES (?, ?, ?, ?, ?)',
  ).run('active', fingerprints.rulesVersion, fingerprints.assetManifestHash, fingerprints.templateCatalogHash, publishedAt)
  const receipt: ScenePolicyActivationReceipt = {
    id: 'active',
    ...fingerprints,
    publishedAt,
    receiptHash: '',
  }
  receipt.receiptHash = await hashText(JSON.stringify({ ...receipt, receiptHash: undefined }))
  // 落库复核：读回的行必须与凭据逐项一致
  const stored = sqlite.prepare('SELECT rules_version, asset_manifest_hash, template_catalog_hash, published_at FROM scene_validation_policy WHERE id = ?').get('active') as
    { rules_version: string; asset_manifest_hash: string; template_catalog_hash: string; published_at: string }
  if (stored.rules_version !== receipt.rulesVersion
    || stored.asset_manifest_hash !== receipt.assetManifestHash
    || stored.template_catalog_hash !== receipt.templateCatalogHash
    || stored.published_at !== receipt.publishedAt) {
    throw new Error('策略激活落库复核失败：读回行与凭据不一致')
  }
  return receipt
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const dbPath = argValue(argv, '--db')
  if (!dbPath || !argv.includes('--confirm-activation')) {
    console.error('用法：npx tsx scripts/activate-scene-policy.ts --db <本地 sqlite 文件> --confirm-activation [--expect-rules-version v] [--expect-asset-manifest-hash h] [--expect-template-catalog-hash h] [--published-at ISO]')
    console.error('这是显式管理操作：--confirm-activation 缺失时拒绝执行；脚本不触碰任何远程环境。')
    process.exitCode = 1
    return
  }
  const sqlite = new DatabaseSync(dbPath)
  try {
    const receipt = await activateScenePolicy(sqlite, {
      expected: {
        ...(argValue(argv, '--expect-rules-version') ? { rulesVersion: argValue(argv, '--expect-rules-version')! } : {}),
        ...(argValue(argv, '--expect-asset-manifest-hash') ? { assetManifestHash: argValue(argv, '--expect-asset-manifest-hash')! } : {}),
        ...(argValue(argv, '--expect-template-catalog-hash') ? { templateCatalogHash: argValue(argv, '--expect-template-catalog-hash')! } : {}),
      },
      ...(argValue(argv, '--published-at') ? { publishedAt: argValue(argv, '--published-at')! } : {}),
    })
    console.log('策略已激活，核实凭据：')
    console.log(JSON.stringify(receipt, null, 2))
  } catch (error) {
    if (error instanceof ScenePolicyActivationRefusal) {
      console.error(`拒绝激活（${error.code}）：${error.message}`)
      process.exitCode = 1
      return
    }
    throw error
  } finally {
    sqlite.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
