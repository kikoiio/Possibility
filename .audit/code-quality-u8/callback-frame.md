# ChatStream Callback Freshness Arena

## Artifact

Each candidate writes one read-only design sketch to its own file. The sketch covers both catchup and send stream callbacks, lifecycle timing, alternatives, and preserved behavior. No candidate edits application code or runs tests.

## Rubric

1. Events from both active streams call the latest committed `onStateChange` prop, including when it becomes `undefined`.
2. Callback identity changes do not restart catchup/history or otherwise change stream lifetime.
3. The freshness mechanism does not publish a callback from an abandoned concurrent render.
4. Existing cancellation, callback-error propagation, and send lifecycle behavior remain explicit and unchanged.
5. The change has one small ownership model and a focused way to verify replacement during an active stream.

## Dispatch

- Candidate A: `gpt-6-astra`, writes `callback-candidate-a.md`.
- Candidate B: `gpt-6-sol`, writes `callback-candidate-b.md`.
- Cross-judge: `gpt-6-luna`, read-only after both candidates complete.
- Shared code: `web/src/components/ChatStream.tsx` and `web/src/pages/PersonDetail.tsx`.
- No application edits, local tests, builds, or cloud operations occur in the design phase.
