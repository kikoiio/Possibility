import { findAnyAsset } from './catalog'
import type { GridPoint, SceneDocumentAny, SceneDocumentV2, SceneThemeManifest, SceneThemeManifestV2, SceneValidationIssue } from './types'
import { normalizeSceneDocument } from './normalize'

const key = (point: GridPoint) => `${point.x},${point.y}`
const directions = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }]
const connectorEdges = {
  north: { delta: { x: 0, y: -1 }, opposite: 'south' },
  east: { delta: { x: 1, y: 0 }, opposite: 'west' },
  south: { delta: { x: 0, y: 1 }, opposite: 'north' },
  west: { delta: { x: -1, y: 0 }, opposite: 'east' },
} as const

/** Validates connector pairing and that declared entrances/regions can be reached. */
export function validateSceneConnectivity(input: SceneDocumentAny, theme: SceneThemeManifest | SceneThemeManifestV2): SceneValidationIssue[] {
  const scene = normalizeSceneDocument(input)
  const issues: SceneValidationIssue[] = []
  const issue = (code: string, path: string, message: string) => issues.push({ code, path, message })
  const spaceIds = new Set(scene.spaces.map(space => space.id))
  const portalEnds = new Set<string>()
  const cellKey = (spaceId: string, p: GridPoint) => `${spaceId}:${key(p)}`
  for (const [i, portal] of scene.portals.entries()) {
    for (const [side, end] of [['from', portal.from], ['to', portal.to]] as const) {
      if (!spaceIds.has(end.spaceId)) issue('unknown_portal_space', `portals[${i}].${side}.spaceId`, 'Portal 引用了不存在的空间')
      const endKey = cellKey(end.spaceId, end.position)
      if (portalEnds.has(endKey)) issue('overlapping_portal', `portals[${i}].${side}.position`, '多个入口不能占用同一位置')
      portalEnds.add(endKey)
    }
  }
  for (const [si, space] of scene.spaces.entries()) {
    const base = `spaces[${si}]`
    const walkable = new Set(space.navigation.walkableCells.map(key))
    const blocked = new Set(space.navigation.blockedCells.map(key))
    const entries = [...space.navigation.entrances, ...space.regions.map(region => region.entryPoint)]
    space.navigation.entrances.forEach((entrance, ei) => {
      if (blocked.has(key(entrance))) issue('blocked_entrance', `${base}.navigation.entrances[${ei}]`, '空间入口位于阻挡格')
      if (walkable.size && !walkable.has(key(entrance))) issue('unwalkable_entrance', `${base}.navigation.entrances[${ei}]`, '空间入口不在可行走区域')
    })
    for (const [ri, region] of space.regions.entries()) {
      if (!region.cells.some(p => walkable.has(key(p))) && walkable.size) issue('unreachable_region', `${base}.regions[${ri}]`, '区域没有连接到可行走区域')
      for (const [name, p] of [['entryPoint', region.entryPoint], ['interactionPoint', region.interactionPoint]] as const) {
        if (blocked.has(key(p))) issue('blocked_entrance', `${base}.regions[${ri}].${name}`, '区域入口位于阻挡格')
        if (walkable.size && !walkable.has(key(p))) issue('unwalkable_entrance', `${base}.regions[${ri}].${name}`, '区域入口不在可行走区域')
      }
    }
    for (const [pi, portal] of scene.portals.entries()) for (const side of ['from', 'to'] as const) {
      const end = portal[side]
      if (end.spaceId !== space.id) continue
      if (blocked.has(key(end.position))) issue('blocked_entrance', `portals[${pi}].${side}.position`, 'Portal 位于阻挡格')
      if (walkable.size && !walkable.has(key(end.position))) issue('unwalkable_entrance', `portals[${pi}].${side}.position`, 'Portal 不在可行走区域')
      entries.push(end.position)
    }
    if (walkable.size && entries.length) {
      const start = entries.find(p => walkable.has(key(p)))
      if (start) {
        const reached = new Set([key(start)])
        const queue = [start]
        for (let cursor = 0; cursor < queue.length; cursor++) for (const d of directions) {
          const next = { x: queue[cursor].x + d.x, y: queue[cursor].y + d.y }; const k = key(next)
          if (walkable.has(k) && !reached.has(k)) { reached.add(k); queue.push(next) }
        }
        space.navigation.entrances.forEach((entrance, ei) => { if (!reached.has(key(entrance))) issue('unreachable_entrance', `${base}.navigation.entrances[${ei}]`, '入口与空间主通路不连通') })
        space.regions.forEach((region, ri) => { if (!reached.has(key(region.entryPoint))) issue('unreachable_region', `${base}.regions[${ri}].entryPoint`, '房间入口从空间入口不可达') })
      }
    }
    const structurePositions = new Map<string, { id: string; object: (typeof space.structures)[number]; connectors: { edge: keyof typeof connectorEdges; type: string; level: number }[] }>()
    for (const [oi, object] of space.structures.entries()) {
      const asset = findAnyAsset(theme, object.assetId)
      if (!asset) continue
      const k = key(object.position); const previous = structurePositions.get(k)
      if (previous) issue('overlapping_structure', `${base}.structures[${oi}].position`, `结构入口或连接位置与 ${previous} 重叠`)
      const connectors = 'connectors' in asset ? asset.connectors : []
      structurePositions.set(k, { id: object.id, object, connectors })
    }
    for (const [oi, object] of space.structures.entries()) {
      const asset = findAnyAsset(theme, object.assetId)
      if (!asset || !('connectors' in asset)) continue
      for (const connector of asset.connectors) {
        const edge = connectorEdges[connector.edge]
        const neighbor = structurePositions.get(key({ x: object.position.x + edge.delta.x, y: object.position.y + edge.delta.y }))
        if (!neighbor) continue
        const matching = neighbor.connectors.find(candidate => candidate.edge === edge.opposite && candidate.type === connector.type && candidate.level === connector.level)
        const conflicting = neighbor.connectors.some(candidate => candidate.edge === edge.opposite)
        if (!matching) issue(conflicting ? 'incompatible_connector' : 'unmatched_connector', `spaces[${si}].structures[${oi}].connectors`, `相邻结构的 ${connector.edge} 连接器类型、方向或层级不匹配`)
      }
    }
  }
  return issues
}

export function resolvePortal(scene: SceneDocumentV2, portalId: string) {
  return scene.portals.find(portal => portal.id === portalId)
}
