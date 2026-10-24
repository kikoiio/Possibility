# Candidate A: durable visit request receipts

## Problem

`last_request_id` remembers one mutation, so an older enter can reopen a closed visit and an older leave can close a newer visit. A leave with no session records nothing. Preserve the current random request IDs and `WorldTimeContext` response while making acceptance durable. Authorization must precede both receipt and session reads. D1 supports transactional, sequential `db.batch`; it does not provide an interactive application transaction spanning an awaited read and write. Therefore the unique receipt insertion and the transition belong in one batch, with uniqueness failure aborting the whole batch.

## Usage (caller's view)

The existing routes retain their calls and wire payloads:

```ts
// POST /worlds/:worldId/visits/enter, after access resolution and payload parsing.
const result = await enterVisit(db, access, {
  worldId, timelineId, clientSessionId, requestId,
})
return c.json({ ...result.context, requestId: result.requestId })

// POST /worlds/:worldId/visits/leave, including cleanup before enter has arrived.
const result = await leaveVisit(db, access, {
  worldId, timelineId, clientSessionId, requestId,
})
return c.json({ ...result.context, requestId: result.requestId })

// A network retry keeps the same request ID and payload.
await enterVisit(db, access, originalInput)
// Returns current context; never reapplies the original transition.
```

The browser hook keeps its stable per-target `clientSessionId` and independent random operation IDs. Each retry of one operation must reuse that operation's ID. This design does not require a new browser counter, lifecycle coordinator, or protocol version.

## Shape

### Data model first

Add `world_visit_requests` with a composite primary key `(principal_key, request_id)`. The request namespace is principal-wide across visit operations and all worlds, timelines, and client sessions. The same string under a different principal is independent. World/target fields are immutable bindings, rather than part of the key; otherwise target reuse could create a second accepted request.

```ts
type VisitOperation = 'enter' | 'leave'
type PrincipalKey = `user:${string}` | `guest:${string}`
type VisitTarget = Readonly<{
  worldId: string
  timelineId: string
  clientSessionId: string
}>

type VisitReceipt = Readonly<{
  principalKey: PrincipalKey
  requestId: string
  acceptedAt: string
} & (
  | { kind: 'request'; operation: VisitOperation; target: VisitTarget }
  | { kind: 'legacy'; operation: null; target: null }
)>
```

The SQL representation flattens `target` into nullable `world_id`, `timeline_id`, and `client_session_id` columns. A CHECK permits either a modern receipt with all binding columns non-null and operation `enter`/`leave`, or a `legacy` tombstone with all binding columns null. `principal_key`, `request_id`, `kind`, and `accepted_at` are NOT NULL. Do not attach target foreign keys or session-row cascades: deleting a visit row or world must not turn an accepted ID into a fresh command. No result snapshot, pending status, claim token, or response bytes are stored. A receipt's existence means the entire batch committed, including a deliberate no-op.

Dominant access patterns are covered immediately: acceptance inserts by composite key; duplicate resolution reads one row by the same key; migration groups existing markers by the same key. Ordinary visit projection never scans receipts. Indefinite receipt retention requires no expiry index.

### Modules and typed boundaries

`api/src/life/visit-sessions.ts` remains the sole visit mutation owner. Keep its two exported operations and error type. Its private dispatcher owns validation, authorization, atomic persistence, conflict interpretation, and final projection. `visit-context.ts` remains the read-only projection owner; routes remain adapters. Schema and migration declare storage, with no new general repository layer or receipt API for callers. This hides the full retry protocol behind the current two operations, per interface-depth and boundary-discipline.

```ts
export interface VisitRequest extends VisitTarget { requestId: string }
export interface VisitResult { context: WorldTimeContext; requestId: string }

export async function enterVisit(
  db: Db, access: AccessContext, input: VisitRequest, now?: Date,
): Promise<VisitResult> { throw new Error('not implemented') }

export async function leaveVisit(
  db: Db, access: AccessContext, input: VisitRequest, now?: Date,
): Promise<VisitResult> { throw new Error('not implemented') }

type AuthorizedCommand = Readonly<{
  operation: VisitOperation
  principal: Principal
  target: VisitTarget
  requestId: string
  simNow: string
  at: string
}>

// Private: authorization creates this value before any visit-state lookup.
async function applyVisit(
  db: Db, access: AccessContext, input: VisitRequest,
  operation: VisitOperation, now: Date,
): Promise<VisitResult> { throw new Error('not implemented') }

// Private: no preflight receipt lookup; all state writes live in this batch.
async function commitVisit(db: Db, command: AuthorizedCommand): Promise<void> {
  throw new Error('not implemented')
}

// Pure: compares every binding, or rejects a legacy tombstone.
function matchesReceipt(receipt: VisitReceipt, command: AuthorizedCommand): boolean {
  throw new Error('not implemented')
}
```

The internal authorized value is not constructible by route callers. IDs and operation are validated at the service boundary. SQL CHECKs defend the persisted tagged union. The key is the sole source of deduplication truth, per encode-lessons-in-structure and single-source-of-truth.

### Atomic D1 flow

1. Validate input and resolve the principal. Call the existing target authorization before querying receipts or sessions; retain capability and world/timeline ownership checks. Obtain `simNow` from that authorized context and capture wall time. No simulation advance or `worldVisits` mutation occurs.
2. Submit exactly one `db.batch` containing a **plain INSERT** into `world_visit_requests` followed by the operation's session statement. Do not use `ON CONFLICT DO NOTHING` for the receipt: an ignored insertion followed by an unconditional transition would replay the mutation.
3. For enter, use a single session INSERT/UPSERT on the existing unique `(principal_key, world_id, timeline_id, client_session_id)` index. Generate the proposed session ID server-side; a conflict retains the winning existing ID. Update status, entry timestamps, latest marker, and update timestamp. Preserve existing exit fields, since they are the return watermark. This removes the application read-before-write race.
4. For leave, issue one scoped UPDATE with `status = 'open'`, setting exit timestamps and the latest marker. Zero changed rows is a successful accepted no-op, including the missing-session case. The receipt still commits.
5. If the batch throws, read the receipt by `(principal_key, request_id)`. A matching modern receipt means an earlier or concurrent identical operation committed: return normally without any write. A modern binding mismatch or legacy tombstone throws `VisitServiceError(..., 409)`. No receipt means the operation was not accepted; propagate the original error. If this lookup itself fails, propagate failure and let a later retry resolve it.
6. After acceptance or exact replay, read the matching scoped client session if present and call the shared projector with its session ID; otherwise use the existing generic visit projection. Assemble `WorldTimeContext` with that current visit projection and echo the request ID. Do not maintain a separate hand-built phase calculation in each mutation.

The batch uses supported Drizzle D1 builders: `db.insert(...).values(...)`, session `onConflictDoUpdate(...)` or `db.update(...).where(...)`, and `db.batch([...])`. Neither raw `BEGIN` nor `changes()` nor an application lock is necessary. D1 guarantees batch statements execute sequentially in one transaction and a statement failure aborts/rolls back the batch. The receipt's composite uniqueness failure therefore prevents the following session transition. Any later statement failure rolls the inserted receipt back. A transport failure after a successful commit is resolved by reading the committed receipt. This is make-operations-idempotent at the storage boundary.

### Responses and distinct concurrent operations

An exact replay returns current authorized context, rather than the original phase, timestamps, or exact bytes. The same current projection path serves first acceptance and replay; another request may commit before projection finishes. A request ID reused for another operation, world, timeline, or client session returns 409 without mutation. Invalid or unauthorized targets still receive the existing authorization result before receipt existence is exposed.

Two batches with the same receipt key serialize at uniqueness: exactly one can insert, so exactly one transition can commit. Two distinct request IDs are distinct operations; both receipts can commit. D1's transaction order determines the final shared session state. Concurrent enters preserve one unique session row. Enter then leave closes it; leave then enter opens it. The simulation timestamp is sampled during authorization, so two overlapping commands need not have timestamps ordered by commit. Do not claim browser-intent ordering from random IDs.

The UI already creates multiple distinct IDs across cleanup, subsequent effect enter, and a late enter response's compensating leave. A late old-lifecycle leave can still close a newer enter; durable receipts prevent repeated application of that leave, but cannot identify which lifecycle it belongs to. Fixing that requires a separately scoped generation/ordering protocol. This candidate deliberately preserves the existing distinct-operation semantics and identifies this limit explicitly, rather than interpreting a fresh random ID as stale.

### Migration, legacy rows, and retention

Add migration `0043_visit_request_receipts.sql` after `0042_time_status_semantics.sql`, reconcile the missing `0042` journal entry, and add the new journal entry in the same implementation. Do not claim the old SQL migration was never applied merely because its journal entry is absent; deployment uses checked-in SQL filenames.

Backfill one `legacy` tombstone for every distinct `(principal_key, last_request_id)` currently stored in `world_visit_sessions`, using grouped insertion. Operation and original target binding cannot be reconstructed: a closed row does not prove which operation owned the last marker. A legacy tombstone always gives 409, even for an apparent exact match; callers must issue a fresh ID for a new operation. Grouping safely handles old IDs reused on multiple session rows. Modern code never treats `last_request_id` as a second deduplication mechanism. Retain the column as a compatibility marker for existing schema consumers, set it on actual mutations, and remove all reads of it from the visit retry logic.

Only surviving latest markers can be backfilled. Earlier overwritten IDs and missing-session leaves from before migration are unknowable; their first post-migration arrival may be treated as new. The indefinite guarantee begins with requests accepted by the new receipt protocol and conservatively covers all recoverable legacy markers. No design can reconstruct absent history without changing what old clients may send.

Deploy with visit writes quiesced, drain old API instances, apply schema/backfill, then enable the new writer. An additive rollout with old writers still active is unsafe: an old writer can mutate state without appending a receipt after backfill. If the deployment system cannot quiesce visit writes, use a temporary route gate during the cutover; do not quietly rely on a narrow timing window.

Retain receipts indefinitely for each principal, across world/timeline/session deletion. Do not copy receipts when cloning/forking/claiming a world: a guest and its claimed user are different principals. No TTL is allowed under the contract because random IDs carry no trustworthy expiry; deleting receipts after 30 days would allow old IDs to mutate again. Permanent principal deletion can delete its receipts only after credentials are irrevocably fenced and that principal key cannot be reused. Until that terminal condition is guaranteed, retain the receipt/tombstone even when guest cleanup removes its other data. The new table has no target or guest FK that would block existing cleanup, and retention is conservative by default.

## Synthesis decision

Selected as the base by the independent cross-judge. The implementation keeps this candidate's durable receipt protocol and current opaque random request IDs.

## Tradeoffs accepted

- We accept an append-only row per accepted operation in exchange for arbitrary-delay retry safety with the current random-ID protocol.
- We accept a failed unique insertion and one indexed lookup on a retry in exchange for a smaller transaction shape without claim tokens, conditional mutation guards, or preflight races.
- We accept current-context responses in exchange for avoiding stored response snapshots and their invalidation/privacy burden.
- We accept 409 for recoverable legacy IDs in exchange for preserving their safety without guessing their operation or original binding.
- We accept D1 commit order for distinct operations in exchange for preserving the existing UI and transport contract; lifecycle ordering remains a separate concern.

## Alternatives considered

- A sequence high-water mark can compress receipt history, but requires a new browser ordering protocol, durable sequence ownership across hook lifecycles, and handling old random-ID clients. It hides journal maintenance while exposing ordering/lifecycle coordination to callers. It does not improve the present interface enough to justify making UI protocol changes part of this repair.
- A receipt insert with `ON CONFLICT DO NOTHING` plus an attempt-token-guarded mutation is viable but adds a persisted claim token and repeats its ownership predicate in every mutation. Plain insert plus transactional rollback hides the same capability behind fewer moving parts.
- A preflight receipt read followed by separate mutation and receipt writes leaves a duplicate race and a crash window. The small-looking API hides no atomicity and makes callers depend on retry timing; reject it.
- A durable object or per-session lock serializes writers but still needs durable receipts for old IDs and adds routing/service state. It hides scheduling while exposing a new infrastructure boundary without removing the journal requirement.

## Implementation reconciliation

Implemented in `api/src/life/visit-sessions.ts`, `api/src/life/visit-context.ts`, `api/src/db/schema.ts`, and migration `api/drizzle/0043_visit_request_receipts.sql`. The service now inserts the receipt and session transition in one D1 batch, resolves retries through receipt lookup, and builds responses through the shared projector. The projector can select by client session ID.

The missing `0042` journal entry is now restored alongside `0043`. Snapshot metadata was regenerated at the post-0041, post-0042, and post-0043 states, with IDs linked to the existing 0040 snapshot. `drizzle-kit generate` confirms the latest snapshot matches the declared schema.

## Open questions and risks

- Can deployment quiesce visit writes and drain old instances for the migration/backfill cutover, or must implementation include a temporary route gate?
- Does future product behavior require old lifecycle leaves to lose to newer enters? If so, should a separate generation protocol be designed rather than extending this deduplication repair implicitly?
- When can principal keys be proved permanently retired, allowing receipt deletion without weakening indefinite replay safety?

## Red-flag screening

The public surface remains two existing operations; callers never reserve, commit, or resolve receipts themselves. Persistence and duplicate policy remain in one mutation owner. The projector has one read-only responsibility and derives response phase for all paths. There is one deduplication mechanism, with no preflight fast path and no `last_request_id` fallback. Receipt internals are private to the owner except for schema/migration declarations. No generated operation list or cross-module protocol list requires manual synchronization.

## Next implementation step

Implementation and static review are complete. Remaining release work is operational: drain or gate old visit writers while applying the migration, then enable the receipt-aware writer.
