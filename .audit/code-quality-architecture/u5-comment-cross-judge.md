# U5 comment-remedy cross-judge

## Verdict

Select **candidate A** as the implementation base. It is the only candidate that states the current hash, replay, malformed-proof, public-export, and D1-order contracts without contradiction. It also presents the smaller internal interface: `legacy.ts` imports one policy operation, `sameCommitNamespace`, rather than coordinating namespace constructors and equality itself.

| Criterion | Candidate A | Candidate B | Judgment |
| --- | ---: | ---: | --- |
| 1. Behavior and persisted hash/error compatibility | 5 | 2 | A preserves the exact `{ document, version: revisionVersion }` serialization, the ordinary-first migration check, the current fallback catch scope, existing error text, timeline-only payload replay, and statement order. B explicitly changes two accepted inputs/paths. |
| 2. Existing storage ownership; no public-barrel growth | 5 | 4 | Both stay within the selected modules and reject a facade. A explicitly keeps `hashStoredDocument` as the canonical public function and exposes only one cross-owner namespace operation. B's proposed replacement name is ambiguous about that existing export, and its stated-private namespace helpers cannot support `legacy.ts` without widening their surface or duplicating parsing. |
| 3. Revision/payload and pre/post-baseline semantics in names/types | 5 | 3 | A uses `revisionVersion`, `hashReplayPayload`, `preCommitProof`, and `baselineAtGuard`, which name the actual contracts and moments. B has useful names, but the shown `ContentHash` and `PayloadHash` declarations are plain aliases even though the rationale calls them distinct brands. |
| 4. Minimal call depth and interface size | 5 | 3 | A has one complete revision-hash verifier, one private replay hash helper, one cross-owner namespace comparison, and named locals for baseline timing. B's `commitInputNamespace` + `commitRowNamespace` + `sameCommitNamespace` makes callers coordinate three operations, and retaining the existing public hash would add a second hash name or a pass-through wrapper. |
| 5. All six findings, no unrelated scope | 5 | 3 | A covers theme identity, revision-bound hash, migration provenance, request namespace, both baseline moments, and timeline payload replay directly. B touches all six, but expands into nominal hash types/public hash renaming and incorrectly generalizes timeline replay behavior to legacy replay. |
| **Total** | **25/25** | **15/25** | **Candidate A** |

## Evidence behind the score

The grounding limits payload-only replay to `commitTimelineScene`. The source follows that contract: `timeline.ts` hashes `JSON.stringify(document)` independently of `expectedVersion`, while `legacy.ts` compares the requested version-bound `contentHash` to the persisted row. Candidate B says both legacy and timeline replay use `hashRequestPayload`. That would make a legacy retry with a changed expected version replay where it currently conflicts, so it is not behavior preserving. Candidate A confines `hashReplayPayload` to `timeline.ts` and retains the existing legacy content-hash comparison.

The current migration fallback accepts `Number.isInteger(sourceVersion) && sourceVersion > 0`. Candidate B narrows this to a positive safe integer. However defensible that validation might be independently, it changes which persisted migration proofs are accepted and is outside this remedy. Candidate A explicitly retains a positive-integer check and the current exception boundary: an initial digest failure propagates, while malformed provenance or a fallback digest failure becomes the existing `hash-mismatch` integrity error.

`hashStoredDocument` is exported by `repository.ts` and has direct callers. Candidate A retains its name and signature shape, renaming only the parameter to `revisionVersion`. Candidate B sketches `hashRevisionSnapshot` while also claiming the barrel is unchanged. Replacing the function breaks the canonical interface; retaining both creates a synonym or forwarding API, contrary to the selected design and U5 alias removal.

Candidate B's advertised brands are not present in its sketch: `type ContentHash = string` and `type PayloadHash = string` are interchangeable aliases. Adding real brands would require casts/conversion points across existing storage and bridge code for little protection in this scoped change. Candidate A's separate function signatures encode the meaningful choice without introducing a new value representation.

For namespace identity, `legacy.ts` and `timeline.ts` need the same parsing precedence but should not learn its mechanics. Candidate A exports one comparison operation that accepts the existing input/row shapes and keeps both constructors private. Candidate B shows all three functions as private, yet `legacy.ts` must compare the same two shapes; exporting all three makes a larger and shallower interface, while recreating any of them splits policy ownership.

For baseline timing, A's `preCommitProof` and `baselineAtGuard` are exact descriptions: the latter is the baseline value expected when the guard statement executes after the optional update in the same batch. B's `postUpdateGuardBaseline` is directionally clear, but it can imply the update has already occurred while statements are only being assembled. It is not a stronger graft than A's name.

## Grafts and rejected shapes

No graft is required. Both candidates converge on typed namespace fields, a purpose-specific replay hash, a migration verifier, and named baseline moments; candidate A already expresses the compatible version of each idea with the smaller interface.

Reject candidate B's `hashRevisionSnapshot` replacement/alias, its document-owned `hashRequestPayload`, the three-operation namespace interface, the purported hash brands, the safe-integer migration restriction, and payload replay in legacy commits. Reject a new policy facade or baseline planner from either design: they would add call depth, cross existing ownership boundaries, and obscure the batch sequence.

## Implementation guardrails

Implement candidate A literally with three checks during review:

1. `hashStoredDocument` must still serialize the property key as `version`, despite the parameter rename.
2. `hashReplayPayload` must replace only the existing timeline payload hash sites, including the replay-after-CAS-failure path; legacy replay must remain version-bound.
3. The legacy batch must remain revision, pointer, optional baseline update, optional request completion, guard, then timeline mirror statements, and the serialized proof must remain `preCommitProof`.

This was a read-only architecture judgment. No application source, tests, builds, or runtime state were changed.
