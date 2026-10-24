# Candidate B: sequenced session high-water mark

## Problem

Visit writes currently carry independent random request IDs, while the only persisted marker is the latest ID on a session row. A latest-only marker cannot recognize an old ID after a later write, nor remember a leave for a session that has no row. This candidate removes that gap without a request journal by making each request ID a canonical, target-bound encoding of a monotonically increasing operation sequence and by storing the accepted high-water mark on the unique client-session row. It requires a coordinated API/client protocol change; opaque random request IDs cannot provide the same guarantee with only one stored marker.

## Usage (caller's view)

The page still gives the visit service a target and a stable browser client-session ID. The hook owns one monotonically increasing sequence for that client session and asks the API client to construct a request ID from the operation, target, and sequence. Callers do not create opaque request IDs themselves.

```ts
const visits = createWorldVisitClient(api, {
  worldId,
  timelineId,
  clientSessionId,
  sequence: loadSequenceForThisClientSession(),
})

await visits.enter() // reserves sequence 1 and sends its canonical request ID
await visits.leave() // reserves sequence 2, even if enter is still in flight
```

The hook's two relevant call sites become:

```ts
// Effect start
const enter = visits.enter()

// Cleanup; reserves the next sequence synchronously before sending
void visits.leave()
```

```ts
// If an enter resolves after cleanup, cleanup already allocated the next
// sequence. This call is either deduplicated by the lifecycle owner or uses
// the next sequence; it never resends the enter ID as a leave ID.
if (enterFinishedAfterCleanup) void visits.leave()
```

Sequence allocation must occur synchronously before the async request starts. A hook-local allocator serializes increments for overlapping lifecycle calls. Persisting the sequence beside the client session ID lets a page reload continue the same stream. If browser storage is unavailable or inconsistent, the hook creates a fresh random client session ID and starts at sequence 1; the fallback must not use the shared deterministic `worldId:timelineId` value, which can make tabs share an actor identity. A duplicated tab may copy both values, so the server treats conflicting use of the same sequence as a conflict; the client rotates to a fresh client session before retrying that new logical operation.

## Shape

### Data model

Keep one row for each `(principal, world, timeline, clientSessionId)`. Extend it with:

```ts
type VisitOperation = 'enter' | 'leave'

interface VisitOperationMark {
  sequence: number              // accepted high-water mark, starts at 0
  requestId: string             // canonical token for the mark below
  operation: VisitOperation
  targetDigest: string          // digest of worldId, timelineId, clientSessionId
}

interface VisitSessionRow {
  // Existing identity, projection, and timestamps remain.
  hasEntered: boolean           // false for a leave-only tombstone
  operationSequence: number
  lastRequestId: string
  lastOperation: VisitOperation
  lastTargetDigest: string
}
```

`hasEntered` distinguishes a high-water tombstone created by leave-before-enter from an actual visit. The projector ignores rows where `hasEntered = false` when selecting an open or exited visit, while the mutation service still finds that row by its unique client-session key. On a leave-only row, the existing non-null entry timestamps may be initialized to the authorized current simulation and wall times as storage-required placeholders; they are not visit evidence while `hasEntered` is false. A later accepted enter sets `hasEntered = true`, establishes real entry timestamps, and clears exit timestamps.

The request ID is no longer arbitrary text. It has a versioned canonical representation:

```ts
type VisitRequestId = string & { readonly __brand: 'VisitRequestId' }

function makeVisitRequestId(input: {
  operation: VisitOperation
  worldId: string
  timelineId: string
  clientSessionId: string
  sequence: number
}): VisitRequestId
```

The token contains the protocol version and sequence and a collision-resistant digest over the operation and complete target. The digest prevents the same token from validating for a different operation, world, timeline, or client session. The server parses and recomputes the token at the request boundary. A plain random ID is rejected on the new protocol. The authenticated principal is deliberately not in the token: user and guest rows remain isolated by the existing principal key, so the same browser request cannot cross-read or mutate the other principal's row.

### Module map and signatures

```ts
// web/src/world/useWorldVisit.ts
interface VisitSequenceStore {
  loadOrCreate(target: VisitTarget): Promise<{
    clientSessionId: string
    nextSequence(): number // synchronous reservation after store initialization
  }>
}

// web/src/api/client.ts, private to visit API methods
function postVisitOperation(
  operation: VisitOperation,
  target: VisitTarget,
  sequence: number,
): Promise<VisitResult>
// Constructs the canonical requestId; callers cannot supply a mismatched ID.

// api/src/life/visit-sessions.ts
export async function enterVisit(
  db: Db, access: AccessContext, input: SequencedVisitRequest, now?: Date,
): Promise<VisitResult>

export async function leaveVisit(
  db: Db, access: AccessContext, input: SequencedVisitRequest, now?: Date,
): Promise<VisitResult>

interface SequencedVisitRequest extends VisitTarget {
  sequence: number
  requestId: VisitRequestId
}

// Private service helpers own token validation, SQL construction, and
// interpreting the post-write row. Routes continue to authorize through the
// existing service path and return the existing WorldTimeContext contract.
```

The public surface exposes one operation call per lifecycle action. It hides token encoding, digesting, sequence reservation, SQL conflict predicates, tombstone handling, and outcome classification. Storage types and request-token format stay private to the API/client boundary; `VisitContext` and `WorldTimeContext` remain the only response contract.

### Atomic D1 flow

1. Keep input validation and `readWorldTimeContext` authorization ahead of all visit-session reads and writes. Derive the existing user or guest principal only after validating the route input.
2. Parse the canonical request token and verify its operation, target digest, and sequence against the request body. This rejects cross-operation and cross-target reuse before persistence.
3. Execute exactly one D1 statement for the session transition: an INSERT with conflict update on the existing unique `(principal_key, world_id, timeline_id, client_session_id)` key. Its conflict-update clause is guarded by `world_visit_sessions.operation_sequence < excluded.operation_sequence` (and the insert path applies to the first sequence). It writes the new high-water mark and all transition columns in that same statement. A first leave inserts a `has_entered = false` tombstone. An enter marks it true and sets entry data; a leave closes it only if it was entered/open, while still recording its higher sequence when already closed.
4. Read the row after the statement and classify the request: equal sequence plus equal canonical token/operation is an exact latest replay; lower sequence is stale; equal sequence with any different mark is a sequence collision; greater sequence accepted by the statement is current. Because reads can observe a later concurrent accepted operation, response assembly always uses the current row and current authorized time context, consistent with the existing contract that exact original response bytes are not retained.

D1's `batch()` is atomic, but a batch containing a CAS statement followed by an unconditional state update is not sufficient: on replay the failed CAS leaves the matching high-water value in place and the second statement can still repeat the transition. The UPSERT must put the compare predicate and state assignments in the same SQL statement. Drizzle's conflict-update API must be checked for a supported conditional `WHERE` on the conflict action; if it cannot express this shape, use a parameterized SQL statement through the existing D1 binding rather than splitting ownership or relying on read-then-write. The unique key ensures one row is the serialization point.

### Outcomes and concurrency

- **Exact replay of the latest operation:** no state update; return current `WorldTimeContext` and echo the same canonical `requestId`.
- **Replay of an older sequence:** no state update; return `409 stale_visit_operation` with the current accepted sequence, so a client can resynchronize or rotate its client session. It cannot replay the old transition.
- **Same sequence with a different token/operation:** no state update; return `409 visit_sequence_conflict`. The token parser also rejects an ID whose operation or target digest does not match this request.
- **Sequence gaps:** accept any valid sequence greater than the high-water mark. Enforcing `current + 1` would reject a later cleanup leave that arrives before a still-in-flight enter, while the hook sends cleanup fire-and-forget. The largest supplied sequence wins; the protocol therefore reflects client-declared order and cannot infer wall-clock or user-intent order for independently generated operations.
- **Distinct concurrent operations:** the row's conditional UPSERT serializes acceptance. If the smaller sequence commits first, the greater sequence may subsequently supersede it; if the greater commits first, the smaller becomes stale. This is intentional and prevents stale enter from reopening after a later leave. The API makes no promise that request arrival order equals sequence order.
- **First leave before enter:** insert a tombstone with the leave's high-water mark. An earlier enter arriving later is stale and cannot create/open the visit. A subsequent higher-sequence enter may convert the tombstone into an entered session.
- **Same-sequence duplicate from duplicated tabs:** identical canonical request IDs collapse to one transition. Different operations at the same sequence conflict. The losing tab rotates to a new client-session ID before retrying its operation, because both tabs cannot safely allocate a shared sequence without coordination.

Only the latest request token is persisted. Historical IDs are not looked up. Their encoded sequence lets the server reject them as stale without remembering each one. The contract is bounded to canonical version-2 IDs; supporting legacy opaque IDs cannot satisfy historical replay protection without retaining receipts.

### Migration and legacy behavior

Add `has_entered`, `operation_sequence`, `last_operation`, and `last_target_digest` in a new migration after the existing visit-session migration, and update `api/src/db/schema.ts` plus `api/drizzle/meta/_journal.json`. Backfill existing rows as entered according to their current session data, set `operation_sequence = 0`, set `last_operation` to a neutral legacy value, and set the digest to an empty legacy sentinel. Existing `last_request_id` values are preserved for diagnostics but cannot be associated with a trustworthy sequence, target digest, or operation after the fact. Therefore no historical guarantee is claimed for pre-migration random IDs.

At rollout, the server accepts only version-2 canonical IDs for mutation. The browser clears/rotates old session sequence state and starts a new client-session ID at sequence 1. Legacy rows are still projectable and can be advanced by the first canonical operation; that operation atomically replaces the legacy sentinel and sets a positive sequence. This avoids treating a legacy marker as proof that a new request was replayed.

No request rows are created, so there is no receipt retention or cleanup job. The high-water mark lives as long as the client-session row, under the existing row lifecycle. If old session rows are later pruned, the server loses their high-water marks; a request replay after pruning could recreate state. To preserve the unbounded replay contract, session rows (including closed rows and tombstones) must be retained indefinitely, or the contract must explicitly set a replay horizon and prune only after that horizon. A bounded-retention product requirement needs a durable tombstone/receipt retention policy; this candidate does not silently claim protection after deletion.

## Synthesis decision

This is the standalone no-journal candidate. It chooses a target-bound sequence token and one conditional UPSERT as the atomic state transition. It intentionally requires a client/server protocol change and rejects the current arbitrary-random-ID semantics, because the existing random ID cannot prove its order or target from one retained high-water row.

## Tradeoffs accepted

- We accept a breaking, versioned request-ID protocol in exchange for rejecting arbitrary historical IDs without a journal.
- We accept one persisted high-water mark and no receipt table in exchange for not retaining each request or its original response.
- We accept a client-session tombstone and a projector filter in exchange for making a leave with no prior row replay-safe.
- We accept last-sequence-wins semantics for distinct requests in exchange for allowing cleanup operations to arrive before delayed enters without a multi-request ledger.
- We accept indefinite retention of closed visit rows to preserve replay protection after later operations.
- We accept conflict recovery for duplicated-tab sequence collisions in exchange for avoiding a cross-tab lock or server-side sequence allocator.

## Alternatives considered

- **Opaque random IDs plus only a latest marker:** exposes no sequence protocol to callers, but cannot distinguish a reused old ID from a new operation after the marker is overwritten, or bind it to another target. It fails the stated stale-replay contract.
- **Opaque random IDs plus a durable request journal:** stores each ID, operation, target, and outcome atomically and therefore handles arbitrary ordering, but adds a request table, uniqueness scope, cleanup/retention policy, and journal lookup/insert to every mutation. It has a deeper persistence interface than this candidate but needs durable history the high-water design avoids.
- **Client sequence plus a separate CAS write followed by a session write:** appears to preserve the existing service split, but D1 batch success does not condition later statements on whether the CAS matched. A replay can still execute the state write, so this is not a viable atomic shape.

## Implementation reconciliation

No implementation deviations have been accepted. This artifact is a design candidate only.

## Open questions and risks

- Can rollout guarantee that all web clients switch to canonical version-2 IDs before the server rejects legacy mutation requests, or is a short compatibility window required?
- Should stale sequence conflicts return the high-water value in the route response, or should the client rotate its client-session ID without learning server state?
- Is indefinite retention of closed visit rows acceptable, or should the product define a finite replay horizon with matching retention semantics?
- Does the current Drizzle/D1 adapter expose a conditional conflict-update clause, or will this module need one parameterized SQL statement?
- Should duplicated-tab clients share a client-session identity and recover by rotation, or should each document claim a fresh ID on startup to eliminate that collision class?

## Next implementation step

Confirm the Drizzle/D1 conditional UPSERT capability and rollout compatibility contract, then implement the new request token and single-statement session transition together with the schema migration and projector treatment for leave-only tombstones.
