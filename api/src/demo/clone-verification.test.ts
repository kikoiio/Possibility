import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import app from '../index'
import { createTestDb } from '../test/db'
import { demoBaselines, events, guestSessions, universeEvidence, users, voxelEventProjections, worldCommands, worldSceneRevisions, worldScenes } from '../db/schema'
import { seedDemoWorld } from '../dev/seed-demo'
import { createGuestSession } from './session-service'
import { cloneWorldGraph, type CloneWorldGraphResult } from './world-graph-cloner'
import { verifyClonedWorld } from './clone-verification'
import type { SceneWriteProof } from '../scenes/compatibility/write-proof'
import { buildTestPolicyActivationSql } from '../../scripts/prepare-scene-compatibility-fixture'

/** S2/F4：核验规则单测——完整克隆 ok;逐类注入缺失/悬空观察对应 issue code */

type Fixture = ReturnType<typeof createTestDb>

async function cloneGuestSandbox(fixture: Fixture, requestId: string): Promise<{ cloned: CloneWorldGraphResult; sourceWorldId: string }> {
  await fixture.db.insert(users).values([
    { id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() },
    { id: 'member', username: 'member', passwordHash: 'x', createdAt: new Date().toISOString() },
  ])
  await seedDemoWorld(fixture.db)
  const guest = await createGuestSession(fixture.db, `verify-${requestId}`)
  // 一次真实移动：产生历史指令 + 证据重评(D1 场景),使核验覆盖指令重定基后的完整图
  const moved = await app.request(`/api/worlds/${guest.worldId}/scene/position`, {
    method: 'POST',
    headers: { 'X-Possibility-Guest': guest.token!, 'Content-Type': 'application/json' },
    body: JSON.stringify({ timelineId: guest.timelineId, location: '温室花房', commandId: `verify-move-${requestId}`, expectedVersion: 0 }),
  }, fixture.env)
  expect(moved.status).toBe(200)
  const cloned = await cloneWorldGraph(fixture.db, {
    sourceWorldId: guest.worldId, targetOwnerId: 'member', requestId, name: '核验目标世界',
  })
  return { cloned, sourceWorldId: guest.worldId }
}

function verify(fixture: Fixture, sourceWorldId: string, cloned: CloneWorldGraphResult) {
  return verifyClonedWorld(fixture.db, {
    sourceWorldId, targetOwnerId: 'member', worldId: cloned.worldId,
    mainTimelineId: cloned.mainTimelineId, personIds: cloned.personIds,
    timelineIds: cloned.timelineIds, commandIds: cloned.commandIds,
  })
}

describe('clone verification', () => {
  it('accepts a complete clone of an interacted guest sandbox', async () => {
    const fixture = createTestDb()
    const { cloned, sourceWorldId } = await cloneGuestSandbox(fixture, 'verify-ok')
    const result = await verify(fixture, sourceWorldId, cloned)
    expect(result.issues).toEqual([])
    expect(result.ok).toBe(true)
    fixture.close()
  })

  it('rejects a cloned world with a wrong owner and a missing main timeline', async () => {
    const fixture = createTestDb()
    const { cloned, sourceWorldId } = await cloneGuestSandbox(fixture, 'verify-owner')
    const result = await verifyClonedWorld(fixture.db, {
      sourceWorldId, targetOwnerId: 'someone-else', worldId: cloned.worldId,
      mainTimelineId: 'timeline-does-not-exist', personIds: cloned.personIds,
      timelineIds: cloned.timelineIds, commandIds: cloned.commandIds,
    })
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(['owner_mismatch', 'missing_main_timeline']))
    fixture.close()
  })

  it('reports events_count_mismatch when a cloned event is missing', async () => {
    const fixture = createTestDb()
    const { cloned, sourceWorldId } = await cloneGuestSandbox(fixture, 'verify-events')
    const clonedTimelineIdList = [...cloned.timelineIds.values()]
    const clonedEvents = await fixture.db.select().from(events).all()
    const target = clonedEvents.find(row => clonedTimelineIdList.includes(row.timelineId))!
    await fixture.db.delete(events).where(eq(events.id, target.id))
    const result = await verify(fixture, sourceWorldId, cloned)
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('events_count_mismatch')
    fixture.close()
  })

  it('reports evidence_incomplete when an active timeline loses complete evidence', async () => {
    const fixture = createTestDb()
    const { cloned, sourceWorldId } = await cloneGuestSandbox(fixture, 'verify-evidence')
    await fixture.db.delete(universeEvidence).where(eq(universeEvidence.timelineId, cloned.mainTimelineId))
    const result = await verify(fixture, sourceWorldId, cloned)
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('evidence_incomplete')
    fixture.close()
  })

  it('reports scene_revision_missing when the cloned world has no scene revision', async () => {
    const fixture = createTestDb()
    const { cloned, sourceWorldId } = await cloneGuestSandbox(fixture, 'verify-scene')
    await fixture.db.delete(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, cloned.worldId))
    const result = await verify(fixture, sourceWorldId, cloned)
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('scene_revision_missing')
    fixture.close()
  })

  it('reports dangling_fact_command when a fact points at an unknown command', async () => {
    const fixture = createTestDb()
    const { cloned, sourceWorldId } = await cloneGuestSandbox(fixture, 'verify-fact')
    // 指令/事实有不可变触发器(0009),模拟映射缺陷/部分失败留下的坏图须先摘除
    fixture.sqlite.exec('PRAGMA foreign_keys = OFF')
    fixture.sqlite.exec('DROP TRIGGER world_commands_immutable_delete')
    const clonedCommandId = [...cloned.commandIds.values()][0]!
    await fixture.db.delete(worldCommands).where(eq(worldCommands.id, clonedCommandId))
    const result = await verify(fixture, sourceWorldId, cloned)
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('dangling_fact_command')
    fixture.close()
  })

  it('reports projection_count_mismatch when a copied projection is missing', async () => {
    const fixture = createTestDb()
    await fixture.db.insert(users).values([
      { id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() },
      { id: 'member', username: 'member', passwordHash: 'x', createdAt: new Date().toISOString() },
    ])
    await seedDemoWorld(fixture.db)
    const guest = await createGuestSession(fixture.db, 'verify-projection')
    await fixture.db.insert(voxelEventProjections).values({
      id: `vep:${guest.timelineId}:cluster-1`, timelineId: guest.timelineId,
      payloadJson: JSON.stringify({ event: { id: 'evt-1' }, sourceEventIds: [], copySource: 'template' }),
      createdVersion: 1,
    })
    const cloned = await cloneWorldGraph(fixture.db, {
      sourceWorldId: guest.worldId, targetOwnerId: 'member', requestId: 'verify-projection', name: '核验目标世界',
    })
    // 投影应随克隆复制;删掉克隆侧一条 → 计数不一致
    await fixture.db.delete(voxelEventProjections)
      .where(eq(voxelEventProjections.timelineId, cloned.mainTimelineId))
    const result = await verify(fixture, guest.worldId, cloned)
    expect(result.ok).toBe(false)
    expect(result.issues.map(issue => issue.code)).toContain('projection_count_mismatch')
    fixture.close()
  })
})

async function hashSceneDocument(documentJson: string, version: number): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ document: JSON.parse(documentJson), version })))
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** A1 B31/B32：克隆接入批内证明工厂后的行为核验 */
describe('A1 clone compatibility', () => {
  it('策略激活后克隆成功：clone-copy 证明指向源世界与目标归属，哈希对应新文档', async () => {
    const fixture = createTestDb()
    try {
      await fixture.db.insert(users).values([
        { id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() },
      ])
      await seedDemoWorld(fixture.db)
      // 策略激活：此后无证明/旧证明的裸插入都会被闸门拒绝
      fixture.sqlite.exec(await buildTestPolicyActivationSql())
      const baseline = await fixture.db.select().from(demoBaselines).where(eq(demoBaselines.status, 'active')).get()
      expect(baseline).toBeDefined()

      // 访客沙盒创建即一次真实克隆（基线世界 → 沙盒世界）；旧裸插入路径会在此 ABORT
      const guest = await createGuestSession(fixture.db, 'a1-clone-guest')
      const session = await fixture.db.select().from(guestSessions).where(eq(guestSessions.id, guest.sessionId)).get()

      const pointer = await fixture.db.select().from(worldScenes).where(eq(worldScenes.worldId, guest.worldId)).get()
      expect(pointer).toBeDefined()
      const revisions = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, guest.worldId)).all()
      expect(revisions.length).toBeGreaterThan(0)
      const sourceRevisions = await fixture.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, baseline!.worldId)).all()
      const sourceByVersion = new Map(sourceRevisions.map(row => [row.version, row]))
      for (const row of revisions) {
        expect(row.validationJson).not.toBeNull()
        const proof = JSON.parse(row.validationJson!) as SceneWriteProof
        expect(proof.mode).toBe('clone-copy')
        if (proof.mode !== 'clone-copy') continue
        // 来源指向源世界同一版本修订，归属指向目标世界 owner
        expect(proof.source).toEqual({
          worldId: baseline!.worldId,
          version: row.version,
          contentHash: sourceByVersion.get(row.version)!.contentHash,
        })
        expect(proof.targetOwnerId).toBe(session!.ownerUserId)
        // 哈希与目标世界实际存储的新文档一致（不是源行哈希的逐字复制声明）
        expect(row.contentHash).toBe(await hashSceneDocument(row.documentJson, row.version))
        expect(proof.candidate).toEqual({ version: row.version, contentHash: row.contentHash })
        expect(row.commitGuard).toBe(true)
      }
    } finally { fixture.close() }
  })

  it('复制失败不部分落库：克隆批任一语句失败时场景/世界资料整批回滚', async () => {
    const fixture = createTestDb()
    try {
      await fixture.db.insert(users).values([
        { id: 'admin', username: 'admin', passwordHash: 'x', createdAt: new Date().toISOString() },
      ])
      await seedDemoWorld(fixture.db)
      fixture.sqlite.exec(await buildTestPolicyActivationSql())
      const baseline = await fixture.db.select().from(demoBaselines).where(eq(demoBaselines.status, 'active')).get()
      const sceneWorldCount = (await fixture.db.select().from(worldScenes).all()).length
      const revisionCount = (await fixture.db.select().from(worldSceneRevisions).all()).length

      // 注入只在克隆批中段引爆的故障：场景修订插入必败
      fixture.sqlite.exec(`CREATE TRIGGER fail_clone_scene BEFORE INSERT ON world_scene_revisions
        WHEN NEW.world_id != '${baseline!.worldId}'
        BEGIN SELECT RAISE(ABORT, 'forced clone scene failure'); END`)
      await expect(createGuestSession(fixture.db, 'a1-clone-rollback')).rejects.toThrow('forced clone scene failure')
      fixture.sqlite.exec('DROP TRIGGER fail_clone_scene')

      // 没有任何半成品：指针/修订/世界行数与故障前一致
      expect((await fixture.db.select().from(worldScenes).all()).length).toBe(sceneWorldCount)
      expect((await fixture.db.select().from(worldSceneRevisions).all()).length).toBe(revisionCount)

      // 故障解除后干净重试成功
      const guest = await createGuestSession(fixture.db, 'a1-clone-rollback')
      expect(await fixture.db.select().from(worldScenes).where(eq(worldScenes.worldId, guest.worldId)).get()).toBeDefined()
    } finally { fixture.close() }
  })
})
