import type { PersonListItem, WorldSummary } from '../api/types'

export interface WorldDisambiguationItem extends WorldSummary {
  personNames: string[]
}

export function buildWorldDisambiguationItems(
  worlds: WorldSummary[],
  persons: PersonListItem[],
): WorldDisambiguationItem[] {
  const names = new Map(persons.map(person => [person.id, person.name]))
  return worlds.map(world => ({
    ...world,
    personNames: (world.personIds ?? []).map(id => names.get(id)).filter((name): name is string => !!name),
  }))
}

export function worldStatusLabel(world: Pick<WorldSummary, 'status' | 'pauseReason' | 'hasScene'>): string {
  if (!world.hasScene) return '待创建场景'
  if (world.status === 'archived' && world.pauseReason === 'idle') return '闲置归档'
  if (world.status === 'running') return '运行中'
  if (world.status === 'paused') return world.pauseReason === 'manual' ? '已暂停' : '暂不可用'
  if (world.status === 'capped') return '已达上限'
  return '已归档'
}

export function worldPersonLabel(personNames: string[]): string {
  if (personNames.length === 0) return '暂无关联人物'
  if (personNames.length <= 2) return personNames.join('、')
  return `${personNames.slice(0, 2).join('、')}等 ${personNames.length} 人`
}
