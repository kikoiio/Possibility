# Candidate B: feature-owned reads and scoped workflows

## Problem

The phase 2B work adds a useful world/time view, but API and Web declare its wire shape and status copy separately. Home computes it with six reads per timeline and repeats root contexts for world cards. `WorldCanvasPage` owns independent visit and comparison lifecycles, and `scenes/repository.ts` mixes timeline revision rules with legacy world-scene storage. Route-wide middleware and overlapping `/api` mounts make path order part of authorization. The current 56 changed or untracked paths include phase 2B work and evidence; the implementation must preserve them and the product contracts in `docs/PLAN.md`. Stage 0 evidence is a stated prerequisite to broad restructuring, so U1 captures that baseline before U2-U6.

## Usage (caller's view)

The home route performs one authenticated read and reuses each timeline's context in both response sections. No caller assembles revision, evidence, session, and watermark rows.

```ts
const user = c.get('user')
const home = await readHome(db, { userId: user.id })
return c.json(home)
// home.timelines[i].timeContext and home.worlds[j].timeContext
// share the same context value for a selected main timeline.
```

Single-target handlers retain their current nullable behavior. An enter/leave request resolves an authorized target before touching `worldVisitSessions`.

```ts
const target = await resolveReadableTimeTarget(db, access, { worldId, timelineId })
if (!target) throw new VisitServiceError('世界或时间线不存在', 404)
const result = await enterVisitForTarget(db, target, { clientSessionId, requestId })
return c.json({ ...result.context, requestId: result.requestId })

const context = await readWorldTimeContext(db, access, { worldId, timelineId })
// context: WorldTimeContext | null; single-target callers remain unchanged.
```

The canvas page supplies target identity to two narrow workflows. Visit status is scoped to the target; legacy comparison owns its right-side reads and URL mode/right synchronization. The page still composes the existing presentation runtime and compatibility session.

```tsx
const visit = useWorldVisit({ worldId, timelineId: activeTimelineId, enabled: !readonly && !!snapshot })
const split = useLegacyWorldComparison({ worldId, snapshot, search, setSearch, mode, setMode, guest, readonly })
const displayedContext = visit.context ?? snapshot?.timeContext
<SplitViewStage {...split.stageProps} />
```

Scene callers name the storage scope they need. An absent timeline scope is never an implicit switch to legacy storage.

```ts
const current = await readCurrentTimelineScene(db, { worldId, timelineId, representation: 'voxel' })
const page = await listTimelineSceneHistory(db, { worldId, timelineId, representation: 'voxel' }, options)
const oldScene = await readLegacyWorldScene(db, worldId)
```

## Shape

### Shared contract and pure status behavior

```ts
// packages/world-contract/src/index.ts; no Db, Hono, React, or wire parser imports.
export type WorldStatus = 'running' | 'paused' | 'capped' | 'archived'
export type TimelineStatus = 'active' | 'archived'
export type WorldStatusReason = 'manual' | 'daily_cap' | 'global_daily_cap' | 'idle' | null
export type VisitPhase = 'first_visit' | 'returning' | 'unknown'
export interface StatusView { key: string; label: string; description: string; frozen: boolean; nextStep: string | null }
export interface VisitContext {
  phase: VisitPhase
  sessionId: string | null
  enteredSimTime: string | null
  previousExitedSimTime: string | null
  hasValidPreviousWatermark: boolean
}
export interface WorldTimeContext {
  worldId: string
  timelineId: string
  simNow: string
  timeZone: string
  stateVersion: number
  revisionVersion: number
  world: { status: WorldStatus; reason: WorldStatusReason; view: StatusView }
  timeline: { status: TimelineStatus; view: StatusView }
  access: { identity: 'owner' | 'guest' | 'readonly'; capabilities: Readonly<Record<'read' | 'write' | 'advance' | 'fork' | 'archive' | 'reactivate', boolean>> }
  visit: VisitContext
}
export function normalizeWorldStatus(raw: string | null | undefined): WorldStatus // not implemented
export function normalizeTimelineStatus(raw: string | null | undefined): TimelineStatus // not implemented
export function normalizeWorldStatusReason(raw: string | null | undefined): WorldStatusReason // not implemented
export function worldStatusView(status: WorldStatus, reason: WorldStatusReason): StatusView // not implemented
export function timelineStatusView(status: TimelineStatus): StatusView // not implemented
export function displayWorldStatusView(raw: string | null | undefined, reason: string | null | undefined, serverView?: StatusView | null): StatusView // not implemented
```

The server constructs views from normalized statuses; Web trusts a supplied server view, then uses the same pure copy for known legacy status. Unknown raw Web status keeps its existing "status uncertain" fallback. `stateVersion` and `revisionVersion` remain required wire fields and current aliases of `universeRevisions.version`; changing their meaning or removing one is a separate API decision. Capabilities remain API-owned because they depend on `AccessContext` and evidence. Parent DTO `timeContext` optionality stays endpoint-specific, including no-timeline worlds.

### Authorized context read

```ts
// api/src/worlds/time-context.ts
type WorldRow = typeof worlds.$inferSelect
type TimelineRow = typeof timelines.$inferSelect
declare const readableTimeTargetBrand: unique symbol // module-private brand
export interface ReadableTimeTarget {
  readonly [readableTimeTargetBrand]: true
  readonly world: WorldRow
  readonly timeline: TimelineRow
  readonly access: AccessContext
  readonly contextWithoutVisit: WorldTimeContext
  // Constructed only by resolveReadableTimeTarget; not accepted from HTTP.
}
export async function resolveReadableTimeTarget(
  db: Db, access: AccessContext, target: { worldId: string; timelineId?: string },
): Promise<ReadableTimeTarget | null> // not implemented
export async function readWorldTimeContext(
  db: Db, access: AccessContext, target: TimeContextTarget,
): Promise<WorldTimeContext | null> // not implemented

// api/src/home/query.ts; only authenticated user homes enter this boundary.
export async function readHome(db: Db, owner: { userId: string }): Promise<HomeData> // not implemented
```

`readHome` first loads owner-filtered world/timeline rows and all owner worlds (including no-timeline worlds). A private `loadOwnerTimeContexts(db, userId, rows)` verifies `world.userId === userId` and `timeline.worldId === world.id`, then joins revisions, evidence, sessions, and legacy `worldVisits` to `timelines` and `worlds` filtered by owner. This avoids `IN` parameter limits and fixes the number of context SQL statements even as timeline count rises. The session query additionally filters `principalKey = user:<userId>` and `worldId = timeline.worldId`; watermark rows are matched to the authorized timeline. Maps keyed by timeline ID feed a pure row-to-context builder, and the same `WorldTimeContext` instance is used for a timeline card and its world's selected root-or-first timeline. No visit or acknowledgment write occurs. Existing archived rows, `todayEventCount` all-time sum, first member ordering, null/undefined shape, and no-root behavior stay as they are.

`api/src/life/visit-context.ts` owns the pure session/watermark projection and the read-only single/bulk SQL. `api/src/life/visit-sessions.ts` owns only enter/leave mutation and consumes it. This dependency direction lets `time-context.ts` use read-only visit projections without importing mutation code. The home query does not call `readWorldTimeContext` in a loop. Single-target reads keep their four target queries until there is independent reason to optimize them.

```ts
// api/src/life/visit-context.ts
export function projectVisitContext(rows: readonly VisitSessionRow[], watermark: LegacyVisitRow | null, sessionId?: string | null): VisitContext // not implemented
export async function readVisitContext(db: Db, access: AccessContext, target: { worldId: string; timelineId: string; sessionId?: string | null }): Promise<VisitContext> // not implemented
// Private to the owner-home query; joins restrict data before projection.
export async function loadOwnerVisitContexts(db: Db, ownerId: string, authorizedTimelineIds: ReadonlySet<string>): Promise<ReadonlyMap<string, VisitContext>> // not implemented

// api/src/life/visit-sessions.ts
export async function enterVisitForTarget(db: Db, target: ReadableTimeTarget, input: Pick<VisitRequest, 'clientSessionId' | 'requestId'>, now?: Date): Promise<VisitResult> // not implemented
export async function leaveVisitForTarget(db: Db, target: ReadableTimeTarget, input: Pick<VisitRequest, 'clientSessionId' | 'requestId'>, now?: Date): Promise<VisitResult> // not implemented
```

The public `enterVisit` and `leaveVisit` service signatures can remain wrappers during migration, but each must call `resolveReadableTimeTarget` before session selection or mutation. The resolved world/timeline and actual principal travel together; callers cannot provide a free-form `{worldId,timelineId}` after authorization. Existing last-request replay and unique client-session behavior remain the baseline. A persisted-row assertion for a real foreign-owned world proves a 404 cannot leave a visit row. The known fresh-session previous-exit inconsistency gets a focused contract decision before modifying projection semantics.

### Canvas workflows

```ts
// web/src/world/useWorldVisit.ts
export interface WorldVisitInput { worldId: string; timelineId: string; enabled: boolean }
export interface WorldVisitState { context: WorldTimeContext | null; error: string | null }
export function useWorldVisit(input: WorldVisitInput): WorldVisitState // not implemented

// web/src/world/useLegacyWorldComparison.ts
export interface LegacyComparisonInput {
  worldId: string; snapshot: WorldSnapshot | null; search: URLSearchParams
  setSearch: SetURLSearchParams; mode: 'life' | 'possibility'; setMode: Dispatch<SetStateAction<'life' | 'possibility'>>
  guest: boolean; readonly: boolean
}
export interface LegacyComparisonState {
  rightRead: AsyncReadState<WorldSnapshot>; comparisonRead: AsyncReadState<TimelineComparison>
  rightTimelineId: string | null; stageProps: SplitViewStageProps
  retryRight(): void; retryComparison(): void; selectRight(id: string): void; close(side: 'left' | 'right'): void
}
export function useLegacyWorldComparison(input: LegacyComparisonInput): LegacyComparisonState // not implemented
```

The visit hook owns sessionStorage identity, enter response fencing, visible-navigation leave, late-enter cleanup, and hidden reload reuse. It does not own or mutate the whole snapshot; the page chooses the latest context for display and can integrate it into existing snapshot props at one adapter point. Legacy comparison owns right snapshot/comparison reads, request generations, right SSE, scrub state, camera linkage, and mode/right URL synchronization. It preserves `right` when presentation comparison parameters use it. Existing `ComparisonHost` and compatibility state machine stay independent. Scene history and repair handoff remain in the page for U4 unless this extraction fails the 1,000-line goal; then extract that cohesive workflow as a second U4 step, not a generic page controller.

### Scene storage and route ownership

`api/src/scenes/timeline-scene-read.ts` and `legacy-scene-read.ts` own their respective current/version reads and validation with no write-proof dependency. `api/src/scenes/timeline-revisions.ts` owns timeline history, commits, restores and fork statements; it imports timeline reads and write-proof. `api/src/scenes/legacy-world-scenes.ts` owns legacy writes and initial/clone statements; it imports legacy reads and write-proof. Both `compatibility/context.ts` and `compatibility/write-proof.ts` import only the read modules, breaking their existing cycle through `repository.ts`. `api/src/scenes/document.ts` contains only document/hash utilities genuinely used by both. A canonical `api/src/scenes/repository.ts` exports the old names temporarily while production callers move in one unit; remove redundant history/commit aliases and mixed `scope?` overloads after migration. Keep D1 batch guard, compatibility proof, idempotent request, baseline, and clone atomicity inside the owning repository methods.

`api/src/index.ts` mounts path-owning routers at explicit prefixes. Each router installs auth on its own routes or narrower subrouters: `/api/worlds` owner/guest endpoints; `/api/worlds/:id/scene` read and protected mutation groups; `/api/persons` account-only and separate guest paths; `/api/timelines` and `/api/conversations` account-only. Where Hono's route registration requires one shared prefix, mount exact static routes before the generic `/:id` handler **inside that router**, with a route-overlap test at the boundary. Remove root-mounted `use('*', authMiddleware)` from routers mounted at `/api`; auth must only run for paths that router owns. Keep existing guest token precedence and exact world allowlist. Move one family at a time, exercising public/guest/account/anonymous matrix and `/worlds/:id` versus `/worlds/:id/scene` overlap before changing the next family.

## Module map

| Owner | Public surface | Private knowledge |
|---|---|---|
| `packages/world-contract` | Wire types, normalization, pure status views | Status copy and known/unknown fallback |
| `api/src/worlds/time-context.ts` | Resolve one authorized target, single context read | Ownership and world/timeline relationship, evidence capabilities |
| `api/src/life/visit-context.ts` | Single visit projection; owner batch read | Principal sessions and legacy watermark selection |
| `api/src/life/visit-sessions.ts` | Enter/leave | Visit state transitions and replay |
| `api/src/home/query.ts` | `readHome` | Owner-scoped batch joins and response aggregation |
| `web/src/world/useWorldVisit.ts` | Current visit context/error | Browser session and effect lifecycle |
| `web/src/world/useLegacyWorldComparison.ts` | Split state/actions | Right reads, URL keys, SSE, scrub/camera state |
| `api/src/scenes/timeline-scene-read.ts` | Timeline current/version reads | Revision decoding and integrity checks |
| `api/src/scenes/legacy-scene-read.ts` | Legacy current/version reads | World-scene decoding and integrity checks |
| `api/src/scenes/timeline-revisions.ts` | Timeline scene operations | Revision chain, proof, guarded writes |
| `api/src/scenes/legacy-world-scenes.ts` | Legacy world scene operations | World scene revisions and clone compatibility |
| Path-owning API routers | Existing HTTP paths | Local auth and overlap policy |

## Rationale

The public `readHome` call hides joins, authorization, maps and context assembly while the single-target API remains small. This is a deeper boundary than exposing a general batch cache that every caller must fill correctly. The `ReadableTimeTarget` capability is created only after access and relationship checks, so visit writers receive proof of a readable target instead of independently trusting strings. Shared status data contains no transport or database type, and API-only capability policy stays where it is enforced. Two hooks each own a lifecycle rather than moving all page state into another large object. Scene scope is explicit in function names, making timeline and legacy invariants visible at a call site.

## Synthesis decision

This is an independent candidate. The coordinator will compare it with the other sketch and record the selected base and grafts in the synthesized design.

## Tradeoffs accepted

- We accept owner-home queries that join all owner timelines in exchange for a fixed number of context queries and no SQLite `IN` chunking policy at the call site.
- We accept a short-lived scene repository compatibility barrel in exchange for one migration unit that can preserve existing imports until all callers have moved.
- We accept keeping both version fields as aliases in exchange for phase 2B wire compatibility while their future semantics are decided.
- We accept a presentation adapter in the page in exchange for hooks that do not write each other's state.

## Alternatives considered

- A generic `loadContextParts(ids)` cache would expose revision/evidence/session coordination, authorization and reuse rules to every caller. Its public interface is larger and less protective than `readHome` plus the single-target read.
- A single `useWorldCanvasController` would hide page line count but expose a broad state/action object whose consumers must understand unrelated visit, comparison and scene lifecycles.
- Keeping `commitScene(input.scope?)` as the canonical scene API would preserve one call name but hide two storage engines behind an optional field; new callers could still write the wrong store.
- Splitting every `/api` route into one router per endpoint would remove order coupling at the cost of more imports and route registries. Family-level path ownership is the smaller boundary.

## Red-flag screen

The home caller invokes one operation, so it does not coordinate shallow loaders. Shared contract types do not export DB/wire parsers. Visit projection and mutation have distinct state ownership. Scene repository aliases are explicitly temporary and must be deleted in U5, avoiding two permanent ways to perform one task. Router definitions remain within path-owning families rather than introducing a hand-maintained central authorization table. No module imports another feature's private implementation except the named, narrow read boundary.

## Open questions and risks

- Does product policy intend guest/public-baseline time-context capabilities to differ from mutation policy? Keep current semantics in this refactor until a separate policy decision settles them.
- Should entering a new client session after a closed one always expose that previous exit in both the immediate response and a subsequent read? Existing code differs; resolve with a contract fixture before changing it.
- Should two root timelines be rejected in home as `resolveTimelineSceneScope` already rejects an implicit non-unique root, or retain home's first-root choice? This sketch retains current home behavior.
- Can family routers be mounted at exact Hono prefixes without their `use('*')` middleware intercepting sibling prefixes? Verify with route matrix tests before deleting the root order comments.
- Does stage 0 product evidence exist for this branch? U1 should capture the pre-refactor acceptance baseline and state any unobserved product cases explicitly.

## Migration order for U1-U8

1. **U1.** Add `pull_request`/`workflow_dispatch` GitHub Actions checks for all workspaces and one representative browser journey. Capture the current phase 2B baseline and stage 0 evidence gap; inspect the cloud run before structural edits. Cloud use was authorized by the user and must be scheduled by the coordinator.
2. **U2.** Add `@possibility/world-contract`, move DTO/status pure functions, update API/Web imports and Web fallback adapter. Compare exact response shapes and status copy, including unknown/paused reasons.
3. **U3.** Introduce pure visit projection and owner-scoped `readHome` aggregation. Add a real foreign-owner no-write regression, then authorize before enter/leave mutations. Verify fixed context query count as timeline count grows and owner/guest/archived/no-root values.
4. **U4.** Extract visit hook first, then legacy comparison workflow. Keep page URL and presentation composition stable. Check late enter, visible leave, hidden reload, right-pane stale response, and `right` parameter sharing. Extract history as a second cohesive unit only if needed for the size predicate.
5. **U5.** Split timeline and legacy scene repositories, migrate production and test imports, then delete synonym aliases. Preserve batch/guard writes and fork/history/repair behavior.
6. **U6.** Move account and guest auth under path-owning routers one family at a time. Prove public, protected, guest and overlapping paths from HTTP responses and no unauthorized side effects.
7. **U7.** Run and inspect the complete new GitHub Actions gate and artifacts; review the diff and record unverified product acceptance cases honestly.
8. **U8.** Review comments/style and decision trail, then report exact working tree, CI run, branch and push state. Preserve all pre-existing user paths throughout.

## Implementation reconciliation

No implementation was performed in this candidate. The coordinator should record any accepted signature, policy or ownership deviation in the synthesized design before handing a unit to the next worker.

## Next implementation step

Create U1's cloud quality gate against the present branch and capture its result before moving the world/time contract.
