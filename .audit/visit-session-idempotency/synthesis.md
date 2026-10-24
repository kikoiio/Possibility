# Visit request idempotency synthesis

## Decision

Use Candidate A's durable receipt table with principal-wide `(principal_key, request_id)` uniqueness. Keep the current random request IDs and route payloads. Bind each receipt to its operation and complete visit target. A reused ID with a different binding, or a recoverable legacy marker, returns 409.

## Implementation

- `world_visit_requests` stores accepted operation bindings without target foreign keys, so receipt history survives world/session cleanup.
- Migration `0043_visit_request_receipts.sql` backfills the latest marker from every visit session as a legacy tombstone, grouped by principal and ID.
- `enterVisit` and `leaveVisit` authorize first, then batch the plain receipt insert with the session transition. Duplicate receipt failure rolls back the whole batch; a matching receipt resolves the retry without another mutation.
- Both operations now return the shared `readVisitContext` projection for the requested client session when present, or the existing generic projection when absent.
- The existing `last_request_id` column remains as a compatibility marker, but is not consulted for replay decisions.

## Migration metadata

The missing journal entry for `0042_time_status_semantics.sql` is now restored, and `0043_visit_request_receipts.sql` has its own entry. The formerly empty `0041_snapshot.json` was regenerated as the post-0041 schema state; `0042_snapshot.json` adds visit sessions, and `0043_snapshot.json` adds request receipts. The snapshot IDs form a continuous chain from the prior 0040 snapshot.

Wrangler and the test database loader continue to apply the checked-in SQL files. Drizzle's generated snapshot now represents the same end state as those migrations, and a schema diff reports no pending changes.

The migration must be deployed after old visit writers are drained or temporarily gated. Backfill protects only the latest markers still present when the migration runs; it cannot recover overwritten request IDs or pre-migration leaves that created no session row.

## Verification

No tests or builds were run. `drizzle-kit generate` reports no schema changes; static diff checks are recorded in the code-quality summary.
