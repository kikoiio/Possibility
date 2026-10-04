import { and, asc, eq, lt, sql } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
import type { Db } from '../db/client'
import { chatRequests, messages } from '../db/schema'
import type { CommunicationChannel } from '../agent/types'

export type ChatRequest = typeof chatRequests.$inferSelect

export interface ReserveChatRequestInput {
  requestId: string
  conversationId: string
  userId: string
  worldId: string
  timelineId: string
  personId: string
  content: string
  channel?: CommunicationChannel
  now?: Date
}

export interface ChatRequestReservation {
  created: boolean
  request: ChatRequest
}

export class ChatRequestConflict extends Error {
  readonly status = 409
  constructor(message = 'requestId 已用于另一条聊天请求') {
    super(message)
    this.name = 'ChatRequestConflict'
  }
}

export class ChatRequestTerminalError extends Error {
  readonly status = 409
  constructor(readonly requestStatus: string, message = '聊天请求已经结束，不能再写入结果') {
    super(message)
    this.name = 'ChatRequestTerminalError'
  }
}

export async function chatContentHash(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `sha256:${[...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')}`
}

export async function readChatRequest(db: Db, requestId: string): Promise<ChatRequest | null> {
  return await db.select().from(chatRequests).where(eq(chatRequests.requestId, requestId)).get() ?? null
}

/** Lists recoverable requests by their authenticated owner and conversation, across browser profiles. */
export async function listPendingChatRequests(db: Db, conversationId: string, userId: string): Promise<ChatRequest[]> {
  return db.select().from(chatRequests).where(and(
    eq(chatRequests.conversationId, conversationId), eq(chatRequests.userId, userId), eq(chatRequests.status, 'pending'),
  )).orderBy(asc(chatRequests.createdAt)).all()
}

function sameRequest(row: ChatRequest, input: ReserveChatRequestInput, contentHash: string): boolean {
  return row.conversationId === input.conversationId
    && row.userId === input.userId
    && row.worldId === input.worldId
    && row.timelineId === input.timelineId
    && row.personId === input.personId
    && row.channel === (input.channel ?? 'unknown')
    && row.contentHash === contentHash
}

/** Atomically creates the durable request and its one user message. */
export async function reserveChatRequest(db: Db, input: ReserveChatRequestInput): Promise<ChatRequestReservation> {
  const requestId = input.requestId.trim()
  if (!requestId || requestId.length > 100) throw new ChatRequestConflict('requestId 无效')
  const content = input.content.trim()
  if (!content) throw new ChatRequestConflict('聊天内容不能为空')
  const contentHash = await chatContentHash(content)
  const prior = await readChatRequest(db, requestId)
  if (prior) {
    if (!sameRequest(prior, input, contentHash)) throw new ChatRequestConflict()
    return { created: false, request: prior }
  }

  const now = (input.now ?? new Date()).toISOString()
  const heartbeatAt = input.now?.getTime() ?? Date.now()
  const userMessageId = `chat:user:${requestId}`
  const replyMessageId = `chat:reply:${requestId}`
  const values: typeof chatRequests.$inferInsert = {
    requestId,
    conversationId: input.conversationId,
    userId: input.userId,
    worldId: input.worldId,
    timelineId: input.timelineId,
    personId: input.personId,
    channel: input.channel ?? 'unknown',
    contentHash,
    userMessageId,
    replyMessageId,
    status: 'pending',
    heartbeatAt,
    createdAt: now,
    updatedAt: now,
  }
  try {
    await db.batch([
      db.insert(messages).values({ id: userMessageId, conversationId: input.conversationId,
        role: 'user', content, createdAt: now }),
      db.insert(chatRequests).values(values),
    ])
    return { created: true, request: { ...values, finishedAt: null, errorCode: null } as ChatRequest }
  } catch (error) {
    const raced = await readChatRequest(db, requestId)
    if (!raced) throw error
    if (!sameRequest(raced, input, contentHash)) throw new ChatRequestConflict()
    return { created: false, request: raced }
  }
}

export async function heartbeatChatRequest(db: Db, requestId: string, at = new Date()): Promise<boolean> {
  const rows = await db.update(chatRequests).set({ heartbeatAt: at.getTime(), updatedAt: at.toISOString() }).where(and(
    eq(chatRequests.requestId, requestId), eq(chatRequests.status, 'pending'),
  )).returning({ requestId: chatRequests.requestId }).all()
  return rows.length === 1
}

export async function completeChatRequest(
  db: Db,
  requestId: string,
  content: string,
  at = new Date(),
): Promise<ChatRequest> {
  const request = await readChatRequest(db, requestId)
  if (!request) throw new ChatRequestConflict('聊天请求不存在')
  if (request.status !== 'pending') throw new ChatRequestTerminalError(request.status)
  const reply = content.trim()
  if (!reply) throw new ChatRequestConflict('回复内容不能为空')
  const finishedAt = at.toISOString()
  try {
    await db.batch([
      db.insert(messages).values({ id: request.replyMessageId, conversationId: request.conversationId,
        role: 'person', content: reply, createdAt: finishedAt }),
      db.update(chatRequests).set({ status: 'completed', updatedAt: finishedAt, finishedAt, errorCode: null,
        heartbeatAt: at.getTime() }).where(and(
        eq(chatRequests.requestId, requestId), eq(chatRequests.status, 'pending'),
      )),
    ])
  } catch (error) {
    const latest = await readChatRequest(db, requestId)
    if (latest && latest.status !== 'pending') throw new ChatRequestTerminalError(latest.status)
    throw error
  }
  return (await readChatRequest(db, requestId))!
}

/** Completion writes are appended to a world-command D1 batch for phone turns. */
export function buildChatCompletionWrites(
  db: Db,
  request: ChatRequest,
  content: string,
  at = new Date(),
): [BatchItem<'sqlite'>, BatchItem<'sqlite'>] {
  const reply = content.trim()
  if (!reply) throw new ChatRequestConflict('回复内容不能为空')
  const finishedAt = at.toISOString()
  return [
    db.insert(messages).values({ id: request.replyMessageId, conversationId: request.conversationId,
      role: 'person', content: reply, createdAt: finishedAt }),
    // If a concurrent cancellation won, force a NOT NULL constraint failure so the entire D1 batch rolls back.
    db.update(chatRequests).set({ requestId: sql`CASE WHEN ${chatRequests.status} = 'pending' THEN ${chatRequests.requestId} ELSE NULL END`,
      status: 'completed', updatedAt: finishedAt, finishedAt, errorCode: null, heartbeatAt: at.getTime() })
      .where(eq(chatRequests.requestId, request.requestId)),
  ]
}

async function finishWithoutReply(
  db: Db,
  requestId: string,
  status: 'failed' | 'cancelled',
  errorCode: string,
  at: Date,
): Promise<ChatRequest | null> {
  const rows = await db.update(chatRequests).set({ status, errorCode, updatedAt: at.toISOString(),
    finishedAt: at.toISOString(), heartbeatAt: at.getTime() }).where(and(
    eq(chatRequests.requestId, requestId), eq(chatRequests.status, 'pending'),
  )).returning().all()
  if (rows[0]) return rows[0]
  return readChatRequest(db, requestId)
}

export function failChatRequest(db: Db, requestId: string, errorCode: string, at = new Date()) {
  return finishWithoutReply(db, requestId, 'failed', errorCode, at)
}

export function cancelChatRequest(db: Db, requestId: string, at = new Date()) {
  return finishWithoutReply(db, requestId, 'cancelled', 'request_cancelled', at)
}

export async function recoverExpiredChatRequests(
  db: Db,
  heartbeatBefore: number,
  at = new Date(),
): Promise<string[]> {
  const rows = await db.update(chatRequests).set({ status: 'failed', errorCode: 'request_expired',
    updatedAt: at.toISOString(), finishedAt: at.toISOString(), heartbeatAt: at.getTime() }).where(and(
    eq(chatRequests.status, 'pending'), lt(chatRequests.heartbeatAt, heartbeatBefore),
  )).returning({ requestId: chatRequests.requestId }).all()
  return rows.map(row => row.requestId).sort()
}
