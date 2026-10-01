/** ForkSnapshot 外置存储(0028, F4):timelines.forkSnapshotJson 只留 $ref 指针,正文在 fork_snapshots 表。
 * 旧行内 v1 快照永久可读;读取侧统一经 hydrateTimelines 回填后再进 visibility 纯函数链。
 */
import { inArray } from 'drizzle-orm'
import type { Db } from '../db/client'
import { forkSnapshots, type timelines } from '../db/schema'
import type { ForkSnapshot } from '../agent/visibility'

type Timeline = typeof timelines.$inferSelect

/** 写入 timelines 行的指针形态:判别规则是「JSON 且含字符串 $ref 字段」。 */
export const SNAPSHOT_REF = { $ref: 'table:fork_snapshots', v: 2 } as const
export const SNAPSHOT_REF_JSON = JSON.stringify(SNAPSHOT_REF)

export function isSnapshotRef(raw: string | null): boolean {
  if (!raw || !raw.startsWith('{')) return false
  try {
    return typeof (JSON.parse(raw) as { $ref?: unknown }).$ref === 'string'
  } catch {
    return false
  }
}

/** 正文入库(只插不改);与 timelines 指针行同 batch 调用保证原子。 */
export function writeForkSnapshot(db: Db, timelineId: string, snapshot: ForkSnapshot, now = new Date().toISOString()) {
  return db.insert(forkSnapshots).values({
    timelineId, version: snapshot.version, payloadJson: JSON.stringify(snapshot), createdAt: now,
  })
}

/** 批量把指针行回填为正文 JSON;无指针直返。指针悬空(存储缺行)是数据损坏,响亮抛错。 */
export async function hydrateTimelines(db: Db, rows: Timeline[]): Promise<Timeline[]> {
  const refs = rows.filter((row) => isSnapshotRef(row.forkSnapshotJson))
  if (!refs.length) return rows
  const stored = await db.select().from(forkSnapshots)
    .where(inArray(forkSnapshots.timelineId, refs.map((row) => row.id))).all()
  const byTimeline = new Map(stored.map((row) => [row.timelineId, row.payloadJson]))
  return rows.map((row) => {
    if (!isSnapshotRef(row.forkSnapshotJson)) return row
    const payload = byTimeline.get(row.id)
    if (!payload) throw new Error(`分叉快照存储缺失:${row.id}`)
    return { ...row, forkSnapshotJson: payload }
  })
}
