# Callback Freshness Cross-Judge

Scores use the rubric in `callback-frame.md`; 5 means the sketch addresses the criterion fully and concretely.

| Criterion | Candidate A | Candidate B | Notes |
| --- | ---: | ---: | --- |
| 1. Both active stream callbacks use the latest committed callback, including `undefined` | 5 | 5 | Both specify reading one ref at each catchup and send state event dispatch. |
| 2. Callback identity changes do not restart catchup/history or alter stream lifetime | 5 | 5 | Both keep the initial-load dependencies at `[conversationId, withCatchup]` and leave `PersonDetail` unchanged. |
| 3. Abandoned concurrent renders cannot publish their callback | 5 | 5 | Both synchronize the ref in `useLayoutEffect`, and reject render-time assignment. |
| 4. Cancellation, callback-error propagation, and send lifecycle remain explicit and unchanged | 5 | 4 | A explicitly states callback exceptions follow existing paths and describes both catchup and send lifecycle boundaries. B explains cancellation and send behavior, but does not explicitly record callback-error propagation. |
| 5. One small ownership model and focused active-stream replacement verification | 5 | 5 | Both use a component-local ref and name replacement during active catchup and send as review scenarios. |

## Recommendation

Use Candidate A as the base. The implementation is equivalent to B's, while A more completely documents the callback-error contract and the boundaries around old catchup and send work. Keep the two direct event-time ref reads and the existing catchup dependency list.

## Useful Graft

Carry over B's explicit caveat that Strict Mode effect replay can still start duplicate catchup work when the transport cannot cancel it. That limitation is distinct from callback freshness and should not be mistaken for a regression introduced by the ref.

## Unresolved Risk

Neither design gives an in-flight send cancellation or conversation-ownership guarantee. A send from an old component instance can continue after unmount and use that instance's latest committed callback; a reused instance can also deliver an old conversation's state to its new callback. Addressing either case requires a separate send cancellation or request/conversation ownership policy.
