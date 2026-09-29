import {
  createBlockRegistry, listObjectTemplates,
  type VoxelDocument,
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

const EDIT_OPS_SPEC = `可用操作（JSON 数组，每个元素一个操作）：
- {"kind":"set-block","at":{"x":0,"y":0,"z":0},"block":"方块id"} — 单格放置/挖掘（"air"=挖掘）
- {"kind":"fill","from":{...},"to":{...},"block":"方块id"} — 长方体填充（含两端）
- {"kind":"place-object","objectType":"仓库id","anchor":{...},"rotation":0} — 放置物体（rotation∈0/90/180/270）
- {"kind":"move-object","objectId":"现有物体id","anchor":{...}} — 移动物体
- {"kind":"remove-object","objectId":"现有物体id"} — 移除物体
硬约束：坐标不得越界；方块 id 与 objectType 必须逐字来自目录；锁定物体不可移动/移除/挖掘其格子；物体不得悬空（底层至少一格落在实体上）不得与其他物体重叠；水只能替换单格或一层，不得淹没建筑。`

export function buildEditPlannerMessages(doc: VoxelDocument, intent: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是体素世界的编辑规划器，把用户的自然语言改造意图转成一小组编辑操作。只返回 JSON 对象 {"ops":[...]}，不使用 Markdown，不解释。优先用少量操作达成意图（一般不超过 12 个）。
${EDIT_OPS_SPEC}
可用方块：${blockCatalogSummary(doc.theme)}
可用物体仓库：${objectCatalogSummary()}`,
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
  "ops": [ ...编辑操作（同编辑规划的操作集，用来铺地形、水面、道路）... ],
  "placements": [ {"objectType":"仓库id","anchor":{...},"rotation":0,"objectId":"稳定id","label":"显示名"} ],
  "locations": [ {"name":"地点名","objectId":"placements 中的 objectId"} ],
  "spaceEntries": [ {"spaceId":"空间id","label":"进入主楼 →","at":{...}} ],
  "lockedObjectIds": ["承载地点的建筑 objectId"]
}
硬约束：世界尺寸 width/depth ≤ 64、height ≤ 32；地面用 groundBlock 铺 y=0 一整层（一个 fill 操作）；关键地点必须由 place-object 建筑承载并登记 locations；主建筑加锁；所有物体落在地面上（anchor.y = 地面顶面）；先想清楚布局（主建筑、庭院、水景、植被分区）再输出操作。`

export function buildWorldGeneratorMessages(sceneDescription: string, theme: string): ChatMessage[] {
  return [
    {
      role: 'system',
      content: `你是体素世界建造师，根据场景描述生成一个可通过校验的体素世界。只返回 JSON 对象，不使用 Markdown。
${WORLD_GEN_SPEC}
可用方块：${blockCatalogSummary(theme)}
可用物体仓库：${objectCatalogSummary()}`,
    },
    { role: 'user', content: `场景描述：\n${sceneDescription}\n\n主题：${theme}\n\n生成世界 JSON。` },
  ]
}
