import type { Person, WorldSnapshot } from '../agent/engine-context'
import { isAwake, parseScheduleItems } from '../agent/engine-context'

/**
 * 在场交谈的回应者资格（scene 路由与「可交谈地点」看板共用）：
 * 非用户身份、有状态、未在对话中、（可选）指定地点、日程上清醒。
 */
export function eligibleAt(snapshot: WorldSnapshot, location?: string): Person[] {
  const simNow = snapshot.timeline.simNow
  return snapshot.persons.filter((p) => {
    if (p.isUser) return false
    const s = snapshot.states.get(p.id)
    if (!s || s.currentDialogueId) return false
    if (location && s.location !== location) return false
    return isAwake(parseScheduleItems(snapshot.schedules.get(p.id)), simNow)
  })
}

/** 各地点可交谈人数（世界地点列表驱动；状态落在名单外地点的人物归入「他处」） */
export function eligibleBoard(snapshot: WorldSnapshot): { location: string; count: number }[] {
  const all = eligibleAt(snapshot)
  const board = snapshot.locations.map((loc) => ({
    location: loc.name,
    count: all.filter((p) => snapshot.states.get(p.id)!.location === loc.name).length,
  }))
  const known = new Set(snapshot.locations.map((l) => l.name))
  const elsewhere = all.filter((p) => !known.has(snapshot.states.get(p.id)!.location)).length
  if (elsewhere) board.push({ location: '他处', count: elsewhere })
  return board
}
