# Visit request idempotency design frame

## Artifact

One typed architecture sketch and rationale for making visit enter/leave request retries safe in the existing API and D1 storage model. Do not implement code in candidate work.

## Contract

- An accepted request ID must not apply its visit-state transition twice, even after later requests have been accepted.
- Reusing an ID for a different operation or target must not mutate state; define whether it returns a conflict or the original result.
- A leave for a client session that does not yet have a row must still be made replay-safe so a later replay cannot close a subsequently created visit.
- The request record and any session-state transition must commit atomically under D1 concurrency. Reads followed by independent writes are not sufficient.
- Keep authorization before request/session lookup, preserve user/guest isolation, and retain the `WorldTimeContext` response contract. Exact original response bytes are not required; the route currently projects current context on replay.
- Define request-ID scope, retention, legacy-row behavior after migration, and the semantics for distinct concurrent requests. Do not claim ordering that the request protocol cannot establish.

## Rubric

1. Correctly prevents replay of an accepted stale ID from changing newer visit state, including a previously missing-session leave.
2. Makes receipt creation and state mutation atomic under duplicate and concurrent requests using supported D1/Drizzle primitives.
3. Binds a request ID to its operation and target and states a clear mismatch outcome.
4. Keeps the public/service interface and ownership boundaries small; does not spread persistence rules across the web hook, route, and projector without need.
5. Handles the already-existing `last_request_id` values and migration lifecycle without pretending historical operations can be reconstructed.
6. States response, retention, and distinct-request concurrency semantics honestly, including costs and any unresolved ordering limit.

## Candidate directions

- Candidate A: append-only request receipts keyed by a defined request scope, committed atomically with state changes.
- Candidate B: monotonic per-client-session operation sequence with a compare-and-set high-water mark on the session row, avoiding a request journal.

Candidates must derive their own full shape from the shared grounding and may reject their assigned direction if it cannot meet the contract. The picker will compare them against this rubric, then use an independent cross-judge before synthesis.
