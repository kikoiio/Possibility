# U5 comment remedies — candidate A

## Usage (caller’s view)

The public repository interface stays canonical. Consumers continue importing `hashStoredDocument` and scene operations from `scenes/repository`; this design introduces no consumer-facing operation. Internal call sites express the policy currently carried by comments.

```ts
// document.ts: revision reading still parses and decodes before checking hashes.
await assertRevisionContentHash(row, parsed as StoredSceneDocument)

// timeline.ts: replay compares operation identity and payload independently.
const requestedPayloadHash = await hashReplayPayload(input.document)
const prior = await /* existing request lookup, unchanged */
if (prior) {
  const storedAudit = prior.validationJson ? JSON.parse(prior.validationJson).audit : null
  if (!sameCommitNamespace(input, {
    kind: prior.kind,
    compatibilityJson: storedAudit ? JSON.stringify(storedAudit) : null,
    validationJson: prior.validationJson,
  })) throw new SceneConflict('同一 request ID 已用于其他场景用途')
  const priorDocument = JSON.parse(prior.snapshotJson) as StoredSceneDocument
  if (await hashReplayPayload(priorDocument) !== requestedPayloadHash)
    throw new SceneConflict('同一 request ID 不能提交不同场景内容')
  return readTimelineRevisionRow(prior, scope)
}

// legacy.ts: proof evidence and the later guard refer to different moments.
const preCommitProof = await buildCommitWriteProof(db, existingProofInput)
const baselineAtGuard: SceneWriteProofBaseline | null = input.baselineUpdate
  ? { id: input.baselineUpdate.baselineId, status: 'active', sceneVersion: version, contentHash }
  : preCommitProof.baseline
const guard = buildCommitGuardStatement(db, { ...existingGuardInput, baseline: baselineAtGuard })
// Revision values and mirror input use JSON.stringify(preCommitProof).
// The original batch remains revision, pointer, optional baseline update,
// optional completion, guard, then mirror statements.
```

These are sketches: placeholders stand for existing expressions, not new forwarding functions. In particular, do not lift the current proof input into an extra exported type or wrapper.

## Problem

Six comments explain domain choices that should be readable from the owning code: a scene’s stored theme, the revision number participating in a hash, migration source provenance, request identity, the two baseline observation moments, and payload-only replay. U5 must retain read/write owners and D1 transaction behavior. Query order, hash serialization bytes, malformed-data outcomes, error texts, and statement membership/order are constraints, not opportunities for cleanup.

## Shape

```ts
// document.ts; exported only to other storage owners, not the public barrel.
export function storedSceneThemeId(document: StoredSceneDocument): string {
  throw new Error('not implemented')
  // Existing single-document theme / first-space theme / mist-manor fallback.
}

// Existing public function and signature shape; only parameter naming changes.
export async function hashStoredDocument(
  document: StoredSceneDocument,
  revisionVersion: number,
): Promise<string> {
  throw new Error('not implemented')
  // Preserve JSON.stringify({ document, version: revisionVersion }) exactly.
}

type RevisionHashSource = Pick<typeof timelineSceneRevisions.$inferSelect,
  'version' | 'kind' | 'validationJson' | 'contentHash'>

async function assertRevisionContentHash(
  row: RevisionHashSource,
  document: StoredSceneDocument,
): Promise<void> {
  throw new Error('not implemented')
  // First compare the hash bound to row.version.
  // Only on mismatch: require legacy-migration kind and truthy validationJson;
  // parse proof, require matching mode and positive integer sourceVersion;
  // compare source-version-bound hash inside the same try/catch as today.
  // Otherwise throw the existing hash-mismatch integrity error.
}

// timeline.ts: all namespace mechanics stay with their existing owner.
type CommitNamespace = Readonly<{
  kind: string
  purpose: string | null
  draftId: string | null
}>
type CommitNamespaceInput = {
  kind: string
  compatibilityJson?: string | null
  compatibility?: SceneWriteProofRequest
}
type CommitNamespaceRow = {
  kind: string
  compatibilityJson: string | null
  validationJson: string | null
}

function inputCommitNamespace(input: CommitNamespaceInput): CommitNamespace {
  throw new Error('not implemented')
  // Parse existing audit fields; compatibility.draftId overrides audit.draftId.
}
function storedCommitNamespace(row: CommitNamespaceRow): CommitNamespace {
  throw new Error('not implemented')
  // Parse existing audit fields; proof request draftId overrides audit draftId.
}
export function sameCommitNamespace(
  input: CommitNamespaceInput,
  row: CommitNamespaceRow,
): boolean {
  throw new Error('not implemented')
  // Compare exactly kind, purpose, draftId; attempt and lease are absent.
}

async function hashReplayPayload(document: StoredSceneDocument): Promise<string> {
  throw new Error('not implemented')
  // hashText(JSON.stringify(document)); no revision version in the input.
}
```

Namespace parsing retains the current tolerant behavior, including empty strings and null defaults. Existing audit and proof parsers remain private. Explicit field equality is equivalent to the present serialized tuple comparison for these three string-or-null fields. No database query belongs inside `sameCommitNamespace`.

`assertRevisionContentHash` owns the full hash acceptance decision, including migration fallback and rejection; it is not a wrapper around a second verifier. The initial SHA failure propagates as before, while exceptions inside the migration fallback remain a mismatch. The row is not reparsed or decoded by this helper. JSON/compatibility/space checks still precede it.

`hashReplayPayload` owns the serialization decision and exposes no revision parameter, per encode-lessons-in-structure. It is used at both existing hash sites without moving either one across the request lookup. This hides a real policy distinction; an alias taking pre-serialized text would merely forward arguments and is rejected.

The baseline distinction needs named local values, not a new abstraction. Rename `proof` to `preCommitProof` throughout `commitScene`, and `guardBaseline` to `baselineAtGuard`. Preserve `baselineStatement` and its exact batch position. Do not add a baseline planner that mixes proof validation with statement assembly. A short comment can still explain the database trigger ordering if needed; names need not reproduce SQL trigger semantics.

## Module map

| Existing owner | Change | External surface |
| --- | --- | --- |
| `storage/document.ts` | Rename theme selector; clarify hash parameter; concentrate migration acceptance in private verifier | Existing public hash function unchanged; theme selector remains internal |
| `storage/timeline.ts` | Typed namespace representation and one comparison entry; private payload hash policy | One internal comparison export replaces two serialized-key exports |
| `storage/legacy.ts` | Use namespace comparison; name pre-commit proof and baseline at guard | No public signature change |
| `storage/main-line-bridge.ts` | Update theme selector import/call if applicable | No behavior or statement changes |
| `storage/types.ts` | No new public identity, hash, or baseline types | No change |
| `repository.ts` | Keep canonical operation exports; remove unused aliases under existing U5 decision | Do not expose the new internals |

Interface depth improves because callers can ask whether two commits share purpose without learning namespace serialization, parser precedence, or the identity tuple. The document reader delegates one complete integrity policy, while retaining decode order in one file. The six findings do not justify a new module, repository facade, domain class, or pipeline.

## Synthesis decision

Candidate A proposes policy-owning local helpers plus explicit baseline names. Final selection belongs to the coordinator’s independent comparison. This package has not incorporated another runner’s proposal.

## Tradeoffs accepted

- We accept an explicit three-field comparison in exchange for eliminating serialized key mechanics from both writers. Any future identity field must be added to the single comparison along with both constructors.
- We accept that baseline timing remains visible within `commitScene` in exchange for preserving a directly inspectable transaction sequence without a new plan type.
- We accept unbranded numeric revision versions in exchange for retaining the canonical public hash API; the parameter and wire-key mapping explain its meaning without migrating every consumer.

## Alternatives considered

A single `PreparedSceneCommit` aggregate could carry proof, hash, namespace, baseline transition and statements. It hides more mechanics behind one constructor but forces callers to supply policy stages and joins two owners with different replay rules. Its interface leaks transaction timing, increases coupling, and risks reordering queries. It is rejected for this constrained change.

Branded serialized namespace strings preserve the current equality call sites but leave both callers responsible for obtaining two keys and knowing their pairing. A single comparison interface hides more policy with fewer exports. Branded content/replay hashes would likewise impose conversion and annotation costs beyond the six local findings.

## Red-flag screen

No new modules or forwarding layers; no split state ownership; no new public wire types; no second namespace API retained. Helpers are private except the one required across existing timeline/legacy owners. Baseline state is derived from `preCommitProof` or the pending update, never synchronized in parallel. Existing storage import-boundary enforcement continues to exclude application consumers from internals.

## Implementation reconciliation

Not implemented by this runner. No source edits, tests, builds, queries, or cloud operations were performed. Grounding and sketch are complete; agreement/synthesis is the coordinator’s next phase. Implementation and scrap assessment remain pending.

## Open questions and risks

Can the coordinator retain the exact migration catch scope and hash serialization key while extracting the verifier? These are review checks, not requests for user approval. No product choice is open.

## Next implementation step

After synthesis, update the document helpers and their imports, then the namespace comparison and baseline locals, and inspect the diff for unchanged query and batch order before cloud verification.
