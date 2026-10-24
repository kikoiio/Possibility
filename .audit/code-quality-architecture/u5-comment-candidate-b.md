# U5 comment-remedy candidate B: semantic names at the owner boundary

## Usage (caller's view)

Callers continue to use the canonical scene repository exports. The narrower helpers stay private to their current storage owner; they make the two hash contracts, namespace comparison, and baseline times explicit where those contracts are enforced.

```ts
// Existing public operation; retry identity ignores expectedVersion but storage integrity does not.
const committed = await commitTimelineScene(db, {
  scope, expectedVersion, requestId, document, summary, kind,
})

// Existing public integrity probe; a migrated row is checked against its recorded source version.
const checked = await validateTimelineSceneRevision(migrationRow, scope)

// Existing legacy write; proof records the old baseline, while the guard checks the new reference.
const saved = await commitScene(db, {
  worldId, expectedVersion, requestId, document, summary, kind,
  baselineUpdate: { baselineId },
})
```

The repository barrel, returned values, thrown errors, read/query order, and statement-factory call sites do not change.

## Shape

Keep the selected owners and move ambiguity out of comments and overloaded nouns into small domain names. These are internal names and types, not a new repository facade.

```ts
// document.ts
type RevisionVersion = number
type SourceRevisionVersion = number
type ContentHash = string
type PayloadHash = string

function storedSceneTheme(document: StoredSceneDocument): string
function hashRevisionSnapshot(
  document: StoredSceneDocument,
  revisionVersion: RevisionVersion,
): Promise<ContentHash>
function hashRequestPayload(document: StoredSceneDocument): Promise<PayloadHash>
function verifyLegacyMigrationHash(
  row: TimelineRevisionRow,
  document: StoredSceneDocument,
): Promise<boolean>

// timeline.ts; purpose and draft id are parsed from the same existing JSON sources.
interface CommitNamespace {
  kind: string
  purpose: string | null
  draftId: string | null
}
function commitInputNamespace(input: CommitNamespaceInput): CommitNamespace
function commitRowNamespace(row: CommitNamespaceRow): CommitNamespace
function sameCommitNamespace(left: CommitNamespace, right: CommitNamespace): boolean

// legacy.ts; the proof is built before the batch and remains tied to the old baseline.
const proofBaseline = proof.baseline
const postUpdateGuardBaseline = baselineUpdate
  ? baselineAfterCommit(baselineUpdate.baselineId, version, contentHash)
  : proofBaseline
```

### Data flow and owner responsibilities

`document.ts` owns stored-scene interpretation and hashing. `storedSceneTheme` names the value persisted in `worldScenes.themeId`; the document has a theme identifier, while the table column happens to call it `themeId`. This avoids implying that the stored document itself is a theme ID. `hashRevisionSnapshot` is the sole constructor for the version-bound persisted content hash. `hashRequestPayload` is the sole constructor for retry equality and deliberately excludes the expected revision version. The two results have different internal brands so a payload hash cannot accidentally be assigned to a persisted revision hash.

`readTimelineRevisionRow` retains its parse/decode/space-set sequence and then checks the ordinary row-version hash. If that fails for `legacy-migration`, it calls `verifyLegacyMigrationHash`. That helper parses the existing proof shape, accepts only `mode === 'legacy-migration'` with a positive safe integer `sourceVersion`, and compares against the source-version-bound hash. Invalid proof remains a failed verification, producing the same `hash-mismatch` error at the existing boundary. No new stored field or migration is needed.

`timeline.ts` represents commit namespace as its actual three-part domain value rather than JSON text. `sameCommitNamespace` performs field equality. Both legacy and timeline replay paths keep their existing parsing and fallback precedence: kind, audit purpose, and draft ID resolved from the request proof before audit metadata. Attempt and lease stay outside identity. Payload replay hashes the stored parsed document and requested document with `hashRequestPayload`; revision writes still use `hashRevisionSnapshot`.

`legacy.ts` distinguishes `proofBaseline` (the facts serialized into the write proof before mutation) from `postUpdateGuardBaseline` (the baseline row the final guard expects after the same batch updates it). Keep statement membership and order byte-for-byte in intent: revision, pointer update/insert, optional baseline update, optional request completion, guard, then `...timelineWrites`. `initialSceneStatements` and `cloneSceneStatements` remain statement factories; bridge functions keep returning their statements to the caller's outer D1 batch.

This concentrates capability at existing boundaries: callers still request a commit or validation, while each owner hides parsing, hash choice, namespace comparison, or baseline timing. It follows boundary discipline and encode-lessons-in-structure without adding forwarding layers. The internal brands are compile-time distinctions only and do not alter hash bytes or persisted JSON.

## Tradeoffs accepted

- We accept a few local semantic helpers and internal type declarations in exchange for making the invariants visible at their enforcement sites.
- We accept branded string types requiring a narrow cast at the SHA-256 formatter in exchange for preventing revision and retry hashes from being interchanged elsewhere in these modules.
- We accept a small `sameCommitNamespace` helper in exchange for comparing the operation's three fields directly instead of serializing an opaque tuple key.
- We accept that the migration-proof shape remains decoded from `validationJson` at the storage boundary; changing its persisted schema would expand scope and risk migration compatibility.
- We accept existing string-valued `kind` and purpose fields because constraining their vocabularies would change current persistence contracts and behavior beyond a comment remedy.

## Alternatives considered

- **One generic hash function with a mode parameter.** It would expose the semantic choice at every call site and permit passing the wrong mode; a pair of purpose-named helpers is a smaller and deeper boundary.
- **A new `SceneStoragePolicy` facade that owns hashes, migration verification, replay identity, and baseline guards.** It would span document, timeline, and legacy responsibilities, expose internal workflow choices, and add a hop without hiding more from existing callers. Keeping each invariant with its current owner is shorter and matches the established boundaries.
- **Keep `commitNamespaceKey` as a serialized string tuple.** It is compact but conceals the compared fields and conflates a domain identity with its encoding. A typed namespace retains the same equality contract without choosing a string encoding as its model.

## Synthesis decision

This is an independent candidate, not a synthesis. It favors internal semantic distinctions over encoded keys and comments while preserving the selected module ownership and all observed behavior contracts.

## Next implementation step

Apply these local names at the existing hash, migration-validation, replay-comparison, theme-persistence, and baseline-guard statements, then compare the resulting diff against the saved D1 statement order and public barrel.
