/**
 * A1 场景兼容：隔离 e2e 资料 SQL 生成 CLI。
 *
 * 仅供隔离启动脚本（scripts/start-s02-e2e.mjs 的 scene-compatibility-legacy 数据模式）
 * 与迁移 fixture 测试调用，不经任何生产 HTTP 路径，也不由 Worker 请求触发。
 *
 * 输出两个 SQL 文件：
 *   1. legacy-fixture.sql        —— 迁移前资料：在应用 0000–0036 旧迁移之后、0037 之前导入，
 *      包含原始旧场景（可修复的非法场景 + 有效对照）、多归属人物、生活保留资料与演示基线对照。
 *   2. activate-test-policy.sql  —— 测试发布策略激活：在完整迁移之后应用，
 *      写入与真实编译规则/资产清单/模板目录一致的规范化指纹。
 *
 * 用法：npx tsx scripts/prepare-scene-compatibility-fixture.ts --out-dir <目录>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  compatibilityFixtureLegacyScene,
  compatibilityFixtureBookshelfScene,
  compatibilityFixtureRepairedBasis,
} from '../src/scenes/e2e-fixture'
import { hashPassword } from '../src/auth/password'
import { libraryManifest } from '../src/voxel/library-manifest'

const FIXTURE_TIME = '2026-09-15T08:00:00.000Z'

/** 隔离 e2e 真实登录口令(W28 真实认证):fixture 账号经登录页真实登录,无 token 绕过。 */
export const LEGACY_OWNER_PASSWORD = 'a1-legacy-pass-7'
export const SECOND_OWNER_PASSWORD = 'a1-second-pass-7'

function sqlText(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

async function hashJson(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** 与 scenes/repository.ts 的 hashStoredDocument 一致：sha256({document, version})。 */
async function revisionContentHash(document: unknown, version: number): Promise<string> {
  return hashJson({ document, version })
}

function revisionStatements(worldId: string, document: unknown, requestId: string, contentHash: string): string[] {
  const documentJson = JSON.stringify(document)
  return [
    `INSERT INTO \`world_scenes\` (\`world_id\`, \`current_version\`, \`theme_id\`, \`updated_at\`) VALUES (${sqlText(worldId)}, 1, 'mist-manor', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`world_scene_revisions\` (\`id\`, \`world_id\`, \`version\`, \`parent_version\`, \`request_id\`, \`content_hash\`, \`document_json\`, \`summary\`, \`kind\`, \`created_at\`) VALUES (${sqlText(`${worldId}-rev-1`)}, ${sqlText(worldId)}, 1, NULL, ${sqlText(requestId)}, ${sqlText(contentHash)}, ${sqlText(documentJson)}, '隔离 fixture 原始旧场景', 'initial', ${sqlText(FIXTURE_TIME)});`,
  ]
}

/**
 * 迁移前资料 SQL（0036 及更早 schema）：原始旧场景、多归属、生活保留与基线对照。
 * 必须在 0037_scene_compatibility 之前导入——world_scene_revisions 此时还没有
 * compatibility_json/validation_json/commit_guard 列，正是无证明旧资料的真实形态。
 */
export async function buildLegacyFixtureSql(): Promise<string> {
  const legacyScene = compatibilityFixtureLegacyScene()
  const basis = compatibilityFixtureRepairedBasis()
  const bookshelfScene = {
    ...compatibilityFixtureBookshelfScene(),
    assetPlacements: [{ id: 'fixture-bookshelf-collision', assetId: 'veg-flower-a', anchor: [8, 1, 8], rotation: 0, seed: 7 }],
  }
  const legacyHash = await revisionContentHash(legacyScene, 1)
  const basisHash = await revisionContentHash(basis, 1)
  const bookshelfHash = await revisionContentHash(bookshelfScene, 1)
  const demoHash = await revisionContentHash(basis, 1)
  const legacyOwnerHash = await hashPassword(LEGACY_OWNER_PASSWORD)
  const secondOwnerHash = await hashPassword(SECOND_OWNER_PASSWORD)
  // 多空间旧场景(W30/W33/W45):外景有效 + 花房带同一装饰碰撞,修复旅程须覆盖整个包
  const spacesScene = {
    format: 'voxel-spaces',
    version: 1,
    defaultSpaceId: 'exterior',
    spaces: [
      { id: 'exterior', name: '石灯外景', document: basis },
      { id: 'hall', name: '老花房', document: legacyScene },
    ],
  } as const
  const spacesHash = await revisionContentHash(spacesScene, 1)

  const statements: string[] = [
    '-- A1 scene-compatibility legacy fixture（迁移前导入；仅供隔离 s02-e2e 环境）',
    `INSERT INTO \`users\` (\`id\`, \`username\`, \`password_hash\`, \`role\`, \`created_at\`) VALUES
  ('a1-legacy-owner', 'a1-legacy-owner', ${sqlText(legacyOwnerHash)}, 'user', ${sqlText(FIXTURE_TIME)}),
  ('a1-second-owner', 'a1-second-owner', ${sqlText(secondOwnerHash)}, 'user', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`persons\` (\`id\`, \`user_id\`, \`name\`, \`model_json\`, \`is_user\`, \`created_at\`) VALUES
  ('a1-resident-ada', 'a1-legacy-owner', '阿澜', '{}', 0, ${sqlText(FIXTURE_TIME)}),
  ('a1-e01-resident-ada', 'a1-legacy-owner', '阿澜', ${sqlText(JSON.stringify({
    identity: [{ text: '照看石灯庭院的居民', provenance: 'known' }], behavior: [], speech: [], skills: [], memories: [],
    relationships: [], boundaries: [], unknowns: [],
  }))}, 0, ${sqlText(FIXTURE_TIME)}),
  ('a1-resident-ben', 'a1-second-owner', '阿柏', '{}', 0, ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`worlds\` (\`id\`, \`user_id\`, \`name\`, \`description\`, \`locations_json\`, \`status\`, \`pause_reason\`, \`is_demo\`, \`calls_today\`, \`llm_config_json\`, \`calls_day\`, \`last_user_activity_at\`, \`time_zone\`, \`created_at\`) VALUES
  ('a1-legacy-world', 'a1-legacy-owner', '旧石灯庭院', '带既存兼容问题的旧世界', ${sqlText(JSON.stringify([{ name: '石灯庭院', description: '旧场景里的石灯小院' }]))}, 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-second-world', 'a1-second-owner', '对照世界', '有效场景对照', '[]', 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-demo-world', 'a1-legacy-owner', '演示基线世界', '基线对照资料', '[]', 'running', NULL, 1, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-legacy-spaces-world', 'a1-legacy-owner', '旧双空间庭院', '多空间旧场景:外景有效,花房带既存碰撞', '[]', 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-missing-scene-world', 'a1-legacy-owner', '缺场景旧世界', '旧世界记录存在但没有场景版本', '[]', 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-corrupt-scene-world', 'a1-legacy-owner', '损坏场景旧世界', '旧场景 JSON 无法解析', '[]', 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-unsupported-scene-world', 'a1-legacy-owner', '未知格式旧世界', '旧场景格式不受当前适配器支持', '[]', 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-unsupported-version-world', 'a1-legacy-owner', '未知版本旧世界', '旧体素场景版本不受支持', '[]', 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)}),
  ('a1-bookshelf-world', 'a1-legacy-owner', '书架兼容旅程', '家具内部格不可误判为通行入口', '[]', 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`timelines\` (\`id\`, \`world_id\`, \`parent_timeline_id\`, \`fork_scenario_json\`, \`sim_now\`, \`created_at\`, \`status\`, \`ancestor_ids_json\`, \`last_real_tick_at\`, \`fork_snapshot_json\`) VALUES
  ('a1-legacy-main', 'a1-legacy-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', ${sqlText(FIXTURE_TIME)}, NULL),
  ('a1-second-main', 'a1-second-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-demo-main', 'a1-demo-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-spaces-main', 'a1-legacy-spaces-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-missing-scene-main', 'a1-missing-scene-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-corrupt-scene-main', 'a1-corrupt-scene-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-unsupported-scene-main', 'a1-unsupported-scene-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-unsupported-version-main', 'a1-unsupported-version-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-bookshelf-main', 'a1-bookshelf-world', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL);`,
    // 多归属：同一人物属于两个世界
    `INSERT INTO \`world_persons\` (\`world_id\`, \`person_id\`, \`joined_at\`) VALUES
  ('a1-legacy-world', 'a1-resident-ada', ${sqlText(FIXTURE_TIME)}),
  ('a1-legacy-spaces-world', 'a1-resident-ada', ${sqlText(FIXTURE_TIME)}),
  ('a1-second-world', 'a1-resident-ada', ${sqlText(FIXTURE_TIME)}),
  ('a1-second-world', 'a1-resident-ben', ${sqlText(FIXTURE_TIME)});`,
    // 生活保留：迁移后行程状态与记忆必须原样保留
    `INSERT INTO \`person_states\` (\`person_id\`, \`timeline_id\`, \`sim_time\`, \`location\`, \`activity\`, \`mood\`, \`goal\`, \`updated_real_at\`) VALUES
  ('a1-resident-ada', 'a1-legacy-main', ${sqlText(FIXTURE_TIME)}, '石灯庭院', '散步', '平静', '照看庭院', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`memories\` (\`id\`, \`person_id\`, \`timeline_id\`, \`type\`, \`content\`, \`sim_time\`, \`created_at\`, \`importance\`, \`summarized\`) VALUES
  ('a1-memory-1', 'a1-resident-ada', 'a1-legacy-main', 'event', '在石灯庭院里摆好了旧石灯。', ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 6, 0);`,
    ...revisionStatements('a1-legacy-world', legacyScene, 'a1-legacy-seed', legacyHash),
    ...revisionStatements('a1-second-world', basis, 'a1-second-seed', basisHash),
    ...revisionStatements('a1-bookshelf-world', bookshelfScene, 'a1-bookshelf-seed', bookshelfHash),
    `INSERT INTO \`universe_evidence\` (\`timeline_id\`, \`level\`, \`assessed_version\`, \`baseline_version\`, \`reason_codes_json\`, \`assessed_at\`) VALUES ('a1-bookshelf-main', 'complete', 0, 0, '["fixture_complete"]', ${sqlText(FIXTURE_TIME)});`,
    ...revisionStatements('a1-demo-world', basis, 'a1-demo-seed', demoHash),
    ...revisionStatements('a1-legacy-spaces-world', spacesScene, 'a1-spaces-seed', spacesHash),
    // 明确的旧资料诊断对照：缺场景、不可解析 JSON、当前适配器不支持的格式。
    // 原始异常资料在 0037 兼容迁移前写入，保证浏览器旅程面对真实持久旧数据。
    `INSERT INTO \`world_scenes\` (\`world_id\`, \`current_version\`, \`theme_id\`, \`updated_at\`) VALUES
  ('a1-corrupt-scene-world', 1, 'mist-manor', ${sqlText(FIXTURE_TIME)}),
  ('a1-unsupported-scene-world', 1, 'mist-manor', ${sqlText(FIXTURE_TIME)}),
  ('a1-unsupported-version-world', 1, 'mist-manor', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`world_scene_revisions\` (\`id\`, \`world_id\`, \`version\`, \`parent_version\`, \`request_id\`, \`content_hash\`, \`document_json\`, \`summary\`, \`kind\`, \`created_at\`) VALUES
  ('a1-corrupt-scene-rev-1', 'a1-corrupt-scene-world', 1, NULL, 'a1-corrupt-scene-seed', 'fixture-corrupt-hash', '{not-valid-json', '隔离 fixture 损坏旧场景', 'initial', ${sqlText(FIXTURE_TIME)}),
  ('a1-unsupported-scene-rev-1', 'a1-unsupported-scene-world', 1, NULL, 'a1-unsupported-scene-seed', 'fixture-unsupported-hash', '{"format":"legacy-2d-scene","version":7}', '隔离 fixture 未知格式旧场景', 'initial', ${sqlText(FIXTURE_TIME)}),
  ('a1-unsupported-version-rev-1', 'a1-unsupported-version-world', 1, NULL, 'a1-unsupported-version-seed', 'fixture-unsupported-version-hash', '{"format":"voxel-document","version":7}', '隔离 fixture 未知版本旧场景', 'initial', ${sqlText(FIXTURE_TIME)});`,
    // E01 专用保存演示副本：原始同一多空间旧包，独立于 W28–W45 状态依赖。
    `INSERT INTO \`worlds\` (\`id\`, \`user_id\`, \`name\`, \`description\`, \`locations_json\`, \`status\`, \`pause_reason\`, \`is_demo\`, \`calls_today\`, \`llm_config_json\`, \`calls_day\`, \`last_user_activity_at\`, \`time_zone\`, \`created_at\`) VALUES
  ('a1-e01-demo-copy', 'a1-legacy-owner', '雾影庄保存副本', 'E01 原始多空间旧演示副本', ${sqlText(JSON.stringify([{ name: '石灯庭院', description: '旧场景里的石灯小院' }]))}, 'running', NULL, 0, 0, NULL, NULL, ${sqlText(FIXTURE_TIME)}, 'UTC', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`timelines\` (\`id\`, \`world_id\`, \`parent_timeline_id\`, \`fork_scenario_json\`, \`sim_now\`, \`created_at\`, \`status\`, \`ancestor_ids_json\`, \`last_real_tick_at\`, \`fork_snapshot_json\`) VALUES
  ('a1-e01-main', 'a1-e01-demo-copy', NULL, NULL, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '[]', NULL, NULL),
  ('a1-e01-branch', 'a1-e01-demo-copy', 'a1-e01-main', ${sqlText(JSON.stringify({ name: '石灯旁的另一种可能', whatIf: '维护消息晚一天送达', changedVariable: '维护消息到达时间' }))}, ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 'active', '["a1-e01-main"]', NULL, NULL);`,
    `INSERT INTO \`world_persons\` (\`world_id\`, \`person_id\`, \`joined_at\`) VALUES ('a1-e01-demo-copy', 'a1-e01-resident-ada', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`universe_evidence\` (\`timeline_id\`, \`level\`, \`assessed_version\`, \`baseline_version\`, \`reason_codes_json\`, \`assessed_at\`) VALUES ('a1-e01-main', 'complete', 0, 0, '["fixture_complete"]', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`person_states\` (\`person_id\`, \`timeline_id\`, \`sim_time\`, \`location\`, \`activity\`, \`mood\`, \`goal\`, \`updated_real_at\`) VALUES ('a1-e01-resident-ada', 'a1-e01-main', ${sqlText(FIXTURE_TIME)}, '石灯庭院', '散步', '平静', '照看庭院', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`person_states\` (\`person_id\`, \`timeline_id\`, \`sim_time\`, \`location\`, \`activity\`, \`mood\`, \`goal\`, \`updated_real_at\`) VALUES ('a1-e01-resident-ada', 'a1-e01-branch', ${sqlText(FIXTURE_TIME)}, '石灯庭院', '整理花圃', '专注', '记录庭院变化', ${sqlText(FIXTURE_TIME)});`,
    `INSERT INTO \`memories\` (\`id\`, \`person_id\`, \`timeline_id\`, \`type\`, \`content\`, \`sim_time\`, \`created_at\`, \`importance\`, \`summarized\`) VALUES
  ('a1-e01-memory-1', 'a1-e01-resident-ada', 'a1-e01-main', 'event', '在石灯庭院里摆好了旧石灯。', ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 6, 0),
  ('a1-e01-memory-branch', 'a1-e01-resident-ada', 'a1-e01-branch', 'event', '在另一种可能里整理了花圃。', ${sqlText(FIXTURE_TIME)}, ${sqlText(FIXTURE_TIME)}, 5, 0);`,
    `INSERT INTO \`universe_evidence\` (\`timeline_id\`, \`level\`, \`assessed_version\`, \`baseline_version\`, \`reason_codes_json\`, \`assessed_at\`) VALUES ('a1-e01-branch', 'complete', 0, 0, '["fixture_complete"]', ${sqlText(FIXTURE_TIME)});`,
    ...revisionStatements('a1-e01-demo-copy', spacesScene, 'a1-e01-seed', spacesHash),
    // 基线对照：active 演示基线指向 demo 世界首版
    `INSERT INTO \`demo_baselines\` (\`id\`, \`world_id\`, \`scene_version\`, \`content_hash\`, \`status\`, \`created_at\`, \`retired_at\`) VALUES
  ('a1-demo-baseline', 'a1-demo-world', 1, ${sqlText(demoHash)}, 'active', ${sqlText(FIXTURE_TIME)}, NULL);`,
    '',
  ]
  return statements.join('\n')
}

/**
 * 测试发布策略激活 SQL（完整迁移之后应用）。
 * 指纹与 context.ts 的实时回退计算一致：资产清单/模板目录取规范化 JSON 的 sha256。
 * 普通 Worker 请求不会创建或降级策略，只由隔离启动显式安装。
 */
export async function buildTestPolicyActivationSql(publishedAt = FIXTURE_TIME): Promise<string> {
  const manifest = libraryManifest()
  if (!manifest) throw new Error('资产清单不可用，无法生成测试策略')
  const assetManifestHash = await hashJson(manifest)
  const templateCatalogHash = await hashJson('mist-manor-template-catalog-v1')
  return `-- A1 测试发布策略（仅隔离环境显式安装；Worker 请求永不创建/降级策略）
INSERT OR REPLACE INTO \`scene_validation_policy\` (\`id\`, \`rules_version\`, \`asset_manifest_hash\`, \`template_catalog_hash\`, \`published_at\`) VALUES
  ('active', 'voxel-scene-validation-v1', ${sqlText(assetManifestHash)}, ${sqlText(templateCatalogHash)}, ${sqlText(publishedAt)});
`
}

export const LEGACY_FIXTURE_SQL_FILE = 'legacy-fixture.sql'
export const TEST_POLICY_SQL_FILE = 'activate-test-policy.sql'

async function main(): Promise<void> {
  const outDirIndex = process.argv.indexOf('--out-dir')
  const outDir = outDirIndex >= 0 ? process.argv[outDirIndex + 1] : undefined
  if (!outDir) {
    console.error('用法: tsx scripts/prepare-scene-compatibility-fixture.ts --out-dir <目录>')
    process.exit(1)
  }
  mkdirSync(outDir, { recursive: true })
  const legacySql = await buildLegacyFixtureSql()
  const policySql = await buildTestPolicyActivationSql()
  writeFileSync(join(outDir, LEGACY_FIXTURE_SQL_FILE), legacySql)
  writeFileSync(join(outDir, TEST_POLICY_SQL_FILE), policySql)
  console.log(`legacy fixture sql: ${join(outDir, LEGACY_FIXTURE_SQL_FILE)}`)
  console.log(`test policy sql: ${join(outDir, TEST_POLICY_SQL_FILE)}`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main()
}
