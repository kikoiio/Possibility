# Candidate A: operation owners with bounded home reads

## Usage (written before the shape)

Home asks for one authorized overview. The route does not assemble time contexts or coordinate visit queries.

```ts
// api/src/home/routes.ts
homeRoutes.get('/', authMiddleware, async c => {
  const user = c.get('user')
  return c.json(await readHome(createDb(c.env.DB), {
    kind: 'user', userId: user.id, ownerId: user.id,
    username: user.username, role: user.role,
  }))
})

// api/src/life/visit-sessions.ts: both enter and leave
const target = await requireVisitTarget(db, access, input)
// No visit INSERT/UPDATE has occurred above this line. Missing and foreign
// world/timeline targets both fail with the existing 404 response.
const session = await updateExistingVisitOperation(db, target, input, now)
return { context: { ...target.context, visit: session.visit }, requestId: input.requestId }
```

The second example names a conceptual operation, not a proposed generic enter/leave dispatcher: keep the distinct existing enter and leave bodies. `requireVisitTarget` replaces their insufficient timeline-only check and supplies the already authorized clock/context.

The canvas keeps ownership of its snapshot and URL. Two narrower owners hide visit lifecycle and compatibility integration:

```tsx
// web/src/pages/WorldCanvasPage.tsx
useWorldVisit({
  target: !readonly && snapshot && activeTimelineId
    ? { worldId, timelineId: activeTimelineId, guest } : null,
  onContext: context => setSnapshot(current =>
    current?.world.id === context.worldId && current.currentTimelineId === context.timelineId
      ? { ...current, timeContext: context } : current),
  onError: setError,
})

const repair = useWorldSceneCompatibility({
  worldId, timelineId: activeTimelineId, guest,
  canEdit: canEditScene && !readonly,
  archived,
  timeZone: snapshot?.world.timeZone,
  closeSceneHistory,
})
// Existing save/history/AI-edit paths invoke one operation:
await repair.open('restore-history', {
  kind: 'history', version: revision.version, targetRevisionId: revision.revisionId,
})
// Existing modal composition:
<WorldModalsContainer {...existingProps} compatPanel={repair.panel} />
```

Source review found no post-commit refresh callback in `WorldCanvasPage` or `SceneCompatibilityPanel`. The panel remains open in its completed state, and closing it resets the session. Preserve that behavior. `closeSceneHistory` stays owned by the page and runs whenever compatibility opens or rechecks. The compatibility owner does not receive snapshot setters or search-parameter setters.

Scene callers keep canonical domain operations; their storage implementation moves behind the existing entrypoint:

```ts
import { commitTimelineScene, listTimelineSceneHistory } from '../scenes/repository'
const revision = await commitTimelineScene(db, {
  scope: { worldId, timelineId, representation: 'voxel' },
  expectedVersion, requestId, document, summary, kind: 'edit',
})
const history = await listTimelineSceneHistory(db, revisionScope, options)
```

## Problem and constraints

The existing phase 2B work adds time/status/visits across API and UI. The task is to make those seams maintainable while preserving its current response shapes, authorization paths, request fencing, and D1 transaction semantics. The grounding reports identify independent API/Web contracts, home work of approximately `6*T + 6*W` context queries, a 1,209-line route component, a 1,187-line scene repository, and auth middleware whose mount order changes unrelated endpoints. Source inspection confirms these findings.

`docs/PLAN.md` stage 0 remains a product evidence constraint. Passing the new gate will establish a code baseline, not complete BB-01 through BB-18 or authorize new product scope. The existing 56 modified/untracked paths are the input baseline. No reset, cleanup, migration rewrite, or overwrite of those changes belongs in this design.

One separate correctness defect must accompany the structural work: visit services currently mutate a real foreign-owned world's visit metadata before `contextFor` returns 404. Fix authorization before any visit read/write whose result would leak scope or mutate state. Do not bundle speculative changes to visit phase semantics or idempotency history into that fix.

## Shape: data first

### Shared world/time contract

Add `packages/world-contract` with the same source-export/npm-workspace pattern as `scene-contract`. It owns precisely the current `WorldStatus`, `TimelineStatus`, `WorldStatusReason`, `StatusView`, `VisitContext`, `WorldTimeContext`, normalizers, status descriptions, and action labels. No Drizzle rows, Hono types, browser state, or `AccessContext` crosses this package boundary.

```ts
export type WorldStatus = 'running' | 'paused' | 'capped' | 'archived'
export type TimelineStatus = 'active' | 'archived'
export type WorldStatusReason = 'manual' | 'daily_cap' | 'global_daily_cap' | 'idle' | null
export interface StatusView {
  key: string; label: string; description: string; frozen: boolean; nextStep: string | null
}
export interface VisitContext {
  phase: 'first_visit' | 'returning' | 'unknown'
  sessionId: string | null
  enteredSimTime: string | null
  previousExitedSimTime: string | null
  hasValidPreviousWatermark: boolean
}
export interface WorldTimeContext {
  worldId: string; timelineId: string; simNow: string; timeZone: string
  stateVersion: number
  /** Compatibility alias of stateVersion; not the voxel scene revision. */
  revisionVersion: number
  world: { status: WorldStatus; reason: WorldStatusReason; view: StatusView }
  timeline: { status: TimelineStatus; view: StatusView }
  access: {
    identity: 'owner' | 'guest' | 'readonly'
    capabilities: Readonly<Record<'read' | 'write' | 'advance' | 'fork' | 'archive' | 'reactivate', boolean>>
  }
  visit: VisitContext
}
```

Retain both version fields in this behavior-preserving migration; derive both from one local `stateVersion`. Their equality is a contract test. Removing an existing wire field is a later deliberate API change. Do not source `revisionVersion` from scene storage, which is a different version sequence.

The current server and UI fallback copies differ. Move both intentional policies into one package instead of accidentally changing a label while deduplicating. One private status table holds shared copy; server projection applies reason-specific overrides; UI fallback preserves unknown as “状态待确认” and preserves supplied server view precedence.

```ts
export function normalizeWorldStatus(raw: string | null | undefined): WorldStatus
export function normalizeTimelineStatus(raw: string | null | undefined): TimelineStatus
export function normalizeWorldStatusReason(raw: string | null | undefined): WorldStatusReason
export function describeWorldStatus(status: WorldStatus, reason: WorldStatusReason): StatusView
export function describeTimelineStatus(status: TimelineStatus): StatusView
export function worldStatusView(raw: string | null | undefined, supplied?: StatusView | null): StatusView
export function timelineStatusView(raw: string | null | undefined, supplied?: StatusView | null): StatusView
export function statusActionLabel(action: 'resume' | 'pause' | 'archive' | 'reactivate'): string
```

These are two named policies, not two copies of the same function. Existing `web/src/lib/world-status.ts` can become a re-export to avoid changing unrelated consumers. `api/src/worlds/status.ts` retains only the API-specific capability projection. `web/src/api/types.ts` imports/re-exports contract types; endpoint optionality stays at the existing response declarations. Shared DTOs are intentional boundary contracts; repository service APIs must not start exporting database schemas under the same name.

### Authorized home dataset and visit projection

The central data structure is an authorized relation of world/timeline pairs, not independently loaded arrays later joined by unchecked ids. The owner filter is applied in SQL before projection. It carries optional timeline data for worlds that have no timelines.

```ts
// Private to worlds/time-context.ts; constructed only after database filtering.
interface TimeContextSource {
  worldId: string; timelineId: string; simNow: string; timeZone: string
  stateVersion: number
  worldStatus: WorldStatus; worldReason: WorldStatusReason; timelineStatus: TimelineStatus
  access: WorldTimeContext['access']
}
interface OwnedWorldContexts {
  worlds: readonly OwnedWorldSummary[]
  timelines: readonly OwnedTimelineSummary[]
  byTimeline: ReadonlyMap<string, WorldTimeContext>
}
type UserAccess = Extract<AccessContext, { kind: 'user' }>

export async function readOwnedWorldContexts(db: Db, access: UserAccess): Promise<OwnedWorldContexts> {
  throw new Error('not implemented')
}
export async function readWorldTimeContext(db: Db, access: AccessContext,
  target: TimeContextTarget): Promise<WorldTimeContext | null> {
  throw new Error('not implemented')
}
function projectTimeContext(source: TimeContextSource, visit: VisitContext): WorldTimeContext {
  throw new Error('not implemented')
}
// home/queries.ts public operation
export async function readHome(db: Db, access: UserAccess): Promise<HomeOverview> {
  throw new Error('not implemented')
}
```

`OwnedWorldSummary` and `OwnedTimelineSummary` contain the fields already needed by home cards (including original raw world status), not `typeof schema.$inferSelect` exported across the boundary. They are derived by the query operation, with one map by timeline and one grouping by world. Do not duplicate worlds in each exposed timeline DTO.

The implementation uses three fixed queries for the time/visit dataset:

1. Select owned worlds, left join timelines, left join universe revisions and evidence. `WHERE worlds.userId = access.userId` proves ownership; join predicates preserve world/timeline scope. Map each non-null timeline once, with existing revision/evidence defaults. Keep worlds with no timeline.
2. Select session rows for `principalKey = user:<id>` joined to timelines and owned worlds; enforce both session world id and timeline world id. Keep the current `updatedAt DESC` ordering and selection semantics. Group by timeline once.
3. Select legacy watermarks for this user joined to timelines and owned worlds. Group by timeline once. A pure visit projection consumes the grouped sessions and optional watermark.

This avoids D1 bind limits and avoids promising a constant number of queries while chunking arbitrary `IN` lists. Home already returns all owned worlds/timelines, so an owner-filtered relation is the natural query shape. The batch visit reader accepts `UserAccess` and owns its ownership joins. Do not expose a public function that accepts raw preloaded rows and silently trusts their authorization.

The single-target time reader continues to support user, guest, and anonymous current semantics. It calls the same pure projector after its existing authorization/root-selection rules. Single visit reads and batch visit reads share one pure phase projector in `life/visit-context.ts`; session persistence remains in `life/visit-sessions.ts`. Moving read projection out of the mutation service also prevents a `time-context -> visit-sessions -> time-context` import cycle.

World cards reuse `byTimeline.get(mainTimeline.id)`; they do not perform another visit/time read. Preserve root-or-first fallback in home, explicit-invalid-timeline refusal elsewhere, timeline/world sorting, archived entries, missing-context omission, member selection, and the current all-time meaning of `todayEventCount`. Broader home aggregation may still retain its existing person/event/member queries; no SQL is issued per resulting timeline. Use owner-filtered joins for event/member reads too if removing existing `IN` pressure is needed; avoid mixing an unrelated conversation optimization into this unit.

### Authorization before visits

```ts
// Private to visit-sessions.ts. It cannot be constructed by route callers.
interface AuthorizedVisitTarget {
  principal: { key: string; userId: string | null; guestSessionId: string | null }
  context: WorldTimeContext
}
async function requireVisitTarget(db: Db, access: AccessContext,
  input: VisitRequest): Promise<AuthorizedVisitTarget> {
  // Validate request; reject anonymous; authorize world and its timeline.
  // Return their current simNow and access projection. Never write.
  throw new Error('not implemented')
}
```

Reuse an authorized `WorldTimeContext` rather than exposing `TimeContextSource` across modules: return `{ principal, context }`, use `context.simNow`, and replace only `context.visit` after the existing mutation. The pure projection source remains private to the time-context owner.

Both enter and leave call this before replay lookup or mutation, including the “no matching session” leave branch. Preserve request validation, session uniqueness, last-request replay, no-op leave, error status, and facts/clock immutability. This fixes the demonstrated ordering defect; it does not establish historical idempotency or distributed authorization atomicity beyond existing request-time access semantics.

### Canvas workflow owners

```ts
interface WorldVisitOptions {
  target: { worldId: string; timelineId: string; guest: boolean } | null
  onContext(context: WorldTimeContext): void
  onError(message: string): void
}
export function useWorldVisit(options: WorldVisitOptions): void

interface WorldSceneCompatibilityOptions {
  worldId: string; timelineId: string; guest: boolean; canEdit: boolean; archived: boolean
  timeZone?: string
  closeSceneHistory(): void
}
export function useWorldSceneCompatibility(options: WorldSceneCompatibilityOptions): {
  open(purpose: CompatibilityPurpose, target: SceneTarget): Promise<void>
  panel: React.ReactNode
}
```

Visit owns sessionStorage identity, enter/leave request ids, lifecycle generations, hidden-document cleanup behavior, and late-enter leave. It keeps latest callback refs so render-created callbacks do not trigger leave/enter cycles. Dependencies are target scalars, not target object identity. Page application additionally checks returned world/timeline; old results never overwrite the new target. Preserve current storage key/reload semantics rather than introducing a new principal migration during extraction.

Compatibility owns authorized attach, actor identity epoch/token fencing, deferred open, persistence/recovery, polling, preview loaders and panel callbacks. The existing headless `CompatibilitySession` remains the only state-machine owner. The hook owns React integration, not a second copy of session state transitions. This removes approximately 200+ cohesive lines, in addition to visits, without touching shared `right` URL semantics or merging two rendering systems. The page keeps scene history, save revision refs, bootstrap/SSE, URL, and composition. The comparison hook receives the current snapshot, access mode, and page search parameters/setter. It returns read states, retry/selection actions, aligned comparison data, and split event projection while preserving unrelated URL parameters.

### Scene repository ownership and atomic bridge

Maintain `scenes/repository.ts` as a canonical public barrel, with no implementation and no synonym aliases after migrating their callers. Use direct files under `scenes/storage/`:

| Module | Knowledge owned |
| --- | --- |
| `types.ts` | Existing domain scopes/results/errors and commit input types |
| `document.ts` | Document discrimination, hash and stored-document validation |
| `timeline.ts` | Timeline revision read/history/commit/restore/fork and lineage/CAS invariants |
| `legacy.ts` | World-scene reads/commit/init/clone compatibility operations |
| `main-line-bridge.ts` | Statement factories synchronizing root timeline and legacy pointers atomically |

The current timeline portion is approximately 850 lines; bridge and types extraction keep it comfortably under 1,000 without creating read/write stage wrappers. `timeline.ts` and `legacy.ts` import the bridge; the bridge imports schema/document/types, never either operation module. In particular, `legacyMainSceneStatements` must query the timeline head directly or share a tiny internal head query; it must not call back into `timeline.ts` and create a cycle. Preserve distinct version sequences and hashes when mirroring root commits.

The bridge returns statements only. `commitTimelineScene`, `commitScene`, initial world creation, fork and clone still execute exactly their existing complete batches; no factory starts its own transaction. Proof construction, CAS reservation, inserted revision, head update, legacy mirror, guard, and compatibility completion stay in the original batch/order. Never move guard execution after commit.

`TimelineSceneScope.representation` remains its current string contract and runtime unsupported-representation rejection during this move. Narrowing it to `'voxel'` would conflate extraction with a public type change and could erase negative tests. Keep all existing proof/policy enforcement. Rename only true aliases, updating production callers and tests in the same unit.

Prevent external imports of `scenes/storage/*` using the focused architecture check introduced in U5 and included in CI; permit only the public barrel and same-directory siblings. The repository does not need a general lint migration for this one invariant. No shallow public wrapper functions are added.

### Routing: auth belongs to the handler registration

The root app's mount list is not an authorization policy. For routers mounted at `/api`, replace `use('*', ...)` with middleware arguments on the exact handlers they own:

```ts
chatRoutes.post('/persons/:id/conversations', authMiddleware, createConversation)
chatRoutes.get('/conversations/:id/messages', authMiddleware, listMessages)
timelineRoutes.post('/persons/:id/fork', authMiddleware, createFork)
mapRoutes.get('/worlds/:worldId/map/bootstrap', accessMiddleware, bootstrap)
```

Keep existing handlers inline if extracting each one would add boilerplate. This is Hono's native composition, not a custom route registry or regex allowlist. Apply it to all overlapping `/api` routers with global middleware (chat, timelines, life, comparison, memories, map, provenance, scene reads). Also move worlds' blanket scoped-user middleware onto its owned handlers, because `/api/worlds` overlaps scene/map/compatibility paths. Move the broad `/worlds/:id/scene/*` middleware in scene routes and compatibility routes to their actual handlers where cross-router collisions remain. Preserve guest GET scene access and account-only revisions/drafts as distinct policies.

Dedicated disjoint prefixes (`/api/home`, `/api/settings`, `/api/auth`, `/api/admin`) can retain local blanket middleware when it cannot run on siblings. Shared admin prefixes still need review for conflicting policy. Public catch-all remains confined to `/api/public/*`. Once handler-local authorization is in place, reorder overlapping families in a focused route harness and assert both permutations behave identically. Generic `/worlds/:id` is an exact route: it must not require special placement relative to deeper scene paths. Preserve every URL and method.

## Module map and dependency direction

```text
packages/world-contract -> no application imports
web/api/types -> world-contract
api/worlds/status -> world-contract + AccessContext
api/worlds/time-context -> world-contract + status + life/visit-context + DB
api/life/visit-context -> world-contract + AccessContext + DB (read only)
api/life/visit-sessions -> time-context + visit-context + DB (writes)
api/home/routes -> home/queries -> worlds/time-context + DB
WorldCanvasPage -> useWorldVisit + useWorldSceneCompatibility
useWorldSceneCompatibility -> existing compatibility session/store/polling + API + panels
scenes/repository -> storage/{timeline,legacy,types,document}
storage/{timeline,legacy} -> storage/main-line-bridge -> storage/{types,document} + DB
```

## Rationale and interface depth

`readHome(db, user)` hides aggregation, access filtering and batching behind one domain operation. A new caller cannot accidentally skip the authorization phase or repeat context reads. A separate “load, validate, map, enrich” service stack would expose the same intermediate state repeatedly. This choice follows `principle-minimize-reader-load` (read for this candidate): one operation owns the graph and the caller supplies no query plan.

Database rows become normalized sources at the query boundary; status and visit derivation are pure. HTTP remains an adapter. This choice follows `principle-boundary-discipline` (read for this candidate). Authentication still runs at every owning transport route; capability display does not become a mutation guard.

Handler-local middleware and a checked storage import boundary make the safe path mechanically visible. That follows `principle-encode-lessons-in-structure` (read for this candidate). A contributor adding a chat handler sees the authorization beside every neighboring handler, while unrelated routers cannot accidentally authenticate the path first.

## Synthesis decision

Candidate A is the selected base. The cross-judge found it more explicit about private authorization provenance, fixed-query home reads, exact visit mutation ordering, and preserving the D1 scene-write batch. Candidate B is accepted for a public-versus-guest route matrix and a focused import-boundary check for scene storage internals.

For U4, extract the visit lifecycle and compatibility workflow. The first extraction left `WorldCanvasPage` at 1,033 lines, above the design predicate, so U4 also extracts the cohesive comparison workflow: right snapshot and comparison reads, request fencing, right-side SSE, scrub alignment, and legacy `mode`/`right` URL synchronization. Keep camera, event selection, and split layout state in the page. Do not create a general canvas controller or mix the native presentation workspace into the legacy comparison owner.

For U6, put middleware on each handler that owns an overlapping `/api` path, then test protected, public, guest, and cross-router overlap behavior with more than one mount order. Route order is not the authorization policy. For U5, add a focused check that production callers import scene storage only through the public repository barrel or same-directory siblings.

The user explicitly authorized GitHub Actions for this run. The cross-judge's earlier note that authorization had not yet been given records the state at review time; U1 and later units may now push the task branch and dispatch the authorized workflow. No merge, release, or deployment is part of this run.

## Tradeoffs accepted

- Accept three owner-scoped context queries, including session rows, in exchange for truly constant query count and no D1 variable-limit dependence. Large session histories remain a future data-volume optimization; query count is not a latency claim.
- Accept retaining the duplicated version field on the wire in exchange for preserving existing clients; its value has one source.
- Accept one compatibility hook returning a composed panel in exchange for keeping authorization, recovery and preview rendering together; it is explicitly a UI integration owner.
- Accept a small internal bridge in exchange for keeping legacy and timeline scene mirrors atomic and avoiding cyclic operation dependencies.
- Accept explicit auth on every overlapping route declaration in exchange for eliminating global registration-order policy. No generic registration framework is introduced.

## Alternatives considered

1. Generic `loadWorldTimeContexts(db, access, targets, preloadedRows?)` with request-local caching. It supports arbitrary batches but exposes authorization provenance and cache validity to callers. Chunked `IN` queries cannot satisfy the literal query-count predicate for unbounded home results; JSON target tables add machinery absent from the current schema. The owner-scoped operation hides more of the actual home task.
2. Consolidate every API endpoint into one nested world/person/conversation router tree. It can give strong prefix ownership but forces a large URL/param migration across scene, life and guest policies. Handler-local middleware achieves the required protection without making every domain module share one framework tree.
3. Extract a single `useWorldCanvasController`. It makes the page short but keeps all the same mutable knowledge in one module. Visit and compatibility are independent lifecycles with already observable API/session boundaries.
4. Separate scene reads, history, commits, restores and forks into individual service layers. It shortens files but splits lineage and transaction knowledge. Two storage owners plus their atomic mirror bridge retain domain cohesion with shorter call chains.

## Red-flag screen

- Shallow modules: no forwarding service per SQL stage; one home operation and two UI workflow owners.
- Information leakage: shared world DTOs are deliberate contracts; storage rows stay internal; auth context stays server-only.
- Temporal decomposition: scene organization follows timeline versus legacy invariants, not “validate/save.”
- Pass-through methods: repository is an export boundary, not a wrapper layer; bridge performs real synchronized-write assembly.
- Split ownership: one compatibility state machine; one visit lifecycle; one root-mirror statement owner; URL remains in page.
- Two ways to do one task: migrate scene alias imports and remove aliases together; server description and absent-server fallback are explicitly different policies.
- Importable internals: focused import-boundary check covers new scene storage directory.
- Hand-synced lists: status dictionaries are canonical; no second route registry or duplicated auth-path allowlist.

## Implementation reconciliation

Implementation follows the selected design. Accepted deviations must be recorded here before the next unit. The visit mutation boundary carries only a principal and an already authorized context so the projection source stays private. All response, authorization, batching, and transaction invariants remain fixed.

## Open questions and risks

- Can a home fixture prove identical output for no-timeline worlds, fork-only worlds, archived targets, missing revision/evidence, sessions and legacy watermarks? This is an evidence question for U3, not a product choice to block on.
- Do D1/SQLite uniqueness constraints guarantee one revision/evidence row per timeline in the checked-in migrations? Inspect before relying on the joins; if not, resolve duplicate semantics without multiplying cards.
- Does moving auth change unknown-route behavior from incidental 401 to 404? Record intended endpoint versus unmatched-path behavior explicitly in U6; do not let unknown-path middleware spillover become an accidental protected-route contract.
- Do close/reopen visit phase discrepancies need a separate tracked correctness follow-up? Preserve existing phase semantics here; the demonstrated unauthorized write is the only behavior correction required in this design.
- Will the compatibility extraction reduce the page below 1,000 lines without another coherent extraction? Measure the resulting file; history integration is the next owner if needed.
- Does the current branch have complete stage 0 product evidence? U7 must report missing cases as unverified even with green CI.

## Migration order and evidence for U1–U8

1. **U1:** Preserve/record the dirty baseline; add one GitHub Actions workflow covering all existing contract workspaces, API and Web build/type checks/unit tests, plus a small current browser journey. Run on PRs to `main`, manual dispatch, and pushes to `codex/**`; the branch push permits baseline verification before opening a PR because GitHub will not dispatch a workflow absent from the default branch. Cloud only; one bounded worker per heavy suite. Keep all triggers on the same job. Gate artifacts record SHA and actual exit status. Branch-protection configuration is distinct from merely adding the workflow.
2. **U2:** Add world-contract, workspace dependencies/lock entries, move types and shared description policies, retain version alias and supplied-view precedence. Focused status/type resolution tests compare old behavior including unknown/manual/global-cap/idle values. Add world-contract checks to the U1 workflow in the same unit.
3. **U3a correctness:** Authorize visits before writes. Test a real foreign world and timeline for enter and leave; assert unchanged session rows as well as 404, unchanged facts/revisions/clock, and valid guest scope. Track this as a correctness change distinct from batching.
4. **U3b batching:** Extract pure visit projection/read module, implement owner relation with fixed queries, extract `readHome` and reuse context maps. Compare output with baseline fixtures; compare query counts for one versus many timelines, reset query logs after fixture/auth setup, assert no writes on GET. Include more than the usual SQLite bind-limit number of timelines to prove the absence of per-target bound lists without a timing benchmark.
5. **U4:** Extract visits first, verify reload/visible navigation/late response behavior, then compatibility integration and its existing recovery/journey checks. Verify scope changes never apply old context or old private draft metadata. Keep new presentation and legacy split URL logic unchanged.
6. **U5:** Move scene domain types/document helpers/bridge, then timeline/legacy bodies. Migrate synonyms and add import boundary check. Cloud tests cover repository/history, ancestor restore replay, proof guards/rollback, fork isolation, initial/clone atomicity and checked-in migration compatibility. No schema split.
7. **U6:** Add adversarial route overlap fixtures, move auth per family, then permute mount order in the harness. Test public, owner, nonowner, guest, expired guest and bearer+guest precedence on world snapshot, map bootstrap, scene root/history/compatibility, chat, timeline, life, provenance and unknown paths. Assert mutation state on denied visits.
8. **U7:** Run full new Actions gate for the final SHA, inspect job logs/artifacts and outputs, diff-review preserved user work and final boundaries. Do not claim product acceptance solely from stubbed journeys. List remaining BB cases unverified.
9. **U8:** Review comments/style and decision trail, reconcile architecture changes, and report current branch/local dirty files/pushed SHA/CI run independently. Read-only remote confirmation follows any branch push. No release, merge or deployment is implied.

## Candidate workflow checklist

- [x] Ground: read supplied reports, current task/plan and relevant source; no runtime commands.
- [x] Sketch: caller usage, shapes, ownership, alternatives and red-flag screen recorded here.
- [x] Agree: candidate A selected after cross-judge; candidate B route matrix and storage-import boundary accepted.
- [ ] Implement: outside this candidate's read-only scope.
- [ ] Scrap: reconsider if implementation needs duplicated authorization provenance, cache flags, cyclic scene imports, or repeated UI setters across owners.

Implementation proceeds under the coordinator's U1-U8 checklist. The first gate must run against this pre-refactor baseline before U2.
