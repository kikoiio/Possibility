/**
 * T34 批量重建：现有场景描述 → WorldGenerator（AI 重新生成，不做数据转换，F3）
 * → 契约校验 → 落盘 out/voxel-scenes/（每空间一份信封 + 一份多空间包）。
 * 用法：`node --import tsx scripts/rebuild-scenes-voxel.ts`
 * 凭据读 api/.dev.vars（LLM_BASE_URL / LLM_API_KEY / LLM_MODEL，gitignored，勿外泄）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { serialize, validateDocument, type SerializedVoxelSpaces } from '@possibility/voxel-contract'
import { generateWorld } from '../api/src/voxel/generate'
import { complete, configFromEnv } from '../api/src/llm/client'

interface SpaceSpec { id: string; name: string; description: string }

/** 雾影庄（与 api/src/demo/mist-manor-scene.ts 的地点结构对齐） */
const MIST_MANOR: { worldId: string; theme: string; defaultSpaceId: string; spaces: SpaceSpec[] } = {
  worldId: 'mist-manor',
  theme: 'mist-manor',
  defaultSpaceId: 'exterior',
  spaces: [
    {
      id: 'exterior',
      name: '雾影庄外景',
      description: [
        '雾影庄外景：白雾町山间的旧宅庭院，约 48×48 的草地。',
        '北侧是主建筑「大厅」所在的木造主楼（雾影庄主楼，两层，纸窗透出暖光），绑定地点「大厅」。',
        '一条石板路从西侧山口蜿蜒到主楼门口。东侧是玻璃温室花房（绑定地点「温室花房」），',
        '西南角有门房小屋（绑定地点「门房小屋」），东南角是后山散步道起点（绑定地点「后山散步道」）。',
        '主楼前的庭院里有石灯笼、山樱树、花坛和水井。',
        '空间入口：主楼门口放置通往 main-house-interior 的入口（标签「进入主楼 →」）。',
        '主楼、温室、门房为锁定物体。',
      ].join(''),
    },
    {
      id: 'main-house-interior',
      name: '主楼室内',
      description: [
        '雾影庄主楼室内：和式宅邸的一层，世界尺寸严格 24×24 以内（不要 48×48），榻榻米地面，灰泥墙与木柱。',
        '中央是宽敞的「大厅」，大厅里必须有一张独立的矮桌物体，地点「大厅」绑定到这张矮桌；',
        '西北角是「书房」，内有独立的书桌与书架物体，地点「书房」绑定到书桌；',
        '东北角是「餐厅」，内有独立的长桌物体，地点「餐厅」绑定到长桌；',
        '西南角是「图书室」，内有独立的高书架物体，地点「图书室」绑定到该书架。',
        '四个地点必须各自绑定到不同的家具物体（严禁多个地点绑定同一物体）；不要生成温室。',
        '纸拉窗透入柔光，房间角落有灯笼照明。',
        '空间入口：南侧门口放置通往 exterior 的出口（标签「← 返回庭院」）。',
        '大厅矮桌与书房书桌为锁定物体。',
      ].join(''),
    },
  ],
}

function loadDevVars(): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const line of readFileSync(resolve('api/.dev.vars'), 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (match) vars[match[1]] = match[2]
  }
  return vars
}

async function main() {
  const outDir = resolve('out/voxel-scenes')
  mkdirSync(outDir, { recursive: true })
  const vars = loadDevVars()
  if (!vars.LLM_BASE_URL || !vars.LLM_API_KEY || !vars.LLM_MODEL) throw new Error('api/.dev.vars 缺少 LLM_BASE_URL/LLM_API_KEY/LLM_MODEL')
  // 本地批量脚本：无预算账本，reserve 记一条日志即放行（postChat 强制要求 reservation）
  const config = configFromEnv(
    { LLM_BASE_URL: vars.LLM_BASE_URL, LLM_API_KEY: vars.LLM_API_KEY, LLM_MODEL: vars.LLM_MODEL },
    async (details) => { console.log(`[rebuild] LLM 调用（contract ${details.contractVersion}）`) },
  )

  const only = process.argv[2] // 只重建指定空间：node --import tsx scripts/rebuild-scenes-voxel.ts main-house-interior
  for (const space of MIST_MANOR.spaces) {
    if (only && space.id !== only) continue
    console.log(`[rebuild] 生成 ${space.name}（${space.id}）…`)
    const doc = await generateWorld(space.description, MIST_MANOR.theme, {
      id: `${MIST_MANOR.worldId}-${space.id}`,
      complete: (messages) => complete(config, messages, { responseFormat: { type: 'json_object' }, maxTokens: 16000 }),
    })
    const issues = validateDocument(doc)
    if (issues.length > 0) throw new Error(`${space.name} 落盘前校验失败：${issues[0].message}`)
    const serialized = serialize(doc)
    writeFileSync(resolve(outDir, `${MIST_MANOR.worldId}-${space.id}.json`), serialized)
    console.log(`[rebuild] ${space.name} 落盘：${Object.keys(doc.sections).length} 节、${doc.objects.length} 物体、地点 ${doc.locations.map((l) => l.name).join('/')}`)
  }

  // 多空间包始终从磁盘上的单空间文件重组（支持 --only 单空间重建后拼装）
  const bundleSpaces: SerializedVoxelSpaces['spaces'] = MIST_MANOR.spaces.map((spec) => ({
    id: spec.id,
    name: spec.name,
    document: JSON.parse(readFileSync(resolve(outDir, `${MIST_MANOR.worldId}-${spec.id}.json`), 'utf8')),
  }))
  const bundle: SerializedVoxelSpaces = {
    format: 'voxel-spaces', version: 1, defaultSpaceId: MIST_MANOR.defaultSpaceId, spaces: bundleSpaces,
  }
  writeFileSync(resolve(outDir, `${MIST_MANOR.worldId}.json`), JSON.stringify(bundle))
  console.log(`[rebuild] 多空间包落盘：${resolve(outDir, `${MIST_MANOR.worldId}.json`)}`)
  console.log('[rebuild] 完成。下一步：T35 开发页逐一打开产物，对照 AC3 人工验收后入库。')
}

await main()
