# Visit request idempotency cross-judge

The independent judge scored the candidates against `arena-frame.md`:

| Rubric | Candidate A | Candidate B |
| --- | ---: | ---: |
| Stale replay and missing-session leave | 5 | 5 |
| Atomicity under D1 concurrency | 5 | 4 |
| Request binding and mismatch outcome | 5 | 5 |
| Small service surface and ownership | 5 | 3 |
| Legacy rows and migration lifecycle | 5 | 3 |
| Honest response, retention, and concurrency semantics | 5 | 4 |
| **Total** | **30** | **24** |

Candidate A is the base. Candidate B is viable only with a coordinated versioned sequence protocol, client-side sequence persistence, duplicate-tab recovery, and a conditional single-statement upsert. Those changes expand the public protocol and make rollout incompatible with old opaque IDs. Candidate A preserves the current client contract and confines receipt policy to the existing mutation owner.

Neither candidate had a fatal design flaw. Candidate A's release risk is the migration cutover: old API writers must be drained or gated before the receipt-aware writer is enabled. Existing latest request markers can be backfilled as legacy tombstones, but overwritten historical IDs and markerless leaves cannot be reconstructed.
