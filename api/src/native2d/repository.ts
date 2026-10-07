import { and, asc, eq } from 'drizzle-orm'
import type { Db } from '../db/client'
import type { BatchItem } from 'drizzle-orm/batch'
import { native2dLayoutHeads, native2dLayoutRevisions } from '../db/schema'
import { scopeKey, type Native2dLayout, type Native2dLayoutHead, type Native2dLayoutRequest, type Native2dLayoutRevision, type Native2dSaveInput, type Native2dSaveResult, type Native2dScope } from './schema'
import { validateNative2dLayout } from './validation'

function clone<T>(value: T): T {
  return structuredClone(value)
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export function native2dContentHash(layout: Native2dLayout): string {
  // FNV-1a over canonical JSON is deterministic in Workers and sufficient for
  // idempotency identity; the layout itself remains the source of truth.
  const value = canonical(layout)
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** Fork only each saved current layout; the surrounding fork batch owns all
 * writes, so an invalid layout or failed insert cannot leave a partial child. */
export async function native2dLayoutForkStatements(db: Db, input: {
  worldId: string; sourceTimelineId: string; targetTimelineId: string; requestId: string; createdAt: string
}): Promise<BatchItem<'sqlite'>[]> {
  const heads = await db.select().from(native2dLayoutHeads).where(and(
    eq(native2dLayoutHeads.worldId, input.worldId), eq(native2dLayoutHeads.timelineId, input.sourceTimelineId)))
  const statements: BatchItem<'sqlite'>[] = []
  for (const head of heads) {
    const revision = await db.select().from(native2dLayoutRevisions).where(and(
      eq(native2dLayoutRevisions.id, head.currentRevisionId), eq(native2dLayoutRevisions.worldId, input.worldId),
      eq(native2dLayoutRevisions.timelineId, input.sourceTimelineId), eq(native2dLayoutRevisions.sceneId, head.sceneId),
      eq(native2dLayoutRevisions.version, head.currentVersion))).get()
    if (!revision) throw new Error('native2d fork source revision is missing')
    const layout = JSON.parse(revision.layoutJson) as Native2dLayout
    if (!validateNative2dLayout(layout).valid || native2dContentHash(layout) !== revision.contentHash) throw new Error('native2d fork source layout is corrupt')
    const copied: Native2dLayout = { ...layout, metadata: { ...layout.metadata, timelineId: input.targetTimelineId, sceneVersion: 1 } }
    const id = `native2d-fork:${input.targetTimelineId}:${head.sceneId}:v1`
    statements.push(db.insert(native2dLayoutRevisions).values({ id, worldId: input.worldId,
      timelineId: input.targetTimelineId, sceneId: head.sceneId, version: 1, parentVersion: null,
      requestId: `${input.requestId}:native2d:${head.sceneId}`, contentHash: native2dContentHash(copied),
      layoutJson: JSON.stringify(copied), createdAt: input.createdAt }))
    statements.push(db.insert(native2dLayoutHeads).values({ worldId: input.worldId, timelineId: input.targetTimelineId,
      sceneId: head.sceneId, currentRevisionId: id, currentVersion: 1, updatedAt: input.createdAt }))
  }
  return statements
}

export interface Native2dRepository {
  save(input: Native2dSaveInput): Promise<Native2dSaveResult>
  /** Reset is a versioned baseline write; history remains intact. */
  reset(input: Native2dSaveInput): Promise<Native2dSaveResult>
  head(scope: Native2dScope): Promise<Native2dLayoutHead | null>
  read(scope: Native2dScope, version?: number): Promise<Native2dLayoutRevision | null>
  request(scope: Native2dScope, requestId: string): Promise<Native2dLayoutRequest | null>
  history(scope: Native2dScope): Promise<readonly Native2dLayoutRevision[]>
}

/** In-process repository. The persistence shape mirrors the SQL tables so it can
 * later be backed by D1 without changing CAS or replay semantics. */
export function createNative2dRepository(_persistence?: unknown): Native2dRepository {
  const heads = new Map<string, Native2dLayoutHead>()
  const revisions = new Map<string, Native2dLayoutRevision[]>()
  const requests = new Map<string, Native2dLayoutRequest>()

  const repository: Native2dRepository = {
    async save(input): Promise<Native2dSaveResult> {
      const key = scopeKey(input)
      // Reject malformed requests before idempotency or head state is touched.
      // An invalid move is a pure rejection and must never create a revision.
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
        || !isScopeValue(input) || !isRequestId(input.requestId)) {
        return invalidRequestResult()
      }
      const validation = validateNative2dLayout(input.layout)
      if (!validation.valid) return { ok: false, kind: 'invalid', validation, message: 'native2d layout failed validation' }
      const hash = native2dContentHash(input.layout)
      const requestKey = `${key}:${JSON.stringify(input.requestId)}`
      const priorRequest = requests.get(requestKey)
      const current = heads.get(key) ?? null
      if (priorRequest) {
        if (priorRequest.contentHash === hash && priorRequest.expectedVersion === input.expectedVersion) {
          const revision = revisions.get(key)?.find((item) => item.version === priorRequest.resultVersion)
          if (revision) return { ok: true, kind: 'replayed', revision: clone(revision), head: clone(heads.get(key)!) }
        }
        return { ok: false, kind: 'conflict', code: 'request_conflict', head: current ? clone(current) : null, message: 'requestId was already used for a different layout request' }
      }
      const metadataScope = scopeKey(input.layout.metadata)
      if (metadataScope !== key) {
        return {
          ok: false,
          kind: 'invalid',
          validation: { valid: false, issues: [{ code: 'invalid_scope', message: 'Request scope, layout scope, and requestId must be consistent' }] },
          message: 'native2d request scope is invalid',
        }
      }
      const actualVersion = current?.currentVersion ?? 0
      if (input.expectedVersion !== actualVersion) {
        return { ok: false, kind: 'conflict', code: 'version_conflict', head: current ? clone(current) : null, message: `expected version ${input.expectedVersion} does not match current version ${actualVersion}` }
      }
      const now = input.now ?? new Date().toISOString()
      const version = actualVersion + 1
      const revision: Native2dLayoutRevision = {
        worldId: input.worldId, timelineId: input.timelineId, sceneId: input.sceneId,
        version, parentVersion: current?.currentVersion ?? null, requestId: input.requestId,
        contentHash: hash, layout: clone(input.layout), createdAt: now,
      }
      const nextHead: Native2dLayoutHead = { worldId: input.worldId, timelineId: input.timelineId, sceneId: input.sceneId, currentVersion: version, updatedAt: now }
      const request: Native2dLayoutRequest = { worldId: input.worldId, timelineId: input.timelineId, sceneId: input.sceneId, requestId: input.requestId, contentHash: hash, expectedVersion: input.expectedVersion, resultVersion: version }
      revisions.set(key, [...(revisions.get(key) ?? []), revision])
      heads.set(key, nextHead)
      requests.set(requestKey, request)
      return { ok: true, kind: 'created', revision: clone(revision), head: clone(nextHead) }
    },
    async reset(input): Promise<Native2dSaveResult> {
      return repository.save(input)
    },
    async head(scope) { return clone(heads.get(scopeKey(scope)) ?? null) },
    async read(scope, version) {
      const rows = revisions.get(scopeKey(scope)) ?? []
      const selected = version === undefined ? rows.at(-1) : rows.find((item) => item.version === version)
      return clone(selected ?? null)
    },
    async request(scope, requestId) { return clone(requests.get(`${scopeKey(scope)}:${JSON.stringify(requestId)}`) ?? null) },
    async history(scope) { return clone(revisions.get(scopeKey(scope)) ?? []) },
  }
  return repository
}

/** D1-backed repository used by authenticated account worlds. Head CAS and the
 * immutable revision append execute in one D1 batch; the browser is only a cache. */
export function createD1Native2dRepository(db: Db): Native2dRepository {
  const whereScope = (scope: Native2dScope) => [
    eq(native2dLayoutRevisions.worldId, scope.worldId),
    eq(native2dLayoutRevisions.timelineId, scope.timelineId),
    eq(native2dLayoutRevisions.sceneId, scope.sceneId),
  ] as const
  const readHeadRow = async (scope: Native2dScope) => db.select().from(native2dLayoutHeads).where(and(
    eq(native2dLayoutHeads.worldId, scope.worldId),
    eq(native2dLayoutHeads.timelineId, scope.timelineId),
    eq(native2dLayoutHeads.sceneId, scope.sceneId),
  )).get()
  const headValue = (row: typeof native2dLayoutHeads.$inferSelect | null | undefined): Native2dLayoutHead | null => row ? ({
    worldId: row.worldId, timelineId: row.timelineId, sceneId: row.sceneId,
    currentVersion: row.currentVersion, updatedAt: row.updatedAt,
  }) : null
  const revisionValue = (row: typeof native2dLayoutRevisions.$inferSelect | undefined): Native2dLayoutRevision | null => row ? ({
    worldId: row.worldId, timelineId: row.timelineId, sceneId: row.sceneId,
    version: row.version, parentVersion: row.parentVersion, requestId: row.requestId,
    contentHash: row.contentHash, layout: JSON.parse(row.layoutJson) as Native2dLayout, createdAt: row.createdAt,
  }) : null
  const readRequestRow = async (scope: Native2dScope, requestId: string) => db.select().from(native2dLayoutRevisions).where(
    and(...whereScope(scope), eq(native2dLayoutRevisions.requestId, requestId)),
  ).get()

  const repository: Native2dRepository = {
    async save(input): Promise<Native2dSaveResult> {
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0
        || !isScopeValue(input) || !isRequestId(input.requestId)) return invalidRequestResult()
      const validation = validateNative2dLayout(input.layout)
      if (!validation.valid) return { ok: false, kind: 'invalid', validation, message: 'native2d layout failed validation' }
      const hash = native2dContentHash(input.layout)
      const prior = await readRequestRow(input, input.requestId)
      if (prior) {
        if (prior.contentHash === hash && (prior.parentVersion ?? 0) === input.expectedVersion) {
          const revision = revisionValue(prior)
          const head = headValue(await readHeadRow(input))
          if (revision && head) return { ok: true, kind: 'replayed', revision: clone(revision), head: clone(head) }
        }
        return { ok: false, kind: 'conflict', code: 'request_conflict', head: headValue(await readHeadRow(input)), message: 'requestId was already used for a different layout request' }
      }
      if (scopeKey(input.layout.metadata) !== scopeKey(input)) {
        return { ok: false, kind: 'invalid', validation: { valid: false, issues: [{ code: 'invalid_scope', message: 'Request scope and layout metadata do not match' }] }, message: 'native2d request scope is invalid' }
      }
      const current = await readHeadRow(input)
      const actualVersion = current?.currentVersion ?? 0
      if (actualVersion !== input.expectedVersion) {
        return { ok: false, kind: 'conflict', code: 'version_conflict', head: headValue(current), message: `expected version ${input.expectedVersion} does not match current version ${actualVersion}` }
      }
      const now = input.now ?? new Date().toISOString()
      const version = actualVersion + 1
      const revisionId = crypto.randomUUID()
      const revision: Native2dLayoutRevision = {
        worldId: input.worldId, timelineId: input.timelineId, sceneId: input.sceneId,
        version, parentVersion: current?.currentVersion ?? null, requestId: input.requestId,
        contentHash: hash, layout: clone(input.layout), createdAt: now,
      }
      const headWrite = db.insert(native2dLayoutHeads).values({
        worldId: input.worldId, timelineId: input.timelineId, sceneId: input.sceneId,
        currentRevisionId: revisionId, currentVersion: version, updatedAt: now,
      }).onConflictDoUpdate({
        target: [native2dLayoutHeads.worldId, native2dLayoutHeads.timelineId, native2dLayoutHeads.sceneId],
        set: { currentRevisionId: revisionId, currentVersion: version, updatedAt: now },
        setWhere: eq(native2dLayoutHeads.currentVersion, input.expectedVersion),
      })
      const revisionWrite = db.insert(native2dLayoutRevisions).values({
        id: revisionId, worldId: input.worldId, timelineId: input.timelineId, sceneId: input.sceneId,
        version, parentVersion: current?.currentVersion ?? null, requestId: input.requestId,
        contentHash: hash, layoutJson: JSON.stringify(input.layout), createdAt: now,
      }).onConflictDoNothing()
      await db.batch([headWrite, revisionWrite])
      const savedHeadRow = await readHeadRow(input)
      const savedHead = headValue(savedHeadRow)
      if (savedHeadRow?.currentRevisionId !== revisionId) {
        const racedRequest = await readRequestRow(input, input.requestId)
        if (racedRequest?.contentHash === hash && (racedRequest.parentVersion ?? 0) === input.expectedVersion) {
          const racedRevision = revisionValue(racedRequest)
          if (racedRevision && savedHead) return { ok: true, kind: 'replayed', revision: racedRevision, head: savedHead }
        }
        return { ok: false, kind: 'conflict', code: 'version_conflict', head: savedHead, message: 'scene layout changed; reload before saving' }
      }
      return { ok: true, kind: 'created', revision, head: savedHead! }
    },
    async reset(input) { return repository.save(input) },
    async head(scope) { return headValue(await readHeadRow(scope)) },
    async read(scope, version) {
      if (version === undefined) {
        const head = await readHeadRow(scope)
        if (!head) return null
        const row = await db.select().from(native2dLayoutRevisions).where(eq(native2dLayoutRevisions.id, head.currentRevisionId)).get()
        return revisionValue(row)
      }
      const row = await db.select().from(native2dLayoutRevisions).where(
        and(...whereScope(scope), eq(native2dLayoutRevisions.version, version)),
      ).get()
      return revisionValue(row)
    },
    async request(scope, requestId) {
      const row = await readRequestRow(scope, requestId)
      return row ? { worldId: row.worldId, timelineId: row.timelineId, sceneId: row.sceneId,
        requestId: row.requestId, contentHash: row.contentHash, expectedVersion: row.parentVersion ?? 0, resultVersion: row.version } : null
    },
    async history(scope) {
      const rows = await db.select().from(native2dLayoutRevisions).where(
        and(...whereScope(scope)),
      ).orderBy(asc(native2dLayoutRevisions.version)).all()
      return rows.flatMap(row => { const value = revisionValue(row); return value ? [value] : [] })
    },
  }
  return repository
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128
}

function isScopeValue(value: Native2dSaveInput): boolean {
  return [value.worldId, value.timelineId, value.sceneId].every(
    (item) => typeof item === 'string' && item.trim().length > 0,
  )
}

function invalidRequestResult(): Native2dSaveResult {
  return {
    ok: false,
    kind: 'invalid',
    validation: {
      valid: false,
      issues: [{ code: 'invalid_scope', message: 'Request scope, expectedVersion, and requestId are invalid' }],
    },
    message: 'native2d request is invalid',
  }
}

export const createLayoutRepository = createNative2dRepository
export const saveNative2dLayout = (repository: Native2dRepository, input: Native2dSaveInput) => repository.save(input)
export const commitNative2dLayout = saveNative2dLayout
export const saveLayout = saveNative2dLayout

export async function readNative2dHead(repository: Native2dRepository, scope: Native2dScope) {
  return repository.head(scope)
}

export async function readNative2dLayout(repository: Native2dRepository, scope: Native2dScope, version?: number) {
  return repository.read(scope, version)
}
