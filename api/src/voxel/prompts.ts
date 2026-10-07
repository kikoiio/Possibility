import {
  createBlockRegistry, listObjectTemplates, STYLE_PRESETS,
  type AssetManifest, type VoxelDocument,
} from '@possibility/voxel-contract'
import type { ChatMessage } from '../llm/client'

/** 世界摘要：供 LLM 理解当前世界（编辑规划用） */
export function worldSummary(doc: VoxelDocument): string {
  const lines: string[] = [
    `世界尺寸: ${doc.size.width}×${doc.size.height}×${doc.size.depth}（x×y×z，y 向上，地面通常在 y=0，可放置面从 y=1 开始）`,
    `主题: ${doc.theme}`,
  ]
  if (doc.objects.length > 0) {
    lines.push('已有物体:')
    for (const o of doc.objects) {
      const binding = o.binding ? ` 绑定${o.binding.kind === 'location' ? `地点「${o.binding.locationName}」` : `人物 ${o.binding.personId}`}` : ''
      const locked = doc.lockedObjectIds.includes(o.id) ? ' [锁定]' : ''
      lines.push(`- ${o.id}: ${o.objectType}「${o.label ?? ''}」@ (${o.anchor.x},${o.anchor.y},${o.anchor.z}) 旋转${o.rotation}°${binding}${locked}`)
    }
  }
  if (doc.assetPlacements && doc.assetPlacements.length > 0) {
    lines.push('已有资产摆放(GLB):')
    for (const p of doc.assetPlacements) {
      lines.push(`- ${p.id ?? '?'}: ${p.assetId} @ (${p.anchor[0]},${p.anchor[1]},${p.anchor[2]}) 旋转${p.rotation * 90}°`)
    }
  }
  if (doc.locations.length > 0) {
    lines.push(`地点绑定: ${doc.locations.map((l) => `「${l.name}」→${l.objectId}`).join(', ')}`)
  }
  if (doc.spaceEntries.length > 0) {
    lines.push(`空间入口: ${doc.spaceEntries.map((s) => `${s.label}@(${s.at.x},${s.at.y},${s.at.z})`).join(', ')}`)
  }
  return lines.join('\n')
}

/** 方块目录摘要（编辑器/生成提示词共用） */
export function blockCatalogSummary(theme: string): string {
  const registry = createBlockRegistry(theme)
  const rows = registry.list().map((b) => {
    const traits = [
      b.solid ? '实体' : '可穿过',
      b.translucent ? '半透明' : null,
      b.emitsLight ? `发光${b.emitsLight}` : null,
      b.accumulatesSnow ? '可积雪' : null,
    ].filter(Boolean).join('/')
    return `${b.id}（${b.name}，${b.category}，${traits}）`
  })
  return rows.join('、')
}

/** 物体仓库摘要 */
export function objectCatalogSummary(): string {
  return listObjectTemplates().map((t) => `${t.objectType}（${t.name}，占 ${t.cells.length} 格）`).join('、')
}

/** S2b 资产库摘要(GLB 摆放可用资产);无清单时返回 null 由调用方省略该行 */
export function assetCatalogSummary(manifest?: AssetManifest): string | null {
  if (!manifest) return null
  return Object.values(manifest.assets)
    .map((a) => `${a.id}（${a.category}，占地 ${a.footprint[0]}×${a.footprint[1]}，高 ${a.height}）`)
    .join('、')
}

const EDIT_OPS_SPEC = `可用操作（JSON 数组，每个元素一个操作）：
- {"kind":"set-block","at":{"x":0,"y":0,"z":0},"block":"方块id"} — 单格放置/挖掘（"air"=挖掘）
- {"kind":"fill","from":{...},"to":{...},"block":"方块id"} — 长方体填充（含两端）
- {"kind":"place-object","objectType":"仓库id","anchor":{...},"rotation":0} — 放置物体（rotation∈0/90/180/270）
- {"kind":"move-object","objectId":"现有物体id","anchor":{...}} — 移动物体
- {"kind":"remove-object","objectId":"现有物体id"} — 移除物体
- {"kind":"place-asset","assetId":"资产id","anchor":{...},"rotation":0} — 摆放 GLB 资产（rotation∈0/1/2/3，四分之一圈）
- {"kind":"move-asset","placementId":"现有摆放id","anchor":{...},"rotation":1} — 移动/旋转资产摆放（rotation 可省）
- {"kind":"remove-asset","placementId":"现有摆放id"} — 移除资产摆放
硬约束：坐标不得越界；方块 id 与 objectType 必须逐字来自目录；锁定物体不可移动/移除/挖掘其格子；物体不得悬空（底层至少一格落在实体上）不得与其他物体重叠；资产摆放不得越界、不得与既有摆放/物体占地冲突、不得悬空；水只能替换单格或一层，不得淹没建筑。优先用 place-asset 摆放库内资产，资产覆盖不了的自定义结构才用 set-block/fill/place-object。`

export function buildEditPlannerMessages(doc: VoxelDocument, intent: string, assets?: AssetManifest): ChatMessage[] {
  const catalog = assetCatalogSummary(assets)
  return [
    {
      role: 'system',
      content: `你是体素世界的编辑规划器，把用户的自然语言改造意图转成一小组编辑操作。只返回 JSON 对象 {"ops":[...]}，不使用 Markdown，不解释。优先用少量操作达成意图（一般不超过 12 个）。
${EDIT_OPS_SPEC}
可用方块：${blockCatalogSummary(doc.theme)}
可用物体仓库：${objectCatalogSummary()}${catalog ? `\n可用资产库：${catalog}` : ''}`,
    },
    {
      role: 'user',
      content: `当前世界：\n${worldSummary(doc)}\n\n用户意图：${intent}\n\n返回 {"ops":[...]}`,
    },
  ]
}

export const WORLD_GEN_SPEC = `返回 JSON 对象：
{
  "size": {"width":48,"height":24,"depth":48},
  "groundBlock": "grass",
  "style": {
    "preset": "dusk-warm",                                // 四选一:${STYLE_PRESETS.map((p) => p.id).join(' / ')}
    "tweaks": {"fogDensity":0,"exposure":0,"saturation":0} // 数值微调,雾密度 ±0.5,曝光/饱和 ±0.3
  },
  "ops": [ ...编辑操作（同编辑规划的操作集；需要承载地点绑定的建筑用 place-object 放这里）... ],
  "assetPlacements": [ {"assetId":"bld-hut-a","placementId":"building-1","anchor":{"x":12,"y":1,"z":12},"rotation":0} ],
  "locations": [ {"name":"地点名","objectId":"place-object 的 objectId 或 assetPlacements 的 placementId"} ],
  "spaceEntries": [ {"spaceId":"空间id","label":"进入主楼 →","at":{...}} ],
  "lockedObjectIds": ["承载地点的建筑 objectId"]
}
可选地形仅在用户明确要求时加入，例如：{"terrain":{"seed":123,"elevation":{"amplitude":4,"scale":24},"river":{"enabled":true,"width":2},"lakes":{"enabled":true,"size":4},"vegetation":{"density":0.05,"trees":true,"flowers":true,"bushes":true}}}。省略 terrain 时用 groundBlock 在 y=0 铺平地，建筑 anchor.y=1；加入 terrain 时基准地面在 y=3、水面在 y=3。style 可选，省略时用默认氛围。世界尺寸 width/depth ≤ 64、height ≤ 32。每个坐标都必须满足 0 ≤ x < size.width、0 ≤ y < size.height、0 ≤ z < size.depth；放置物体或资产时，整个占地 footprint 和高度都必须在这些边界内，不能只检查 anchor。不要擅自增加随机高差、水体或森林；“开阔草地”表示用 grass groundBlock 做平坦草地，不表示随机坡地或森林。优先用 assetPlacements 摆放库内资产（rotation∈0/1/2/3，seed 可省），资产覆盖不了的自定义结构才用逐块 ops；关键地点登记进 locations，每个地点必须绑定不同且唯一的 objectId。建筑资产必须显式提供唯一 placementId，并在 locations.objectId 中逐字使用同一个值；place-object 建筑可用其 objectId 绑定。绑定对象必须符合地点语义，咖啡馆、住宅、公寓、商店等建筑地点必须绑定建筑资产或明确成型的建筑物体，不得绑定公告栏、长凳、树、路牌、栅栏等装饰/家具。主建筑加锁；所有物体与资产摆放置在 ground 上（anchor.y = 地面顶面），不得悬空、不得互相占地冲突；世界必须可行走——居民要能走到每个地点：任何供人通行的格子（门洞、走廊、桥、拱下）其上方必须留出至少 2 格空气，墙体/屋顶不要压在通道头顶，地面不要留缺口；每个地点绑定的物体旁边必须留有可站立的空地，且经平地/台阶与室外连通——不要把地点建筑孤立在水面中央、围栏闭环或高台之上；先想清楚布局（主建筑、庭院、水景、植被分区）再输出操作。`

export function buildWorldGeneratorMessages(sceneDescription: string, theme: string, assets?: AssetManifest): ChatMessage[] {
  const catalog = assetCatalogSummary(assets)
  return [
    {
      role: 'system',
      content: `你是体素世界建造师，根据场景描述生成一个可通过校验的体素世界。只返回 JSON 对象，不使用 Markdown。
${WORLD_GEN_SPEC}
可用方块：${blockCatalogSummary(theme)}
可用物体仓库：${objectCatalogSummary()}${catalog ? `\n可用资产库：${catalog}` : ''}`,
    },
    { role: 'user', content: `场景描述：\n${sceneDescription}\n\n主题：${theme}\n\n生成世界 JSON。` },
  ]
}
