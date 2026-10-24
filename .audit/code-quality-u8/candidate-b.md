# U8 candidate B: launch state and endpoint decoders

## Problem

`useWorldSceneCompatibility` loses errors before `CompatibilitySession.check()` can publish a continuation: authorization/session attachment and the current-scene read. A queued open can also reject outside the hook's visible outcome. Those are local launch failures, whereas a session's `conflict` and `unknown` are durable compatibility outcomes. Meanwhile `postSSE` treats all parsed JSON as `any` and catches callback exceptions as malformed frames. Chat/catchup, scene, and native2d consume different event sets. This design gives each owner one state/validation boundary without changing session recovery or stream-close semantics.

## Usage (caller's view)

The compatibility hook still gives callers `{ open, panel }`. An open request is retained across attachment failure. The panel displays a launch error with **Retry** and **Close**; Retry repeats authorization and current-scene reading for the same world, timeline, identity, purpose, and target. Once a session publishes a `conflict` or `unknown` continuation, the existing panel and recovery actions take over.

```tsx
// World scene action: no extra setup or error channel for callers.
const compatibility = useWorldSceneCompatibility(options)
void compatibility.open('restore-history', { kind: 'history', version, targetRevisionId })
return compatibility.panel

// ChatStream: endpoint ownership supplies a typed event.
await chatApi.catchup(conversationId, event => {
  if (event.type === 'text') append(event.delta)
  if (event.type === 'error') showError(event.message)
})

// ScenePanel: no assertion from an arbitrary SSEEvent.
await sceneApi.send(worldId, request, event => {
  if (event.type === 'utterance') appendUtterance(event.name, event.text)
  if (event.type === 'done') receivedDone = true
}, signal)
```

Native2d's injected stream remains `Record<string, unknown>` for its test seam; its default stream converts only validated scene events into that record. The sample consumer switches on supported `type` values before appending dialogue text.

## Shape

```ts
// useWorldSceneCompatibility.tsx: transient, hook-owned; never stored as a continuation.
type LaunchRequest = { purpose: CompatibilityPurpose; target: SceneTarget }
type LaunchFailure = {
  scope: { worldId: string; timelineId: string; authIdentityEpoch: number }
  request: LaunchRequest
  stage: 'attach' | 'current-scene' | 'check'
  message: string
}
type LaunchView =
  | { state: 'closed' }
  | { state: 'opening'; request: LaunchRequest }
  | { state: 'failed'; failure: LaunchFailure }

function isCurrentLaunch(scope: LaunchFailure['scope'], token: string | null, generation: number): boolean {
  throw new Error('not implemented')
}
async function attachAndOpen(request: LaunchRequest, generation: number): Promise<void> {
  // TODO: resolve actor, read current version, attach/subscribe session, then check.
  // On attach/current-scene failure, publish only if scope, credential, and generation match.
  // On rejected check, inspect session.snapshot(): published conflict/unknown owns the UI;
  // otherwise publish a retryable launch failure if the request is still current.
  throw new Error('not implemented')
}
function retryLaunch(): void { throw new Error('not implemented') }

// client.ts: transport does not declare an endpoint's vocabulary.
export async function postSSE(
  path: string, body: unknown, onPayload: (payload: unknown) => void,
  signal?: AbortSignal,
): Promise<void> { throw new Error('not implemented') }

// types.ts: public domain events; source of truth for endpoint callbacks.
export type ChatEvent =
  | AgentStreamEvent
  | { type: 'pending'; requestId: string }
// Existing AgentStreamEvent should gain route fields only where a route sends them,
// e.g. done.requestId/replayed. Preserve the existing SceneEvent union in this module.

// client.ts, private functions near the endpoint wrappers.
function decodeChatEvent(payload: unknown): ChatEvent | null { throw new Error('not implemented') }
function decodeSceneEvent(payload: unknown): SceneEvent | null { throw new Error('not implemented') }
// Signatures on the existing chatApi/sceneApi objects:
type SceneSendRequest = {
  timelineId: string; location?: string; content: string
  dialogueId?: string; requestId?: string
}
chatApi.send(
  conversationId: string, content: string, requestId: string,
  onEvent: (event: ChatEvent) => void, signal?: AbortSignal,
): Promise<void>
chatApi.catchup(
  conversationId: string, onEvent: (event: ChatEvent) => void,
  signal?: AbortSignal,
): Promise<void>
sceneApi.send(
  worldId: string, body: SceneSendRequest,
  onEvent: (event: SceneEvent) => void, signal?: AbortSignal,
): Promise<void>
```

The hook owns one transient `LaunchView` and the existing session reference; `CompatibilitySession` alone owns continuation transitions. `open` records the latest request, starts a generation, and the attachment effect replays it. `retryLaunch` starts a new generation for that request. An identity/world/timeline change invalidates old generations and clears the launch view. Closing invalidates the generation and clears the pending request. The launch panel is a small sibling of `SceneCompatibilityPanel`, rendered only while no current non-idle continuation exists. Its Retry calls the hook, without exposing attachment stages to page callers. Keep `session.check()`'s published `conflict/unknown` and their existing panel controls authoritative; an unexpected rejection gets a launch error only when no usable continuation was published. Retrying an unexpected check error must reset only a session state whose rules allow restart, and must never reset `submitting` or `unknown`.

The stream transport parses each `data:` payload to `unknown`. Its `try/catch` surrounds `JSON.parse` alone; `onPayload(parsed)` runs outside it so a consumer exception rejects `postSSE`, while `finally` still releases the reader. Endpoint decoders check `type` and every field their domain event promises, returning `null` for unknown or malformed events. Their wrappers call the consumer only for validated events. This keeps caller branches trustworthy and future event types ignorable. Do not resolve early on `done`; request-status APIs remain the durable completion source. Native2d validates its generic default stream payload as a record or routes through the scene decoder, without a parameter cast.

Module map: `useWorldSceneCompatibility.tsx` owns launch attempts and stale-work guards; a small `SceneCompatibilityLaunchPanel.tsx` owns only display/Retry/Close; `compatibility-session.ts` and `compatibility-store.ts` remain the continuation owners. `api/client.ts` owns wire parsing and endpoint decode functions near `chatApi`/`sceneApi`; `api/types.ts` owns the domain event unions; `ChatStream.tsx`, `ScenePanel.tsx`, and native2d call the typed wrappers. All decoders stay private, so wire payloads and parsing policy do not become a second public API. The exposed surface remains `{ open, panel }`, `chatApi.send/catchup`, and `sceneApi.send`; these hide attachment races and parsing rules behind the operations callers already use.

## Synthesis decision

Pending arena comparison. This independent candidate chooses transient launch state and endpoint decoding as its base shape.

## Tradeoffs accepted

- We accept a separate launch panel in exchange for keeping pre-session failures out of durable submission recovery state.
- We accept per-endpoint runtime field checks in exchange for accurate callback types at a network trust boundary.
- We accept ignoring unrecognized event types in exchange for forward compatibility with server additions consumers do not use.

## Alternatives considered

- Extend `CompatibilityContinuation` with attachment failures: this forces fake session identity/request data into durable storage and exposes pre-session stages to session callers.
- Put endpoint event unions into `postSSE<T>` and cast parsed JSON to `T`: the type parameter is caller-controlled, so it hides no validation and leaves the transport coupled to wire assumptions.
- Change only `any` to `unknown` and narrow in each component: callers duplicate field checks and route knowledge, producing a shallow transport interface.

## Implementation reconciliation

Pending implementation. Reconcile any changes to retry behavior or event shapes here before closing the unit.

## Open questions and risks

- Does `authApi.me()` always require a fresh call after retry, or can the same actor identity be reused while the credential remains unchanged?
- Which route-level chat events beyond `pending`, `skipped`, `error`, and `done` are actually emitted by all chat/catchup/fork paths, and should `catchup` expose a narrower union?
- Should malformed known-type events be ignored with diagnostics, given that a missed `done` already falls back to request-status recovery?

## First implementation step

Add the hook-owned launch state and a focused launch panel, then route attachment, current-scene, and queued-check failures through one guarded attempt function.

## Design red-flag screen

- Shallow module/pass-through: the launch panel is presentation-only; the hook handles the full retry operation. Endpoint wrappers perform real parsing/validation, not just forwarding.
- Information leakage/importable internals: decoder and wire `unknown` remain private to `client.ts`; public event types describe consumer domain data.
- Temporal decomposition/split ownership: the hook owns transient launches; the session owns durable continuations. No stage service or second continuation writer is introduced.
- Two ways/hand-synced list: page callers use endpoint wrappers; native2d's injectable generic stream is the existing seam. Decoder branches derive from the event union through exhaustive known-type handling, with API route changes reviewed against that contract.
