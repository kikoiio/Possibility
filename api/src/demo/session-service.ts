import { and, eq, gt, isNull } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { demoSandboxes, guestSessions, persons, personStates, timelines, users, worldPersons, worlds } from '../db/schema'
import { buildUserPersonaModel } from '../persona/routes'
import { hashGuestToken } from '../access/middleware'
import { readActiveBaseline } from './baseline-repository'
import { cloneWorldGraph, deleteClonedWorldGraph } from './world-graph-cloner'
import { verifyClonedWorld } from './clone-verification'
import type { ClaimResult, GuestSessionResult } from './types'

const SESSION_TTL_MS = 24 * 60 * 60 * 1000

function expiry(now: Date): string { return new Date(now.getTime() + SESSION_TTL_MS).toISOString() }

async function ensureVisitorPersona(db: Db, input: { ownerId: string; worldId: string; timelineIds: string[]; requestId: string; now: string }) {
  const members = await db.select({ person: persons }).from(worldPersons).innerJoin(persons, eq(worldPersons.personId, persons.id))
    .where(and(eq(worldPersons.worldId, input.worldId), eq(persons.isUser, true))).all()
  if (members.length) return members[0].person.id
  const world = await db.select().from(worlds).where(eq(worlds.id, input.worldId)).get()
  const location = (() => {
    try { return (JSON.parse(world?.locationsJson ?? '[]') as { name?: string }[])[0]?.name ?? '大厅' } catch { return '大厅' }
  })()
  const id = `visitor-${input.worldId.slice(-24)}`
  const statements: BatchItem<'sqlite'>[] = [
    db.insert(persons).values({ id, userId: input.ownerId, name: '访客', modelJson: JSON.stringify(buildUserPersonaModel('一位刚刚抵达雾影庄、仍在了解这里的人。')), isUser: true, createdAt: input.now }),
    db.insert(worldPersons).values({ worldId: input.worldId, personId: id, joinedAt: input.now }),
  ]
  for (const timelineId of input.timelineIds) statements.push(db.insert(personStates).values({
    personId: id, timelineId, simTime: input.now, location, activity: '观察四周', mood: '好奇', goal: '了解雾影庄正在发生的事', updatedRealAt: input.now,
  }))
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]])
  return id
}

async function sessionResult(db: Db, sessionId: string, token?: string): Promise<GuestSessionResult> {
  const session = await db.select().from(guestSessions).where(eq(guestSessions.id, sessionId)).get()
  if (!session?.currentSandboxWorldId) throw new Error('访客沙盒尚未准备完成')
  const timeline = session.resumeTimelineId
    ? await db.select().from(timelines).where(and(eq(timelines.id, session.resumeTimelineId), eq(timelines.worldId, session.currentSandboxWorldId))).get()
    : await db.select().from(timelines).where(eq(timelines.worldId, session.currentSandboxWorldId)).get()
  if (!timeline) throw new Error('访客沙盒没有时间线')
  return {
    token, sessionId, worldId: session.currentSandboxWorldId, timelineId: timeline.id,
    generation: session.generation, expiresAt: session.expiresAt, claimPending: session.status === 'claim_pending',
  }
}

async function createGeneration(db: Db, input: { sessionId: string; ownerId: string; generation: number; requestId: string; now: Date }) {
  const prior = await db.select().from(demoSandboxes).where(and(eq(demoSandboxes.sessionId, input.sessionId), eq(demoSandboxes.requestId, input.requestId))).get()
  if (prior) return prior
  const baseline = await readActiveBaseline(db)
  if (!baseline) throw new Error('雾影庄演示基线尚未配置')
  const createdAt = input.now.toISOString()
  const expiresAt = expiry(input.now)
  const cloned = await cloneWorldGraph(db, {
    sourceWorldId: baseline.worldId, targetOwnerId: input.ownerId,
    requestId: `guest:${input.sessionId}:${input.generation}:${input.requestId}`,
    name: `雾影庄 · 访客体验 ${input.generation + 1}`,
  })
  await ensureVisitorPersona(db, { ownerId: input.ownerId, worldId: cloned.worldId, timelineIds: [...cloned.timelineIds.values()], requestId: input.requestId, now: createdAt })
  const sandbox = {
    id: crypto.randomUUID(), sessionId: input.sessionId, baselineId: baseline.id, worldId: cloned.worldId,
    generation: input.generation, status: 'active', requestId: input.requestId, claimedWorldId: null,
    createdAt, expiresAt,
  }
  await db.batch([
    db.insert(demoSandboxes).values(sandbox),
    // 克隆会继承基线状态；基线可能已被闲置归档，沙盒有活跃访客，必须恢复为 running 引擎才会推进
    db.update(worlds).set({ status: 'running', pauseReason: null, lastUserActivityAt: createdAt }).where(eq(worlds.id, cloned.worldId)),
    db.update(guestSessions).set({
      currentSandboxWorldId: cloned.worldId, generation: input.generation, status: 'active',
      resumeTimelineId: cloned.mainTimelineId, resumeSpaceId: 'exterior', resumeMode: 'life', expiresAt, updatedAt: createdAt,
    }).where(eq(guestSessions.id, input.sessionId)),
  ])
  return sandbox
}

export async function createGuestSession(db: Db, requestId = crypto.randomUUID(), now = new Date()): Promise<GuestSessionResult> {
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`
  const sessionId = crypto.randomUUID()
  const ownerId = crypto.randomUUID()
  const createdAt = now.toISOString()
  await db.batch([
    db.insert(users).values({ id: ownerId, username: `guest-${sessionId}`, passwordHash: 'disabled:guest', createdAt }),
    db.insert(guestSessions).values({
      id: sessionId, tokenHash: await hashGuestToken(token), ownerUserId: ownerId, currentSandboxWorldId: null,
      generation: 0, status: 'active', resumeTimelineId: null, resumeSpaceId: 'exterior', resumeMode: 'life',
      expiresAt: expiry(now), createdAt, updatedAt: createdAt,
    }),
  ])
  try {
    await createGeneration(db, { sessionId, ownerId, generation: 0, requestId, now })
    return sessionResult(db, sessionId, token)
  } catch (error) {
    await db.delete(guestSessions).where(eq(guestSessions.id, sessionId))
    await db.delete(users).where(eq(users.id, ownerId))
    throw error
  }
}

export async function resumeGuestSession(db: Db, token: string, now = new Date()): Promise<GuestSessionResult | null> {
  const session = await db.select().from(guestSessions).where(eq(guestSessions.tokenHash, await hashGuestToken(token))).get()
  if (!session || !['active', 'claim_pending'].includes(session.status) || !session.currentSandboxWorldId ||
    (session.status === 'active' && session.expiresAt <= now.toISOString())) return null
  const claimPending = session.status === 'claim_pending'
  const expiresAt = expiry(now)
  if (!claimPending) await db.batch([
    db.update(guestSessions).set({ expiresAt, updatedAt: now.toISOString() }).where(eq(guestSessions.id, session.id)),
    db.update(demoSandboxes).set({ expiresAt }).where(and(eq(demoSandboxes.sessionId, session.id), eq(demoSandboxes.status, 'active'))),
  ])
  await db.batch([
    // 回访即活跃：沙盒若被闲置归档则解冻，并刷新活动时间避免立刻再次归档
    db.update(worlds).set({ status: 'running', pauseReason: null })
      .where(and(eq(worlds.id, session.currentSandboxWorldId), eq(worlds.status, 'archived'))),
    db.update(worlds).set({ lastUserActivityAt: now.toISOString() }).where(eq(worlds.id, session.currentSandboxWorldId)),
  ])
  return sessionResult(db, session.id)
}

export async function resetGuestSession(db: Db, token: string, requestId: string, now = new Date()): Promise<GuestSessionResult | null> {
  const session = await db.select().from(guestSessions).where(eq(guestSessions.tokenHash, await hashGuestToken(token))).get()
  if (!session || session.status !== 'active' || session.expiresAt <= now.toISOString()) return null
  const prior = await db.select().from(demoSandboxes).where(and(eq(demoSandboxes.sessionId, session.id), eq(demoSandboxes.requestId, requestId))).get()
  if (prior) return sessionResult(db, session.id)
  if (session.currentSandboxWorldId) await db.update(demoSandboxes).set({ status: 'replaced' })
    .where(and(eq(demoSandboxes.sessionId, session.id), eq(demoSandboxes.worldId, session.currentSandboxWorldId)))
  await createGeneration(db, { sessionId: session.id, ownerId: session.ownerUserId, generation: session.generation + 1, requestId, now })
  return sessionResult(db, session.id)
}

export class ClaimVerificationError extends Error {
  constructor(readonly issues: { code: string; detail: string }[]) {
    super(`演示世界保存核验未通过: ${issues.map(issue => issue.code).join(', ')}`)
  }
}

export async function claimGuestSession(db: Db, input: { token: string; userId: string; requestId: string; now?: Date }): Promise<ClaimResult | null> {
  const now = input.now ?? new Date()
  let session = await db.select().from(guestSessions).where(eq(guestSessions.tokenHash, await hashGuestToken(input.token))).get()
  if (!session) return null
  const active = await db.select().from(demoSandboxes).where(and(eq(demoSandboxes.sessionId, session.id), eq(demoSandboxes.generation, session.generation))).get()
  if (!active || !session.currentSandboxWorldId) return null

  const existingClaim = async (): Promise<ClaimResult | null> => {
    const sandbox = await db.select().from(demoSandboxes).where(eq(demoSandboxes.id, active.id)).get()
    if (!sandbox?.claimedWorldId) return null
    const owner = await db.select({ userId: worlds.userId }).from(worlds).where(eq(worlds.id, sandbox.claimedWorldId)).get()
    return owner?.userId === input.userId
      ? { kind: 'claimed', worldId: sandbox.claimedWorldId, replayed: true }
      : { kind: 'already_claimed_elsewhere' }
  }
  const priorClaim = await existingClaim()
  if (priorClaim) return priorClaim
  if (session.status === 'active') {
    if (session.expiresAt <= now.toISOString()) return null
    const marked = await db.update(guestSessions).set({ status: 'claim_pending', updatedAt: now.toISOString() })
      .where(and(eq(guestSessions.id, session.id), eq(guestSessions.status, 'active'), gt(guestSessions.expiresAt, now.toISOString())))
      .returning({ id: guestSessions.id })
    if (!marked.length) {
      session = await db.select().from(guestSessions).where(eq(guestSessions.id, session.id)).get()
      const wonDuringTransition = await existingClaim()
      if (wonDuringTransition) return wonDuringTransition
      if (session?.status !== 'claim_pending') return null
    } else session = { ...session, status: 'claim_pending' }
  } else if (session.status !== 'claim_pending') return null
  if (!session || session.status !== 'claim_pending' || !session.currentSandboxWorldId) return null

  const cloned = await cloneWorldGraph(db, {
    sourceWorldId: session.currentSandboxWorldId, targetOwnerId: input.userId,
    requestId: `claim:${session.id}:${input.userId}:${input.requestId}`, name: '雾影庄 · 保存的可能',
  })
  // S2/F4：核验通过才落 claimed;失败删半成品克隆图,访客会话与副本原样保留,同 requestId 可干净重试
  const verification = await verifyClonedWorld(db, {
    sourceWorldId: session.currentSandboxWorldId, targetOwnerId: input.userId, worldId: cloned.worldId,
    mainTimelineId: cloned.mainTimelineId, personIds: cloned.personIds, timelineIds: cloned.timelineIds,
    commandIds: cloned.commandIds,
  })
  if (!verification.ok) {
    await deleteClonedWorldGraph(db, cloned)
    throw new ClaimVerificationError(verification.issues)
  }
  const won = await db.update(demoSandboxes).set({ status: 'claimed', claimedWorldId: cloned.worldId })
    .where(and(eq(demoSandboxes.id, active.id), eq(demoSandboxes.status, 'active'), isNull(demoSandboxes.claimedWorldId)))
    .returning({ id: demoSandboxes.id })
  if (won.length) {
    await db.update(guestSessions).set({ status: 'claimed', updatedAt: now.toISOString() })
      .where(and(eq(guestSessions.id, session.id), eq(guestSessions.status, 'claim_pending')))
    return { kind: 'claimed', worldId: cloned.worldId, replayed: false }
  }

  // 同 requestId 的同账号并发可能共享确定性克隆；确认不是赢家结果后才清理临时图。
  const winner = await existingClaim()
  if (winner?.kind === 'claimed' && winner.worldId === cloned.worldId) return winner
  await deleteClonedWorldGraph(db, cloned)
  return winner
}
