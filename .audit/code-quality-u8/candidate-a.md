# Candidate A: hook-owned entry failures and endpoint-owned stream decoding

## Usage (written before shape)

The world page keeps its current two-member interface. An open request either reaches the existing compatibility session or produces a visible entry error with Retry and Close. Retry repeats the same purpose/target under the current scope; it never calls submission recovery.

```tsx
const compatibility = useWorldSceneCompatibility(options)
<button onClick={() => void compatibility.open('repair-current', { kind: 'current' })}>检查场景</button>
{compatibility.panel}
```

Chat callers receive domain events from endpoint methods, with unknown future event kinds ignored at the boundary. Callback failures reject the stream promise and reach existing request-status recovery.

```ts
await chatApi.catchup(conversationId, event => {
  if (event.type === 'text') appendText(event.delta)
  if (event.type === 'state') onStateChange?.(event.state)
}, signal)
await chatApi.send(conversationId, content, requestId, event => {
  if (event.type === 'pending') rememberPendingRequest(conversationId, event.requestId)
  if (event.type === 'error') showError(event.message)
}, signal)
```

ScenePanel and native2d dialogue consume the same scene event contract. Control events do not become dialogue text.

```ts
await sceneApi.send(worldId, body, event => {
  if (event.type === 'utterance') appendUtterance(event.name, event.text)
  if (event.type === 'error') showError(event.message)
}, signal)
```

## Problem and grounding

The hook currently owns identity resolution, current-scene reads, session attachment, queued open requests, and presentation. `CompatibilitySession.check()` already publishes conflict/unknown before throwing. Creating another session state for attachment failures would mix resource-entry problems with durable repair operations. The hook's broad catches currently lose pre-session errors and current-scene read failures. A separate hook-owned entry state preserves the existing session state machine.

The stream transport currently catches JSON syntax failures and callback failures together. Its index signature also lets every endpoint pretend to emit every payload. Routes show that send can emit `pending` and replay metadata, catchup can emit `skipped`, fork adds `timeline` and successful `done.fork`, and scene has its own four events. `AgentEvent.state` is narrower than the existing frontend `PersonState`; reusing that interface blindly would preserve a false contract.

## Shape

### Compatibility data and ownership

```ts
type OpenIntent = { purpose: CompatibilityPurpose; target: SceneTarget }
type EntryState =
  | { kind: 'idle' }
  | { kind: 'opening'; scope: ScopeKey; intent: OpenIntent }
  | { kind: 'failed'; scope: ScopeKey; intent: OpenIntent; message: string }
type ScopeKey = { worldId: string; timelineId: string; identityEpoch: number }

// Private to the hook. The epoch identifies the active attachment generation.
type Attachment = {
  generation: number
  scope: ScopeKey
  identityToken: string | null
  session: CompatibilitySession | null
  failure: unknown | null
}

function useWorldSceneCompatibility(options: WorldSceneCompatibilityOptions): {
  open(purpose: CompatibilityPurpose, target: SceneTarget): Promise<void>
  panel: ReactNode
} { throw new Error('not implemented') }
```

Keep session continuation exclusively owned by `CompatibilitySession`; keep entry failures exclusively in the hook. A private generation token supplements the existing active-effect/token checks. Every completion checks generation, world, timeline, identity epoch, and token before publishing. Replaced or dismissed open intents also have a monotonically increasing request sequence so a slow read cannot reopen a closed panel. Scope switches invalidate both attachment and intent synchronously in rendering/operation guards, not only after effect cleanup.

The attachment effect remains proactive to restore persisted submission state. A passive attachment failure is stored in the attachment record without showing unsolicited UI. If the user has an open intent, it becomes `failed`; an open after an earlier failure immediately shows that failure. Retry increments an attachment-attempt counter only when no valid session exists; otherwise it repeats the current-scene read using the existing session. The pending intent remains owned by the hook and is replayed once after successful attachment. A separate attachment generation prevents an old failed retry from clearing a newer success.

Both queued and direct opens call one private `runOpen(intent, attachment)` operation. It reads the current scene and then calls `session.check()`. A rejected `CompatibilitySessionError` is treated as represented only when that same session's current snapshot is conflict/unknown and matches the requested operation; the entry state returns idle so the existing continuation UI wins. Unexpected exceptions and pre-read failures produce the hook's failed state. No broad empty catch remains. Do not classify every `CompatibilitySessionError` as represented: an invalid transition may throw without publishing an error state.

The hook renders a small alert/dialog with fixed user-facing text, Retry and Close when its current entry state is failed. It does not pass fake continuations to `SceneCompatibilityPanel`. Close invalidates the intent and clears entry state; existing submit/unknown close behavior remains intact. Retry is disabled while opening. Panel precedence is entry error, then valid non-idle continuation; an error should not erase a durable submission state. Opening during submitting/unknown must preserve the existing operation refusal and visible continuation rather than invent a retryable attachment error.

### Stream data and boundaries

```ts
type AgentStateUpdate = Pick<PersonState, 'simTime' | 'location' | 'activity' | 'mood' | 'goal'>
type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'state'; state: AgentStateUpdate }
  | { type: 'event'; id: string; simTime: string; title: string; description: string }
  | { type: 'memory'; id: string; content: string }
  | { type: 'done'; llmCalls?: number; error?: string }
type StreamError = { type: 'error'; message: string; requestId?: string; errorCode?: string }
type ChatEvent = AgentEvent | StreamError | { type: 'pending'; requestId: string }
type CatchupEvent = AgentEvent | StreamError | { type: 'skipped' }
type ForkEvent = Exclude<AgentEvent, { type: 'done' }> | StreamError
  | { type: 'timeline'; timelineId: string }
  | { type: 'done'; llmCalls?: number; error?: string; fork?: ForkResult }
// SceneEvent is the existing union; reuse it.

type EventDecoder<T> = (payload: unknown) => T | null
// Private transport vocabulary, never a public UI type:
async function postSSE(
  path: string, body: unknown, onPayload: (payload: unknown) => void,
  signal?: AbortSignal,
): Promise<void> { throw new Error('not implemented') }
function decodeChatEvent(payload: unknown): ChatEvent | null { throw new Error('not implemented') }
function decodeCatchupEvent(payload: unknown): CatchupEvent | null { throw new Error('not implemented') }
function decodeForkEvent(payload: unknown): ForkEvent | null { throw new Error('not implemented') }
function decodeSceneEvent(payload: unknown): SceneEvent | null { throw new Error('not implemented') }
```

Parsed JSON is `unknown`. The JSON try/catch covers only `JSON.parse`; callback execution occurs after it. Endpoint wrappers decode into domain unions before invoking callers. Unknown event types return null and are ignored for forward compatibility. Known kinds with invalid required fields throw a protocol error, which rejects the request instead of inventing plausible data. Extra fields are tolerated. Replay/request metadata on send text/done should be included if consumed; if retained publicly, use endpoint-specific variants rather than widening every agent event. Optional metadata has to be validated when present.

One private common agent decoder handles the shared agent vocabulary; endpoint decoders compose it with route additions. Its actual state shape is the five fields emitted by the backend, so consumers that require full PersonState must merge updates into known state or change their callback contract to this partial update type. Do not assert a narrow update is full PersonState. Endpoint wrappers own path, payload, authentication policy, and decoder selection; callers do not pass a decoder or select event types with a generic assertion.

Keep frame splitting and EOF semantics unchanged in this unit. Existing `createSseParser.finish()` flushes an unterminated frame, so replacing the parser here would be a separate behavior decision. EOF continues resolving without requiring a done event. Callback failure releases the reader lock in the existing finally; transport cancellation may be a subsequent explicit decision, not a silent behavior change.

### Module map and interface depth

- `useWorldSceneCompatibility.tsx`: owns scoped attachment/intent/entry error presentation, still exports the same hook surface. Private helpers remain local; no parallel controller or second public entry method.
- `compatibility-session.ts`, `compatibility-store.ts`, `SceneCompatibilityPanel.tsx`: preserve conflict/unknown and durable recovery ownership.
- `api/types.ts`: accurate domain event unions and the actual agent state-update shape. Remove the misleading broad AgentStreamEvent usage or derive any retained aggregate from endpoint unions.
- `api/client.ts`: private unknown-payload transport plus endpoint methods selecting decoders. Remove exported unsafe SSEEvent and migrate every direct raw caller in the same unit.
- A private `api/stream-events.ts` implementation module is optional if decoders make client.ts unwieldy; prefer co-location initially to avoid another public import path. UI must import domain types and API methods only.
- `ChatStream.tsx`, `ScenePanel.tsx`, native2d adapter/sample: consume endpoint events and handle only relevant kinds. Native2d injectable stream port becomes scene-specific, preserving injection while removing the unsafe callback cast.

Two hook members hide identity, attachment, queue replay, retries and UI ownership. Endpoint methods hide transport parsing and validation; the exposed event union describes domain outcomes. This is a deeper interface than a generic transport plus consumer guards, per boundary-discipline and minimize-reader-load.

## Synthesis decision

Pending orchestrator comparison. This candidate is independent and has not incorporated another candidate.

## Tradeoffs accepted

- We accept additional private decoder code in exchange for checked endpoint contracts and no wire-object assertions at callers.
- We accept a small hook-owned entry error branch in exchange for preserving the established repair session state machine and recovery semantics.
- We accept ignoring unknown event kinds in exchange for forward compatibility; malformed known events still surface as stream failures.
- We accept retaining existing framing behavior in exchange for keeping this fix's observable transport change limited to callback error propagation and payload validation.

## Alternatives considered

- A compatibility coordinator object owning both attachment and continuation would hide more asynchronous logic, but it would add another lifecycle and subscription boundary beside the existing session for a single hook consumer. It also risks moving React identity cleanup policy out of its established owner.
- A generic `{ type: string; [key: string]: unknown }` public SSE event plus guards at each caller is smaller to implement but exposes transport validation policy to every UI, permits divergence between ScenePanel and native2d, and provides no endpoint contract.
- A single global discriminated event union hides no endpoint knowledge and incorrectly permits chat-only pending or fork results in scene handlers. Generic `postSSE<T>` without a decoder would merely move the assertion.

## Red-flag screen

- Shallow module: no new public controller; unchanged hook surface and meaningful endpoint methods.
- Information leakage: raw unknown payload remains behind client API; domain events reach UI.
- Temporal decomposition: no separate load/validate/save service chain; compatibility entry policy stays in its owner.
- Pass-through methods: catchup/scene endpoint methods add path and decoder policy; generic identity forwarding helpers are not added.
- Split ownership: session owns continuations; hook owns entry intent/error; no copied session machine.
- Two ways: remove exported raw SSE consumers in the same change, including native2d's cast.
- Importable internals: keep parser/decoder functions unexported in client.ts unless a build-enforced internal boundary exists; avoid exporting a convenience raw transport.
- Hand-synced lists: share agent decoding once and derive endpoint unions; add tests from real route payloads to detect backend/frontend contract drift. Full generated shared schemas are outside this fix.

## Implementation reconciliation

No implementation yet. If decoder scope expands into full backend schema sharing, return to synthesis instead of quietly widening this candidate.

## Open questions and risks

- Can existing callers consume AgentStateUpdate directly, or do any rely on full PersonState metadata that must be merged explicitly?
- Does any test injection depend on a generic native2d stream port even though its runtime use is scene-only? Inspect and migrate those fixtures together.
- Can a closed or superseded open finish after a later request starts? The intent sequence must be checked in both success and failure paths.
- Could rejected check operations have already preserved a non-error continuation such as submitting? Preserve that continuation and surface refusal without misclassifying it as an attachment retry.

These are implementation inspection questions, not user-approval gates. Verification should cover pre-attach failure with queued open, open after passive failure, successful retry, scope/token changes, close while pending, expected check rejection, unexpected callback exceptions, malformed/unknown events, actual endpoint payload variants, and native2d control-event filtering. Run tests only in the authorized GitHub Actions workflow; no local builds or GUI work.

## Next implementation step

Implement the hook-owned scoped entry state and one shared runOpen path, adding focused failure/retry/stale-completion coverage before adapting endpoint event contracts.
