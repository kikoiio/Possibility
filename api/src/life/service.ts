import { and, eq, inArray, lte } from 'drizzle-orm'
import type { Db } from '../db/client'
import { commitments, personStates, timelines, worldCommands, worlds } from '../db/schema'
import { commitWorldCommand } from '../world-state/commit'
import { ensureUniverseRevision } from '../world-state/model'
import { WorldStateError } from '../world-state/types'

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
  if (await db.select().from(commitments).where(eq(commitments.id, p.id)).get()) return
  const world = await db.select().from(worlds).where(eq(worlds.id, p.worldId)).get()
  const timeline = await db.select().from(timelines).where(and(eq(timelines.id, p.timelineId), eq(timelines.worldId, p.worldId))).get()
  if (!world || !timeline) return
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`commitment-proposal:${p.id}`))
  const commandId = `system:${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
  for (let attempt = 0; attempt < 3; attempt++) {
    const existingCommand = await db.select().from(worldCommands).where(eq(worldCommands.id, commandId)).get()
    const revision = await ensureUniverseRevision(db, p.worldId, p.timelineId)
    const dueSim = new Date(Date.parse(timeline.simNow) + invitation.dueInMinutes * 60000).toISOString()
    try {
      await commitWorldCommand(db, { id: commandId, worldId: p.worldId, timelineId: p.timelineId, userId: world.userId,
        actorKind: 'system', expectedVersion: existingCommand?.expectedVersion ?? revision.version,
        action: { type: 'commitment_proposal', commitmentId: p.id, personId: p.personId, visitorId: p.visitorId,
          sourceDialogueId: p.sourceDialogueId, title: invitation.title, kind: invitation.kind, location: invitation.location, dueSim } })
      return
    } catch (error) {
      if (error instanceof WorldStateError && (error.status === 400 || error.status === 409)) {
        if (await db.select().from(commitments).where(eq(commitments.id, p.id)).get()) return
        if (attempt < 2 && !existingCommand) {
          const latestTimeline = await db.select().from(timelines).where(eq(timelines.id, p.timelineId)).get()
          if (latestTimeline) {
            Object.assign(timeline, latestTimeline)
            continue
          }
        }
        return
      }
      throw error
    }
  }
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

/** One commitment transition goes through the same versioned fact boundary as other world changes. */
export async function transitionCommitment(db: Db, c: Commitment, next: string, simNow: string, explanation = '', engineTickLeaseToken?: string) {
  const allowed = ['accepted', 'declined', 'fulfilled', 'missed', 'expired', 'explained'] as const
  if (!allowed.includes(next as typeof allowed[number])) throw new WorldStateError('无效约定状态', 400)
  const world = await db.select().from(worlds).where(eq(worlds.id, c.worldId)).get()
  if (!world) throw new WorldStateError('世界不存在', 404)
  for (let attempt = 0; attempt < 2; attempt++) {
    const revision = await ensureUniverseRevision(db, c.worldId, c.timelineId)
    try {
      await commitWorldCommand(db, { id: `commitment:${c.id}:${next}`, worldId: c.worldId, timelineId: c.timelineId,
        userId: world.userId, actorKind: 'system', expectedVersion: revision.version, engineTickLeaseToken,
        action: { type: 'commitment', commitmentId: c.id, next: next as typeof allowed[number], explanation } })
      return
    } catch (error) {
      const latest = await db.select().from(commitments).where(eq(commitments.id, c.id)).get()
      if (latest?.status === next) return
      if (!(error instanceof WorldStateError) || error.status !== 409 || attempt === 1) throw error
      if (latest?.status !== c.status) throw error
    }
  }
}

/** 虚拟时间跨过截止点才产生失约；没有接受的邀请只过期，不扣关系。 */
export async function advanceCommitments(db: Db, timelineId: string, simNow: string, engineTickLeaseToken?: string) {
  const rows = await db.select().from(commitments).where(and(eq(commitments.timelineId, timelineId), inArray(commitments.status, ['proposed', 'accepted']), lte(commitments.dueSim, simNow))).all()
  for (const c of rows) await transitionCommitment(db, c, c.status === 'accepted' ? 'missed' : 'expired', simNow, '', engineTickLeaseToken)
}

export async function canFulfill(db: Db, c: Commitment, simNow: string): Promise<string | null> {
  if (simNow >= c.dueSim) return '约定已经到期，可以说明未能赴约的原因。'
  if (c.kind === 'meeting' && Date.parse(c.dueSim) - Date.parse(simNow) > 30 * 60000) return '还没到见面时间；截止前半小时可以赴约。'
  const state = await db.select().from(personStates).where(and(eq(personStates.personId, c.personId), eq(personStates.timelineId, c.timelineId))).get()
  if (!state || state.location !== c.location || state.currentDialogueId) return '对方现在不在约定地点或正在交谈，请稍后再来。'
  return null
}
