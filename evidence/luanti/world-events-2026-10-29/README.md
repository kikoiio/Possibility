# World event journal — 2026-10-29

`cognition/world_events.lua` is the first shared fact boundary inside the
Luanti adapter. A verified action or contact is committed with a monotonic
`world-event:N` identity and an `operation_id`. Retrying the same operation
returns the original event; changing its result or parameters is rejected.

Long term memory receives the same event identity as the L0 source and writes
the actor and recipient L1 experiences from the verified result. The journal,
role snapshots and long term memory are included in the normal shutdown
checkpoint and restored together.

This step does not make map writes transactional. The existing resource
adapter still changes the map and inventory separately, and a checkpoint is
still written only during normal shutdown. Crash windows, map reconciliation,
logical time and uncooperative writers remain open work.

The Lua test `cognition/test_world_events.lua` covers sequence allocation,
idempotent retries, conflicting retries, defensive copies and corrupted
snapshot rejection. GitHub Actions runs it together with the Luanti restart,
resource, memory and preview checks.
