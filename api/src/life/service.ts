import { and, eq, inArray, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { commitments, events, memories, personStates, persons } from '../db/schema'

export interface Invitation { title: string; kind: 'meeting' | 'help'; location: string; dueInMinutes: number }
export function parseInvitation(raw: unknown): Invitation | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.title !== 'string' || !p.title.trim() || typeof p.location !== 'string') return null
  if (p.kind !== 'meeting' && p.kind !== 'help') return null
  if (typeof p.dueInMinutes !== 'number' || !Number.isFinite(p.dueInMinutes) || p.dueInMinutes < 30 || p.dueInMinutes > 10080) return null
  return { title: p.title.trim().slice(0, 100), kind: p.kind, location: p.location.trim(), dueInMinutes: Math.floor(p.dueInMinutes) }
}

export async function proposeCommitment(db: Db, p: {
  id: string; worldId: string; timelineId: string; personId: string; visitorId: string
  sourceDialogueId: string; simNow: string; raw: unknown; locations: {name: string}[]
}) {
  const invitation = parseInvitation(p.raw)
  if (!invitation || !p.locations.some(l => l.name === invitation.location)) return
  // 同一人物最多三件悬而未决的事；不把每次寒暄变成任务。
  const open = await db.select().from(commitments).where(and(eq(commitments.timelineId, p.timelineId), eq(commitments.personId, p.personId), inArray(commitments.status, ['proposed', 'accepted']))).all()
  if (open.length >= 3 || open.some(c => c.visitorId === p.visitorId && c.title === invitation.title)) return
  await db.insert(commitments).values({
    id: p.id, worldId: p.worldId, timelineId: p.timelineId, personId: p.personId, visitorId: p.visitorId,
    sourceDialogueId: p.sourceDialogueId, title: invitation.title, kind: invitation.kind, location: invitation.location,
    dueSim: new Date(Date.parse(p.simNow) + invitation.dueInMinutes * 60000).toISOString(),
    status: 'proposed', createdSim: p.simNow, updatedSim: p.simNow, createdAt: new Date().toISOString(),
  }).onConflictDoNothing()
}

export const statusLabels: Record<string, string> = { proposed: '尚未答应', accepted: '已经约好', fulfilled: '如约完成', missed: '未能赴约', declined: '婉拒', expired: '邀请已过期', explained: '已解释失约' }

/** 只将当事人的约定带入其决策，不泄露别人的私约。 */
export async function lifeContext(db: Db, personId: string, timelineId: string): Promise<string> {
  const rows = await db.select().from(commitments).where(and(eq(commitments.timelineId, timelineId), eq(commitments.personId, personId), inArray(commitments.status, ['proposed', 'accepted', 'missed', 'explained']))).limit(12).all()
  return rows.length ? '## 你记挂着的约定（持久事实，不可擅自宣布已经完成）\n' + rows.map(c => `- ${c.title} @${c.location}；截止 ${c.dueSim}；${statusLabels[c.status]}`).join('\n') + '\n保持自己的近期目标；可以拒绝、协商或调整计划。只有记录显示履约才算完成，不替对方许诺。' : ''
}

type Commitment = typeof commitments.$inferSelect
export type LifeAction = 'accept' | 'decline' | 'fulfill' | 'explain'
export function nextCommitmentStatus(status: string, action: LifeAction): string | null {
  if (status === 'proposed' && action === 'accept') return 'accepted'
  if (status === 'proposed' && action === 'decline') return 'declined'
  if (status === 'accepted' && action === 'fulfill') return 'fulfilled'
  if (status === 'missed' && action === 'explain') return 'explained'
  return null
}

/** batch 中先条件写证据，最后改变状态；重复/并发执行不重复制造后果。 */
export async function transitionCommitment(db: Db, c: Commitment, next: string, simNow: string, explanation = '') {
  const actor = await db.select().from(persons).where(eq(persons.id, c.personId)).get()
  const visitor = await db.select().from(persons).where(eq(persons.id, c.visitorId)).get()
  const personName = actor?.name ?? '对方'
  const visitorName = visitor?.name ?? '来访者'
  const text = `${visitorName}与${personName}的「${c.title}」：${statusLabels[next] ?? next}。${explanation ? `说明：${explanation}` : ''}`
  const eventId = `commitment:${c.id}:${next}`
  const now = new Date().toISOString()
  const mood = next === 'fulfilled' ? '因对方守约而感到被重视' : next === 'missed' ? '约定落空，有些失落' : null
  await db.batch([
    db.insert(events).values({ id: eventId, timelineId: c.timelineId, simTime: simNow, title: `${c.title} · ${statusLabels[next] ?? next}`, description: text, kind: 'action', actorPersonId: c.visitorId, dialogueId: c.sourceDialogueId }).onConflictDoNothing(),
    db.insert(memories).values({ id: `${eventId}:memory`, personId: c.personId, timelineId: c.timelineId, type: 'relationship', content: text, simTime: simNow, createdAt: now, importance: 8, summarized: false }).onConflictDoNothing(),
    db.update(personStates).set({ ...(mood ? { mood } : {}), updatedRealAt: now }).where(and(eq(personStates.personId, c.personId), eq(personStates.timelineId, c.timelineId))),
    db.update(commitments).set({ status: next, updatedSim: simNow }).where(and(eq(commitments.id, c.id), eq(commitments.status, c.status))),
  ])
}

/** 虚拟时间跨过截止点才产生失约；没有接受的邀请只过期，不扣关系。 */
export async function advanceCommitments(db: Db, timelineId: string, simNow: string) {
  const rows = await db.select().from(commitments).where(and(eq(commitments.timelineId, timelineId), inArray(commitments.status, ['proposed', 'accepted']), lte(commitments.dueSim, simNow))).all()
  for (const c of rows) await transitionCommitment(db, c, c.status === 'accepted' ? 'missed' : 'expired', simNow)
}

export async function canFulfill(db: Db, c: Commitment, simNow: string): Promise<string | null> {
  if (simNow >= c.dueSim) return '约定已经到期，可以说明未能赴约的原因。'
  if (c.kind === 'meeting' && Date.parse(c.dueSim) - Date.parse(simNow) > 30 * 60000) return '还没到见面时间；截止前半小时可以赴约。'
  const state = await db.select().from(personStates).where(and(eq(personStates.personId, c.personId), eq(personStates.timelineId, c.timelineId))).get()
  if (!state || state.location !== c.location || state.currentDialogueId) return '对方现在不在约定地点或正在交谈，请稍后再来。'
  return null
}
