# U8 design

## Problem

The compatibility hook owns session attachment and the current-scene pre-read as well as the visible panel. Its broad catches hide failures that occur before `CompatibilitySession.check()` can publish its conflict or unknown continuation. The POST SSE transport has an open `any` payload and catches consumer errors together with JSON parse failures, while its endpoint callers receive different event vocabularies. The fix must add feedback without changing durable recovery state and must validate each stream at the endpoint boundary.

## Usage (caller's view)

Page callers keep the hook's existing surface. An open either reaches the compatibility session or presents a scoped, retryable entry failure.

```tsx
const compatibility = useWorldSceneCompatibility(options)
void compatibility.open('restore-history', { kind: 'history', version, targetRevisionId })
return compatibility.panel
```

Chat and scene callers receive domain events from the endpoint methods. They do not parse JSON or cast arbitrary records.

```ts
await chatApi.catchup(conversationId, event => {
  if (event.type === 'text') appendText(event.delta)
  if (event.type === 'error') showError(event.message)
}, signal)

await sceneApi.send(worldId, request, event => {
  if (event.type === 'utterance') appendUtterance(event.name, event.text)
  if (event.type === 'done') receivedDone = true
}, signal)
```

Native2d's injected stream port uses `SceneEvent`. Control events are handled by their discriminator and never become dialogue text.

## Shape

### Compatibility entry state

The hook keeps the continuation state machine and persistence in `CompatibilitySession`. It owns only the transient request to enter that flow and any failure that happens before a usable continuation exists.

```ts
type ScopeKey = {
  worldId: string
  timelineId: string
  identityEpoch: number
}
type OpenIntent = { purpose: CompatibilityPurpose; target: SceneTarget }
type EntryStage = 'attach' | 'current-scene' | 'check'
type EntryState =
  | { state: 'idle' }
  | { state: 'opening'; scope: ScopeKey; attempt: number; intent: OpenIntent }
  | { state: 'failed'; scope: ScopeKey; attempt: number; intent: OpenIntent; stage: EntryStage }

function isCurrentEntry(scope: ScopeKey, attempt: number, token: string | null): boolean {
  throw new Error('not implemented')
}
async function runOpen(intent: OpenIntent, attempt: number, session: CompatibilitySession): Promise<void> {
  throw new Error('not implemented')
}
function retryEntry(): void { throw new Error('not implemented') }
```

One hook-owned current entry record contains the pending intent, attempt number, visible stage, and scope. A private current-state ref backs immediate async guards; React state renders it. Avoid mirroring pending intent in another ref. The existing effect's active flag, scope, auth epoch, and identity token check remain the attachment fence. Every async success and failure also checks that the attempt is still current. A newer open supersedes an older one; Close invalidates the current attempt; a scope or token change clears stale entry state.

Attachment remains proactive so stored continuation recovery still attaches on page load. A passive attach failure is remembered for the current scope but shown only after an open request needs the session. An open during attachment stays `opening` and is replayed once after successful attachment. If attachment already failed, the open displays `stage: 'attach'`; retry reruns attachment. With a session, `runOpen` reads the current scene and then calls `session.check()`. A read rejection becomes `stage: 'current-scene'`; retry repeats the open. A check rejection is considered represented only when that same session published a matching `conflict` or `unknown` continuation. An unexpected rejection becomes `stage: 'check'`. Existing submitting/unknown work keeps the compatibility panel's authority and is not replaced by an entry error.

Render a small alert with fixed safe text, Retry, and Close from the hook's `panel` result. Do not fabricate a `CompatibilityContinuation`, persist entry failures, or map them to submission-result recovery. Stage chooses a safe explanation and retry action; raw exception text is not shown.

### POST SSE boundary

Wire payloads stay `unknown` inside `client.ts`. Endpoint wrappers select runtime decoders and expose the corresponding domain event type.

```ts
type EventDecoder<T> = (payload: unknown) => T | null

type AgentStreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'event'; id: string; simTime: string; title: string; description: string }
  | { type: 'state'; state: PersonState }
  | { type: 'memory'; id: string; content: string }
  | { type: 'done'; llmCalls?: number; error?: string }

type StreamFailureEvent = { type: 'error'; message: string; requestId?: string; errorCode?: string }
type ChatMessageEvent =
  | { type: 'text'; delta: string; replayed?: true }
  | Extract<AgentStreamEvent, { type: 'event' | 'state' | 'memory' }>
  | { type: 'done'; llmCalls?: number; error?: string; requestId?: string; replayed?: true }
  | StreamFailureEvent
  | { type: 'pending'; requestId: string }
type CatchupEvent =
  | Extract<AgentStreamEvent, { type: 'text' | 'event' | 'state' | 'done' }>
  | StreamFailureEvent
  | { type: 'skipped' }
type PersonTimelineForkEvent =
  | Exclude<AgentStreamEvent, { type: 'done' | 'memory' }>
  | { type: 'timeline'; timelineId: string }
  | { type: 'done'; llmCalls?: number; error?: string; fork?: ForkResult }
  | StreamFailureEvent

async function postSSE<T>(
  path: string, body: unknown, decode: EventDecoder<T>, onEvent: (event: T) => void,
  signal?: AbortSignal,
): Promise<void> { throw new Error('not implemented') }
```

The scene union remains its existing `scene_start`, `utterance`, `error`, and `done` shape. Keep the named agent type only for actual agent output; do not put chat-only `pending`, catchup-only `skipped`, or fork-only `timeline` in it. A shared decoder can validate agent-owned variants; endpoint decoders add their own variants without duplicating base validation. The current `PersonState` matches the five fields emitted in `state`; no partial-state alias or cast is needed.

The transport catches `JSON.parse` failures alone. It calls the decoder afterward; unknown event kinds return `null` and are ignored for forward compatibility, while a malformed known kind raises a protocol error. Callback execution is outside both catches so callback failure rejects the request and reaches the consumer's existing recovery path. Keep frame splitting and EOF behavior unchanged in this unit; completion remains governed by stream close and request-status APIs.

Make `postSSE` private. `chatApi.send`, a new `chatApi.catchup`, and the scene send method own path, decoder, and public callback type. Migrate `ChatStream` off the direct raw call; type the native2d injection as `SceneEvent` and remove its parameter cast; remove `ScenePanel`'s assertion. The current person-fork SSE route has no Web caller; keep its explicit domain event contract separate from chat and do not add an unused transport wrapper just to test it.

The surface hides transport decoding behind endpoint methods and exposes one transient entry state through the hook's existing `{ open, panel }` result. The endpoint methods add path and validation policy, so they are not pass-through wrappers. Keep decoders private beside the transport initially; `client.ts` was 771 lines at sketch time and is 929 lines after the change, still below the 1,000-line design limit.

## Synthesis decision

Candidate A is the base. It scored 5/5 on scoped visible entry failures, stale-work ownership, endpoint event accuracy, and behavior/verification coverage, and 4/5 on interface depth (24/25 total). Candidate B scored 4, 4, 3, 4, and 3 (18/25). The cross-judge, `gpt-6-luna`, independently recommended A because it defines route-specific event sets and guards queued/direct opens more fully.

Graft from candidate B: add a structured `EntryStage` (`attach`, `current-scene`, `check`) so presentation and retry behavior depend on a typed reason rather than exception text. Keep A's hook ownership and do not add B's separate presentation-only panel; the hook's existing `panel` boundary can render this small notice without exposing a second retry owner.

Rejected: storing entry failures in `CompatibilityContinuation` would mix transient access/read problems with persisted repair and submission recovery. A generic `postSSE<T>` without a decoder would be a caller-selected assertion, not validation. A public open dictionary plus per-component guards would duplicate endpoint policy and leave contracts divergent. A single global event union would allow invalid events at endpoint callbacks.

## Tradeoffs accepted

- We accept a scoped transient entry state in the hook in exchange for leaving the durable compatibility state machine unchanged.
- We accept endpoint decoder code and representative fixture tests in exchange for trusted callback types at the network boundary.
- We accept ignoring future event kinds but fail malformed known kinds, so additions remain compatible while contract drift is visible.
- We preserve current frame and EOF semantics; CRLF support and early completion on `done` remain separate transport decisions.

## Callback freshness finding

The independent no-comments review found that `ChatStream`'s initial-load effect intentionally depends only on `conversationId` and `withCatchup`, but its suppression also hid a stale `onStateChange` closure. Candidate A scored 25/25 and candidate B scored 24/25; the cross-judge selected A for its explicit callback-error and lifecycle boundaries. Keep one component-local ref synchronized in `useLayoutEffect`, and read `.current` from both catchup and send SSE callbacks at event time. This gives the latest committed callback without restarting catchup/history or exposing a callback from an abandoned concurrent render.

Graft from candidate B: Strict Mode can still replay catchup work when the transport cannot cancel it. Callback freshness does not change or claim to fix that separate stream-lifecycle behavior. Reject adding the callback to the load effect dependencies because it repeats history work; reject routing state events through component state because it can coalesce events and replay the last value to a replacement callback.

The implementation keeps the public prop signature and load-effect dependency list, removes the lint suppression, and updates the callback ref before paint. The compatibility guard checks the synchronous auth-epoch ref as well as the render scope and identity token, so a response cannot publish between an auth event and the render that reflects it. It does not add send cancellation or conversation ownership; an old send can still outlive unmount under the existing lifecycle contract.

## Alternatives considered

- Put entry failures in the session continuation: this makes callers learn about pre-session stages and risks sending an inspection failure to submission recovery.
- Use `{ type: string; [key: string]: unknown }` at every consumer: this keeps transport simple but spreads parsing and endpoint assumptions across UI modules.
- Pass a generic type argument to `postSSE<T>` without a decoder: the caller can claim any payload shape, leaving runtime data unchecked.

## Implementation reconciliation

The compatibility hook owns scoped transient entry failures while the existing session owns conflict, unknown, and submission recovery state. Retry reuses the captured open intent; stale scope and attempt guards protect both outcomes. POST SSE now keeps parsed payloads unknown, decodes chat, catchup, and scene at endpoint boundaries, validates known event fields, ignores unknown event kinds, and propagates consumer callback exceptions. The caller path uses the same endpoint methods and native2d consumes `SceneEvent` by discriminator.

The implementation also narrows `CatchupEvent` to text/event/state/done plus route-specific error/skipped, and excludes memory from the simulate timeline-fork contract. `decodeCatchupEvent` rejects a known agent `memory` event because catchup mode does not expose the remember tool. This is a contract correction consistent with the endpoint ownership sketch, not a behavior change for valid route output. The ChatStream callback ref is the accepted local freshness fix described above; the public prop and stream lifetime remain unchanged.

## Open questions and risks

- The frontend `PersonState` currently matches the agent's five-field state payload. Keep the decoder and both type declarations aligned if that schema changes.
- The timeline-fork event union is not consumed by a Web wrapper. Its endpoint contract is represented in types but has no client runtime decoder test.
- The callback ref does not add cancellation for a send that outlives unmount. That behavior remains outside this change's contract.
- The 10-second Mist Manor repair limit remains runner-speed sensitive; the budget was not widened.

## Verification result

Actions run `38823940837` passed on commit `28f20bb`. Shared-contract tests passed 204 cases, API passed 986 with one skipped, Web passed 757, and Chromium passed all 23 journeys. The 52,714,846-byte artifact `12014039600` contains 23 traces. The callback trace shows the Vite refresh module and harness loaded with HTTP 200, the catchup and send requests both returned HTTP 200, and the final DOM recorded `catchup-current:catchup-state` and `send-current:send-state`. It contains no React page error.

The browser journeys cover current-scene read retry, passive attachment retry, ignoring a late response after timeline scope changes, and callback replacement during active catchup/send streams without repeating catchup or history work. Client tests cover typed chat/catchup/scene events, malformed known events, unknown events, invalid catchup memory events, and consumer callback errors. The phase 2B manifest marks AC8 and AC12 unverified by this gate. AC8's delayed A/B response and full write-audit journey did not run; AC12's complete timezone, review, advance, fork/split, pause/archive, and refresh journey did not run.
