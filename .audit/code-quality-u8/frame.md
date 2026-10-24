# U8 Arena Frame

## Artifact

Each runner writes a caller-first design package for the compatibility-entry error path and POST SSE type boundary. The package includes realistic usage, type/signature sketch, module map, rationale, alternatives, tradeoffs, open risks, and the first implementation step. No runner edits application code or runs tests.

## Rubric

1. Compatibility attach and current-scene-read failures become visible and retryable without relabeling session inspection failures or submission recovery.
2. Identity, scope, cleanup, and stale-response invariants remain enforced; one owner controls each visible failure state.
3. POST SSE has no `any`; the shared transport stays endpoint-neutral, endpoint event contracts match emitted variants, and untrusted fields are narrowed.
4. The public surface hides meaningful complexity with short call paths and avoids parallel ways to parse or consume the same stream.
5. The design preserves current consumer behavior and forward compatibility, stays scoped, and names focused cloud-verifiable coverage.

## Dispatch

- Candidate A: `gpt-6-astra`, writes `candidate-a.md`.
- Candidate B: `gpt-6-sol`, writes `candidate-b.md`.
- Cross-judge: `gpt-6-luna`, read-only after both candidates complete.
- Shared grounding: `grounding.md`.
- Synthesis output: `design.md`.
