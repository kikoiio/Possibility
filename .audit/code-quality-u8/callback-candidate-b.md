# ChatStream callback freshness: candidate B

## Caller and failure mode

`PersonDetail` renders `<ChatStream key={conversationId} conversationId={conversationId} withCatchup onStateChange={setState} />`. Its current `setState` prop is a stable React setter, so the stale-callback issue is latent for this caller. The `ChatStreamProps` contract also permits callbacks that close over changing parent props or state. The initial-load effect closes over the callback from its first render for that conversation; a long-running send closes over the callback from the render that initiated the send. Later `state` SSE events can therefore reach an obsolete callback. Adding `onStateChange` to the initial-load effect dependencies would restart catchup and history when a parent creates a new callback identity.

## Recommended shape

Keep stream lifetime scoped to `conversationId` and `withCatchup`. Store the latest *committed* callback in a ref and read it at dispatch time in both SSE handlers:

```tsx
import { useLayoutEffect } from 'react' // Add to the existing React import.

// Inside ChatStream, beside the existing refs:
const onStateChangeRef = useRef<ChatStreamProps['onStateChange']>(onStateChange)
useLayoutEffect(() => {
  onStateChangeRef.current = onStateChange
}, [onStateChange])

// At both existing `ev.type === 'state'` branches, inside their current guards:
onStateChangeRef.current?.(ev.state)
```

Only add the ref/layout effect and replace both `onStateChange?.(ev.state)` expressions. Keep `PersonDetail`'s caller and the load effect's `[conversationId, withCatchup]` dependency list unchanged. `useLayoutEffect` updates the ref after a render commits and before browser events can run; assigning it during render could expose a callback from an abandoned concurrent render. An omitted callback becomes `undefined` and subsequent events become no-ops. The ref is stable, so it does not expand the initial-load effect's dependency scope.

## Lifecycle boundary

The catchup handler already checks its effect-local `cancelled` flag before dispatch. That protects callback dispatch after a conversation change, tab unmount, or Strict Mode effect cleanup. The ref does not change the existing behavior where code after the awaited catchup clears streaming without checking cancellation.

The send handler has no equivalent cancellation/identity guard and its `finally` block can update local state after unmount or a conversation change. The caller's `key={conversationId}` creates a new instance for a new conversation, but an in-flight stream in the old instance can still deliver an event to the callback held by that old instance. Callback freshness cannot decide whether such an event is still valid. If that lifecycle behavior is in scope, add a separate request generation or abort guard around send-event dispatch and post-send state updates; do not overload the callback ref with cancellation semantics. Strict Mode's effect replay can still initiate duplicate catchup work if the transport cannot cancel it; this proposal does not alter that transport contract.

## Structurally distinct alternative

Move state-event delivery into React state: both SSE handlers call `setLatestState(ev.state)`, and a separate effect runs `onStateChange?.(latestState)` with `[latestState, onStateChange]`. This also keeps the load effect's dependencies narrow, but it changes event delivery from immediate to post-commit, may collapse multiple events in one render batch, and calls a newly supplied callback again with the last state even when no new SSE event arrived. It needs extra conversation identity/reset handling. The callback ref preserves the current one-callback-per-event semantics with the smaller change.

## First implementation step

Add the typed ref and layout effect in `ChatStream`, then replace the two state-event callback invocations. Leave `PersonDetail` and the initial-load effect dependency list as they are.
