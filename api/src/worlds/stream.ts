import { and, asc, desc, eq, gt, inArray, sql } from 'drizzle-orm'
import type { Context } from 'hono'
import type { SSEStreamingApi } from 'hono/streaming'
import type { Db } from '../db/client'
import { dialogues, dialogueTurns, events, personStates, timelines, worlds } from '../db/schema'

/**
 * 世界视图 SSE 增量推送（D11）：连接内每 2s 轮询增量，15s 无数据发心跳。
 * 推送类型：event（新事件）/ dialogue_turn（进行中对话新发言）/ state（人物状态变化）
 * / clock（simNow/callsToday/世界状态）。
 */

const eventRowid = sql<number>`"events"."rowid"`
const turnRowid = sql<number>`"dialogue_turns"."rowid"`

interface StreamCursors {
  lastEventRowid: number
  lastTurnRowid: number
  lastStateAt: string
  lastSimNow: string
  lastCallsToday: number
  lastStatus: string
}

async function pushDelta(db: Db, stream: SSEStreamingApi, worldId: string, timelineId: string, cur: StreamCursors): Promise<number> {
  let sent = 0

  // 新事件（rowid 自增游标）
  const newEvents = await db
    .select({ rowid: eventRowid, e: events })
    .from(events)
    .where(and(eq(events.timelineId, timelineId), gt(eventRowid, cur.lastEventRowid)))
    .orderBy(asc(eventRowid))
    .all()
  for (const { rowid, e } of newEvents) {
    await stream.writeSSE({
      event: 'event',
      data: JSON.stringify({
        type: 'event',
        id: e.id,
        simTime: e.simTime,
        title: e.title,
        description: e.description,
        kind: e.kind,
        actorPersonId: e.actorPersonId,
        dialogueId: e.dialogueId,
      }),
    })
    cur.lastEventRowid = rowid
    sent++
  }

  // 进行中对话的新发言
  const ongoing = await db
    .select({ id: dialogues.id })
    .from(dialogues)
    .where(and(eq(dialogues.timelineId, timelineId), eq(dialogues.status, 'ongoing')))
    .all()
  if (ongoing.length) {
    const newTurns = await db
      .select({ rowid: turnRowid, t: dialogueTurns })
      .from(dialogueTurns)
      .where(and(gt(turnRowid, cur.lastTurnRowid), inArray(dialogueTurns.dialogueId, ongoing.map((d) => d.id))))
      .orderBy(asc(turnRowid))
      .all()
    for (const { rowid, t } of newTurns) {
      await stream.writeSSE({
        event: 'dialogue_turn',
        data: JSON.stringify({
          type: 'dialogue_turn',
          dialogueId: t.dialogueId,
          turnIndex: t.turnIndex,
          personId: t.personId,
          utterance: t.utterance,
          thought: t.thought,
          simTime: t.simTime,
        }),
      })
      cur.lastTurnRowid = rowid
      sent++
    }
  } else {
    // 无进行中对话时仍推进游标，避免历史 turns 重放
    const latest = await db.select({ rowid: turnRowid }).from(dialogueTurns).orderBy(desc(turnRowid)).limit(1).get()
    if (latest && latest.rowid > cur.lastTurnRowid) cur.lastTurnRowid = latest.rowid
  }

  // 人物状态变化
  const changedStates = await db
    .select()
    .from(personStates)
    .where(and(eq(personStates.timelineId, timelineId), gt(personStates.updatedRealAt, cur.lastStateAt)))
    .all()
  for (const s of changedStates) {
    await stream.writeSSE({
      event: 'state',
      data: JSON.stringify({
        type: 'state',
        personId: s.personId,
        simTime: s.simTime,
        location: s.location,
        activity: s.activity,
        mood: s.mood,
        goal: s.goal,
        currentDialogueId: s.currentDialogueId,
      }),
    })
    if (s.updatedRealAt > cur.lastStateAt) cur.lastStateAt = s.updatedRealAt
    sent++
  }

  // 时钟/用量/世界状态
  const tl = await db.select().from(timelines).where(eq(timelines.id, timelineId)).get()
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  if (tl && world) {
    if (tl.simNow !== cur.lastSimNow || world.callsToday !== cur.lastCallsToday || world.status !== cur.lastStatus) {
      await stream.writeSSE({
        event: 'clock',
        data: JSON.stringify({
          type: 'clock',
          simNow: tl.simNow,
          callsToday: world.callsToday,
          worldStatus: world.status,
          pauseReason: world.pauseReason,
        }),
      })
      cur.lastSimNow = tl.simNow
      cur.lastCallsToday = world.callsToday
      cur.lastStatus = world.status
      sent++
    }
  }
  return sent
}

/** 供 M4（owner）与 M5（public）共用的 SSE 处理：鉴权与 demo 校验由调用方完成 */
export async function streamWorld(
  db: Db,
  stream: SSEStreamingApi,
  c: Context,
  worldId: string,
  timelineId: string,
): Promise<void> {
  // 游标初始化到当前末尾：快照已覆盖历史，SSE 只推增量（快照与 SSE 衔接不重复不缺失）
  const lastEvent = await db
    .select({ rowid: eventRowid })
    .from(events)
    .where(eq(events.timelineId, timelineId))
    .orderBy(desc(eventRowid))
    .limit(1)
    .get()
  const lastTurn = await db.select({ rowid: turnRowid }).from(dialogueTurns).orderBy(desc(turnRowid)).limit(1).get()
  const tl = await db.select().from(timelines).where(eq(timelines.id, timelineId)).get()
  const world = await db.select().from(worlds).where(eq(worlds.id, worldId)).get()
  const cur: StreamCursors = {
    lastEventRowid: lastEvent?.rowid ?? 0,
    lastTurnRowid: lastTurn?.rowid ?? 0,
    lastStateAt: new Date().toISOString(),
    lastSimNow: tl?.simNow ?? '',
    lastCallsToday: world?.callsToday ?? 0,
    lastStatus: world?.status ?? '',
  }

  let idleMs = 0
  while (!stream.aborted && !c.req.raw.signal.aborted) {
    try {
      const sent = await pushDelta(db, stream, worldId, timelineId, cur)
      idleMs = sent ? 0 : idleMs + 2000
      if (idleMs >= 15_000) {
        await stream.writeSSE({ event: 'ping', data: '{}' })
        idleMs = 0
      }
    } catch (e) {
      // 单次轮询失败不断线（D1 抖动时下一拍自愈）
      console.log(`[stream] pushDelta 失败：${e instanceof Error ? e.message : e}`)
    }
    await stream.sleep(2000)
  }
}
