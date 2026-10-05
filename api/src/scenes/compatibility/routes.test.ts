import { afterEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { applyEdits, createEmptyWorld, serialize, type SerializedVoxelDocument } from '@possibility/voxel-contract'
import { compatibilityRoutes } from './routes'
import { commitScene } from '../repository'
import { createWorldFixture } from '../../test/world-fixture'
import { worldSceneRevisions } from '../../db/schema'

type Fixture = Awaited<ReturnType<typeof createWorldFixture>>
type Ops = Parameters<typeof applyEdits>[1]

const owner = { Authorization: 'Bearer owner-token', 'Content-Type': 'application/json' }

/** 合法体素信封:平地 */
function validEnvelope(): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'compat-valid')
  const doc = applyEdits(base, [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
  ]).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

/** 可修复信封:白名单植被 veg-flower-a 与石灯笼碰撞(修复=挪走花) */
function repairableEnvelope(): SerializedVoxelDocument {
  const base = createEmptyWorld({ width: 16, height: 16, depth: 16 }, 'mist-manor', 'compat-repair')
  const ops: Ops = [
    { kind: 'fill', from: { x: 0, y: 0, z: 0 }, to: { x: 15, y: 0, z: 15 }, block: 'grass' },
    { kind: 'place-object', objectId: 'lantern-1', objectType: 'stone-lantern', anchor: { x: 2, y: 1, z: 2 }, rotation: 0 },
    { kind: 'place-asset', assetId: 'veg-flower-a', placementId: 'flower-1', anchor: { x: 2, y: 1, z: 2 }, rotation: 0 },
  ]
  const doc = applyEdits(base, ops).document
  return JSON.parse(serialize(doc)) as SerializedVoxelDocument
}

async function seedScene(f: Fixture, document: SerializedVoxelDocument, requestId = 'seed-1') {
  return commitScene(f.db, { worldId: 'home-world', expectedVersion: 0, requestId, document, summary: 'seed', kind: 'initial' })
}

function call(f: Fixture, path: string, init?: RequestInit) {
  return compatibilityRoutes.request(path, init, f.env)
}

function post(f: Fixture, path: string, body: unknown, headers: Record<string, string> = owner) {
  return call(f, path, { method: 'POST', headers, body: JSON.stringify(body) })
}

async function revisionCount(f: Fixture, worldId = 'home-world') {
  return (await f.db.select().from(worldSceneRevisions).where(eq(worldSceneRevisions.worldId, worldId)).all()).length
}

/** 响应里绝不允许出现的敏感字段名(精确键名匹配,递归) */
const FORBIDDEN_KEYS = new Set([
  'candidate', 'actorKey', 'leaseToken', 'buildLease', 'buildLeaseToken', 'buildLeaseUntil',
  'requestFingerprint', 'credentials',
])

function forbiddenKeyPaths(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...forbiddenKeyPaths(item, `${path}[${index}]`)))
    return hits
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) hits.push(`${path}.${key}`)
      hits.push(...forbiddenKeyPaths(nested, `${path}.${key}`))
    }
  }
  return hits
}

function documentKeyPaths(value: unknown, path = '$'): string[] {
  const hits: string[] = []
  if (Array.isArray(value)) {
    value.forEach((item, index) => hits.push(...documentKeyPaths(item, `${path}[${index}]`)))
    return hits
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'document') hits.push(`${path}.${key}`)
      hits.push(...documentKeyPaths(nested, `${path}.${key}`))
    }
  }
  return hits
}

function expectRedacted(body: unknown) {
  expect(forbiddenKeyPaths(body)).toEqual([])
  const text = JSON.stringify(body)
  expect(text).not.toContain('actorKey')
  expect(text).not.toContain('leaseToken')
  expect(text).not.toContain('requestFingerprint')
}

const base = '/worlds/home-world/scene/compatibility'

describe('compatibility HTTP routes', () => {
  const fixtures: Fixture[] = []
  afterEach(() => { fixtures.splice(0).forEach(f => f.close()) })

  describe('auth failure', () => {
    it('rejects missing and forged tokens on inspection, drafts and confirm', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      const forged = { Authorization: 'Bearer forged-token', 'Content-Type': 'application/json' }

      for (const headers of [{} as Record<string, string>, forged]) {
        const inspection = await call(f, `${base}/inspection`, { headers })
        expect(inspection.status).toBe(401)
        const drafts = await post(f, `${base}/drafts`, {}, headers)
        expect(drafts.status).toBe(401)
        const confirm = await post(f, `${base}/confirm`, {}, headers)
        expect(confirm.status).toBe(401)
      }
    })
  })

  describe('foreign world 404', () => {
    it('returns the same 404 for foreign and nonexistent worlds on inspection and drafts', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      const foreignInspection = await call(f, '/worlds/other-world/scene/compatibility/inspection', { headers: owner })
      const missingInspection = await call(f, '/worlds/no-such-world/scene/compatibility/inspection', { headers: owner })
      expect(foreignInspection.status).toBe(404)
      expect(missingInspection.status).toBe(404)
      expect(await foreignInspection.json()).toEqual(await missingInspection.json())

      const draftBody = { draftRequestId: 'foreign-1', purpose: 'repair-current', expectedCurrentVersion: 1 }
      const foreignDrafts = await post(f, '/worlds/other-world/scene/compatibility/drafts', draftBody)
      const missingDrafts = await post(f, '/worlds/no-such-world/scene/compatibility/drafts', draftBody)
      expect(foreignDrafts.status).toBe(404)
      expect(missingDrafts.status).toBe(404)
      expect(await foreignDrafts.json()).toEqual(await missingDrafts.json())
    })
  })

  describe('inspection', () => {
    it('returns 200 with a report for a valid scene, supports history, and rejects bad versions', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, validEnvelope())
      await commitScene(f.db, { worldId: 'home-world', expectedVersion: 1, requestId: 'seed-2', document: validEnvelope(), summary: 'seed2', kind: 'voxel-edit' })

      const current = await call(f, `${base}/inspection`, { headers: owner })
      expect(current.status).toBe(200)
      const currentBody = await current.json() as Record<string, unknown>
      expect(currentBody.status).toBe('ready')
      expect(currentBody.report).toBeTruthy()
      expect((currentBody.source as { version: number }).version).toBe(2)
      expect(currentBody.canCreateRepairDraft).toBe(false)

      const history = await call(f, `${base}/inspection?version=1`, { headers: owner })
      expect(history.status).toBe(200)
      const historyBody = await history.json() as Record<string, unknown>
      expect(historyBody.status).toBe('ready')
      expect((historyBody.source as { version: number }).version).toBe(1)

      const bad = await call(f, `${base}/inspection?version=abc`, { headers: owner })
      expect(bad.status).toBe(400)
      expect(await bad.json()).toMatchObject({ errorCode: 'request-mismatch' })
    })

    it('flags an invalid repairable scene as draftable', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, repairableEnvelope())
      const res = await call(f, `${base}/inspection`, { headers: owner })
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; canCreateRepairDraft: boolean; report: { status: string; issueCount: number } }
      expect(body.status).toBe('ready')
      expect(body.report.status).toBe('invalid')
      expect(body.report.issueCount).toBeGreaterThan(0)
      expect(body.canCreateRepairDraft).toBe(true)
    })

    it('returns 404 scene-missing for a world without any scene', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      const res = await call(f, `${base}/inspection`, { headers: owner })
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({ errorCode: 'scene-missing' })
    })
  })

  describe('preflight', () => {
    it('accepts a valid candidate and returns a basis', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, validEnvelope())
      const res = await post(f, `${base}/preflight`, {
        candidate: { kind: 'operations', operations: [{ kind: 'fill', from: { x: 0, y: 1, z: 0 }, to: { x: 0, y: 1, z: 0 }, block: 'stone' }] },
      })
      expect(res.status).toBe(200)
      const body = await res.json() as Record<string, unknown>
      expect(body.status).toBe('valid')
      expect(body.basis).toBeTruthy()
      expect(body.report).toBeTruthy()
    })

    it('rejects a missing or malformed candidate with 400', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, validEnvelope())

      const missing = await post(f, `${base}/preflight`, {})
      expect(missing.status).toBe(400)
      expect(await missing.json()).toMatchObject({ errorCode: 'request-mismatch' })

      const malformed = await post(f, `${base}/preflight`, { candidate: { kind: 'nonsense' } })
      expect(malformed.status).toBe(400)

      const notJson = await call(f, `${base}/preflight`, { method: 'POST', headers: owner, body: 'not-json' })
      expect(notJson.status).toBe(400)
    })
  })

  describe('draft creation/read/cancel', () => {
    it('rejects incomplete draft parameters with 400', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      const full = { draftRequestId: 'd-1', purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1 }

      const noRequestId = await post(f, `${base}/drafts`, { ...full, draftRequestId: undefined })
      expect(noRequestId.status).toBe(400)
      const noPurpose = await post(f, `${base}/drafts`, { ...full, purpose: undefined })
      expect(noPurpose.status).toBe(400)
      const noVersion = await post(f, `${base}/drafts`, { ...full, expectedCurrentVersion: undefined })
      expect(noVersion.status).toBe(400)
      // restore-history 缺 target 时目标缺省为 current,与用途不匹配 → 400
      const noTarget = await post(f, `${base}/drafts`, { draftRequestId: 'd-1', purpose: 'restore-history', expectedCurrentVersion: 1 })
      expect(noTarget.status).toBe(400)
      const mismatch = await post(f, `${base}/drafts`, { ...full, target: { kind: 'history', version: 1 } })
      expect(mismatch.status).toBe(400)
    })

    it('creates, reads and cancels a repair draft for an invalid scene', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, repairableEnvelope())

      const created = await post(f, `${base}/drafts`, {
        draftRequestId: 'draft-happy-1', purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1,
      })
      expect(created.status).toBe(200)
      const draft = await created.json() as { id: string; status: string; previewSpaces: unknown[]; canConfirm: boolean; changes: { total: number } }
      expect(draft.id).toBeTruthy()
      expect(draft.status).toBe('ready')
      expect(Array.isArray(draft.previewSpaces)).toBe(true)
      expect(draft.previewSpaces.length).toBeGreaterThan(0)
      expect(draft.canConfirm).toBe(true)
      expect(draft.changes.total).toBeGreaterThan(0)

      const read = await call(f, `${base}/drafts/${draft.id}`, { headers: owner })
      expect(read.status).toBe(200)
      const readBody = await read.json() as { id: string; status: string; canConfirm: boolean }
      expect(readBody.id).toBe(draft.id)
      expect(readBody.status).toBe('ready')
      expect(readBody.canConfirm).toBe(true)

      const cancelled = await post(f, `${base}/drafts/${draft.id}/cancel`, {})
      expect(cancelled.status).toBe(200)
      expect(await cancelled.json()).toMatchObject({ id: draft.id, status: 'cancelled' })

      const confirm = await post(f, `${base}/confirm`, {
        draftId: draft.id, requestId: 'confirm-cancelled-1', expectedCurrentVersion: 1, expectedAttempt: 0,
      })
      expect(confirm.status).toBeGreaterThanOrEqual(400)
      expect(confirm.status).not.toBe(200)
      expect(await revisionCount(f)).toBe(1)
    })
  })

  describe('confirmation', () => {
    it('runs the full repair chain, commits exactly one revision, and is idempotent per requestId', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, repairableEnvelope())
      expect(await revisionCount(f)).toBe(1)

      const created = await post(f, `${base}/drafts`, {
        draftRequestId: 'draft-confirm-1', purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1,
      })
      expect(created.status).toBe(200)
      const draft = await created.json() as { id: string; status: string; canConfirm: boolean }
      expect(draft.status).toBe('ready')
      expect(draft.canConfirm).toBe(true)

      const confirmBody = { draftId: draft.id, requestId: 'confirm-1', expectedCurrentVersion: 1, expectedAttempt: 0 }
      const confirmed = await post(f, `${base}/confirm`, confirmBody)
      expect(confirmed.status).toBe(200)
      const result = await confirmed.json() as { status: string; attempt: number; result: Record<string, unknown> }
      expect(result.status).toBe('completed')
      expect(result.result).toMatchObject({ worldId: 'home-world', version: 2, requestId: 'confirm-1', outcome: 'repaired-current' })
      expect(documentKeyPaths(result)).toEqual([])
      expect(await revisionCount(f)).toBe(2)

      const replayed = await post(f, `${base}/confirm`, confirmBody)
      expect(replayed.status).toBe(200)
      const replayedBody = await replayed.json() as { status: string; result: Record<string, unknown> }
      expect(replayedBody.status).toBe('completed')
      expect(replayedBody.result).toEqual(result.result)
      expect(await revisionCount(f)).toBe(2)
    })
  })

  describe('request recovery', () => {
    it('reports unknown requests as missing and validates recover parameters', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      const missing = await call(f, `${base}/requests/unknown-request`, { headers: owner })
      expect(missing.status).toBe(200)
      expect(await missing.json()).toMatchObject({ status: 'missing' })

      const emptyRecover = await post(f, `${base}/requests/unknown-request/recover`, {})
      expect(emptyRecover.status).toBe(400)
      const partialRecover = await post(f, `${base}/requests/unknown-request/recover`, { draftId: 'd-1', expectedCurrentVersion: 1 })
      expect(partialRecover.status).toBe(400)
    })

    it('reads a completed request as a receipt and recovers it without resubmitting', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, repairableEnvelope())
      const created = await post(f, `${base}/drafts`, {
        draftRequestId: 'draft-recover-1', purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1,
      })
      const draft = await created.json() as { id: string }
      const confirmed = await post(f, `${base}/confirm`, {
        draftId: draft.id, requestId: 'confirm-recover-1', expectedCurrentVersion: 1, expectedAttempt: 0,
      })
      expect(confirmed.status).toBe(200)

      const read = await call(f, `${base}/requests/confirm-recover-1`, { headers: owner })
      expect(read.status).toBe(200)
      const readBody = await read.json() as { status: string; result: Record<string, unknown> }
      expect(readBody.status).toBe('completed')
      expect(readBody.result).toMatchObject({ requestId: 'confirm-recover-1', version: 2, outcome: 'repaired-current' })
      expect(documentKeyPaths(readBody)).toEqual([])

      const recovered = await post(f, `${base}/requests/confirm-recover-1/recover`, {
        draftId: draft.id, expectedCurrentVersion: 2, expectedAttempt: 0,
      })
      expect(recovered.status).toBe(200)
      const recoveredBody = await recovered.json() as { status: string; result: Record<string, unknown> }
      expect(recoveredBody.status).toBe('completed')
      expect(recoveredBody.result).toEqual(readBody.result)
      expect(documentKeyPaths(recoveredBody)).toEqual([])
      expect(await revisionCount(f)).toBe(2)
    })
  })

  describe('response redaction', () => {
    it('never leaks candidate, actor identity, lease or fingerprint fields in any 200 response', async () => {
      const f = await createWorldFixture(); fixtures.push(f)
      await seedScene(f, repairableEnvelope())

      const bodies: unknown[] = []

      const inspection = await call(f, `${base}/inspection`, { headers: owner })
      expect(inspection.status).toBe(200)
      bodies.push(await inspection.json())

      const preflight = await post(f, `${base}/preflight`, { candidate: { kind: 'operations', operations: [] } })
      expect(preflight.status).toBe(200)
      bodies.push(await preflight.json())

      const draftA = await post(f, `${base}/drafts`, {
        draftRequestId: 'draft-redact-a', purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1,
      })
      expect(draftA.status).toBe(200)
      const a = await draftA.json() as { id: string }
      bodies.push(a)

      const draftB = await post(f, `${base}/drafts`, {
        draftRequestId: 'draft-redact-b', purpose: 'repair-current', target: { kind: 'current' }, expectedCurrentVersion: 1,
      })
      expect(draftB.status).toBe(200)
      const b = await draftB.json() as { id: string }
      bodies.push(b)

      const read = await call(f, `${base}/drafts/${a.id}`, { headers: owner })
      expect(read.status).toBe(200)
      bodies.push(await read.json())

      const cancelled = await post(f, `${base}/drafts/${b.id}/cancel`, {})
      expect(cancelled.status).toBe(200)
      bodies.push(await cancelled.json())

      const missingRequest = await call(f, `${base}/requests/nope`, { headers: owner })
      expect(missingRequest.status).toBe(200)
      bodies.push(await missingRequest.json())

      const confirmed = await post(f, `${base}/confirm`, {
        draftId: a.id, requestId: 'confirm-redact-1', expectedCurrentVersion: 1, expectedAttempt: 0,
      })
      expect(confirmed.status).toBe(200)
      const confirmedBody = await confirmed.json() as { status: string }
      expect(confirmedBody.status).toBe('completed')
      bodies.push(confirmedBody)

      const requestRead = await call(f, `${base}/requests/confirm-redact-1`, { headers: owner })
      expect(requestRead.status).toBe(200)
      bodies.push(await requestRead.json())

      const recovered = await post(f, `${base}/requests/confirm-redact-1/recover`, {
        draftId: a.id, expectedCurrentVersion: 2, expectedAttempt: 0,
      })
      expect(recovered.status).toBe(200)
      bodies.push(await recovered.json())

      for (const body of bodies) expectRedacted(body)
      // completed 结果只回执,不内嵌完整 document
      for (const body of [confirmedBody, bodies[bodies.length - 2], bodies[bodies.length - 1]]) {
        expect(documentKeyPaths(body)).toEqual([])
      }
      expect(await revisionCount(f)).toBe(2)
    })
  })
})
