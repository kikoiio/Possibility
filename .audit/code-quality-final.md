# Code quality review: current worktree

## Scope

Reviewed the active branch changes and relevant uncommitted edits across API, web, voxel-contract, acceptance finalizers, and comments. The API and web reviews were split across reviewers; the visit-session idempotency design received two independent candidates and a cross-judge. Existing user changes to `.gitignore`, `packages/voxel-contract/src/sections.ts`, `packages/voxel-contract/src/walkability.ts`, and `artifacts/` were preserved.

## Findings and disposition

1. **[P2] World-list contexts caused repeated serial database reads.** Resolved by reusing the owner context aggregation and batching the remaining world/member reads in `api/src/worlds/routes.ts`.
2. **[P2] Visit mutation responses could disagree with subsequent reads.** Resolved by routing enter/leave results through the shared visit projector and retaining the selected session's exit watermark.
3. **[P2] Old visit request IDs could be replayed after newer requests, and missing-session leaves were not recorded.** Resolved with durable principal-scoped request receipts committed atomically with visit mutations. Reusing an ID for another operation or target returns 409.
4. **Acceptance finalizers could crash on missing `cases`, duplicate report code, and report success despite failed/invalid case states.** Resolved with the shared evidence helper and explicit status validation.
5. **Phase 1C evidence validation did not compare API and page simulation time.** The old comment described this requirement, and Phase 2B already checked it; the Phase 1C validator now enforces the same condition.
6. **Redundant comments and repeated acceptance-report code obscured the rules.** Shared the report implementation and removed comments whose intent is directly represented by validation branches.

## Remaining risks and limits

- Migration `0043` backfills only each surviving session's latest `last_request_id`. Historical IDs already overwritten, and leaves made before any session existed, cannot be recovered.
- Deployment must drain or gate old visit writers during the migration cutover. The Drizzle journal and snapshots now include 0042 and 0043; the reconstructed latest schema baseline passes a no-change generation diff.
- Distinct concurrent visit operations follow D1 commit order because current random request IDs do not encode lifecycle ordering. Durable receipts prevent duplicate application, not a distinct late cleanup leave from closing a newer enter.

## Verification

No tests, builds, installs, or GUI checks were run. `drizzle-kit generate` reported no schema changes, and `git diff --check` passed; behavior remains statically reviewed and should receive focused service coverage when test execution is authorized.
