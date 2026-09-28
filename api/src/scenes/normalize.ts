import type { SceneDocument } from '@possibility/scene-contract'

function ensureIds(items: Array<{ id?: string }>, prefix: string, warningLimit: number): string[] {
  const warnings: string[] = []
  const used = new Set<string>()
  for (const [index, item] of items.entries()) {
    const current = typeof item.id === 'string' ? item.id.trim() : ''
    if (current && !used.has(current)) {
      item.id = current
      used.add(current)
      continue
    }
    const stem = `${prefix}-${index + 1}`
    let candidate = stem
    let suffix = 2
    while (used.has(candidate)) candidate = `${stem}-${suffix++}`
    item.id = candidate
    used.add(candidate)
    if (warnings.length < warningLimit) warnings.push(`已为缺失或重复 ID 的内容生成稳定标识：${candidate}`)
  }
  return warnings
}

export function ensureSceneObjectIds(scene: SceneDocument, warningLimit = 8): string[] {
  return ensureIds(scene.objects, 'scene-object', warningLimit)
}

export function ensureScenePathIds(scene: SceneDocument, warningLimit = 8): string[] {
  return ensureIds(scene.paths, 'scene-path', warningLimit)
}
