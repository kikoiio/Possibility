# U5 storage review grounding

## Current owners

`api/src/scenes/repository.ts` is the public import boundary. `storage/types.ts` owns stored document, timeline scope, history, and write input types. `storage/document.ts` decodes snapshots and checks their stored hashes. `storage/timeline.ts` owns timeline history, CAS commits, restore, and fork statements. `storage/legacy.ts` owns world-scoped reads, commits, initial writes, and clone writes. `storage/main-line-bridge.ts` builds the two directions of root-line mirroring statements.

The selected design is [candidate A](candidate-a/design.md#scene-repository-ownership-and-atomic-bridge). The bridge returns statements to the existing callers. It does not run its own batch.

## Behavior to preserve

`hashStoredDocument(document, revisionVersion)` binds a stored scene hash to its revision row. `commitTimelineScene` uses a separate payload-only hash for request replay. A retry with a changed expected version can replay the same timeline payload, while a different payload or request purpose conflicts.

`readTimelineRevisionRow` accepts the row-version hash for ordinary revisions. A `legacy-migration` row may instead match a version-bound source hash when its proof names a positive `sourceVersion`. Migration 0038 creates that row shape.

`commitInputNamespace` and `commitRowNamespace` compare a tuple of operation kind, compatibility purpose, and draft ID. The persisted request attempt and lease do not define the operation's purpose.

Legacy `commitScene` stores the proof built from the pre-commit baseline. When `baselineUpdate` is present, the same D1 batch updates the baseline and its guard checks the new version and hash. Initial and clone factories return statements for the caller's batch.

`scopedMainLegacyStatements` mirrors root timeline writes into world-scoped storage. `legacyMainSceneStatements` mirrors legacy writes into the root timeline. Each store has its own revision sequence and version-bound hash.

## Sketch scope

Design local names, types, and helpers for the review findings in `document.ts`, `timeline.ts`, and `legacy.ts`. Preserve existing results, errors, query order, D1 batch membership, batch statement order, and the selected module owners. Keep the public barrel canonical and remove unused synonym aliases, as the selected design requires. Do not add a generic repository facade or another controller module.
