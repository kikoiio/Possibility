# Candidate A: commit-synchronized callback reference

This is a design sketch only. No application code is changed and no builds or tests are run.

## Existing contract and finding

`ChatStreamProps.onStateChange?: (state: PersonState) => void` is an optional notification callback. Both the catchup SSE handler created by the initial-load effect and the send SSE handler created inside `send()` close over the callback from the render that created them. A later committed render can supply another callback while either stream is still active.

`PersonDetail` currently supplies React's stable `setState` setter and keys `ChatStream` by `conversationId`. Therefore the current caller does not itself demonstrate identity churn; this is a component-contract issue for changing callbacks, including future wrappers that capture changing page values.

The initial-load effect must continue to be triggered only by `conversationId` and `withCatchup`. Adding the callback as a dependency would repeat catchup/history and reset local state on callback changes.

## Concrete shape

Keep the public signature unchanged. Add `useLayoutEffect` to the React import and keep one component-local ref:

```tsx
interface ChatStreamProps {
  conversationId: string
  withCatchup?: boolean
  onStateChange?: (state: PersonState) => void
}

const onStateChangeRef = useRef<ChatStreamProps['onStateChange']>(onStateChange)

useLayoutEffect(() => {
  onStateChangeRef.current = onStateChange
}, [onStateChange])
```

Read the ref at the moment each event arrives. Do not copy its current value into the stream's enclosing closure:

```tsx
// Existing initial-load effect; retain every other branch and cleanup.
useEffect(() => {
  let cancelled = false
  // Existing resets and load() orchestration ...
  // Inside chatApi.catchup(conversationId, (ev) => { ... }):
  // if (cancelled) return
  // ...
  // else if (ev.type === 'state') {
  //   onStateChangeRef.current?.(ev.state)
  // }
  // Existing load().catch(...) ...
  return () => { cancelled = true }
}, [conversationId, withCatchup])

// Inside the existing chatApi.send callback:
if (ev.type === 'state') {
  onStateChangeRef.current?.(ev.state)
}
```

The initial effect sketch elides its body for readability; the implementation consists of the new ref/layout effect and replacing exactly the two callback invocations. The existing dependency suppression is not repaired by adding changing dependencies. The ref identity is stable and reading `.current` does not subscribe the initial effect to callback changes.

No generic hook or new callback adapter is necessary for these two adjacent uses. Keeping direct reads also makes the freshness requirement explicit at both call sites.

Caller usage remains:

```tsx
<ChatStream
  key={conversationId}
  conversationId={conversationId}
  withCatchup
  onStateChange={setState}
/>
```

A caller may also pass an inline function that captures changing values. Once that render commits, subsequent state events use that function without restarting catchup or an existing send.

## Lifecycle and guarantee

“Current” means the callback from the latest committed render of this mounted component, not a callback from a speculative render that React may abandon. The ref starts with the initial callback. The layout effect publishes replacements synchronously during commit, before paint and before asynchronous stream delivery can resume. The passive initial-load effect then starts its work normally.

On a callback-only update, the layout effect writes the new callback (including `undefined`); the initial effect does not clean up or rerun. Existing catchup and send handlers dereference the same ref on each state event. A passive `useEffect` for this synchronization would leave a post-commit interval where an event could see the previous callback. Writing the ref during render would expose callbacks from uncommitted renders. Neither variant supplies the same timing guarantee.

On a conversation/catchup change, the initial effect's existing cleanup sets its private `cancelled` flag and the replacement effect starts normally. The old catchup callback still returns at its existing cancellation check before reading the ref. On unmount, the same cancellation behavior applies. The ref synchronization adds no abort, no network work, and no lifecycle cleanup that would otherwise alter send behavior.

## Failure and race boundaries

- Callback replacement during an active send takes effect on the next state event. Request IDs, optimistic user messages, streaming text, request-status checks, pending recovery, final history reloads, and `finally` handling keep their existing behavior.
- Removing the optional callback makes subsequent state events no-ops. Adding it during a stream enables subsequent notifications; previously delivered events are not replayed.
- A callback exception propagates through the same SSE/load/send error paths as before. This proposal introduces no swallowing, retry, or additional invocation.
- Strict Mode may replay the initial effect in development as before. Synchronizing a ref is idempotent and creates no additional stream work; this is not a Strict Mode deduplication fix.
- Existing send handlers have no cancellation gate. A send that outlives unmount can still invoke the callback retained by that old component instance, and its remaining state updates/status work remain as before. Adding mounted/epoch guards would be a separate behavior change. The guarantee is freshness for the live instance, not a new guarantee against all post-unmount events.
- `PersonDetail`'s key causes a new instance on conversation changes. If a different consumer reuses the same instance with a new conversation, an old send can notify the newest callback; that association race already lacks a send lifecycle policy. Resolving it requires explicit cancellation or request/conversation ownership semantics beyond this callback freshness patch.
- Cancellation is still effected by the existing passive-effect cleanup, not atomically by the prop commit. The small interval before cleanup and existing mutations after awaited catchup (before its later cancellation check) are pre-existing lifecycle boundaries; this proposal does not claim to repair them.

## Structurally distinct alternative: Effect Events

React 19.2 is declared in `web/package.json`, so `useEffectEvent((state: PersonState) => onStateChange?.(state))` could supply fresh reads for catchup notifications created by the initial effect without making the callback reactive. However, the other notification path originates in the user-triggered `send()` handler. Effect Events are intended for effect-owned logic and must not become a general callback invoked from user event handling.

Reject Effect Events as the unified solution here: applying them only to catchup would require a second freshness mechanism for active sends, while applying the same Effect Event to both paths would violate its calling contract. A commit-synchronized ref handles both existing paths with one mechanism and no API change.

## Review scenarios (not executed)

The design should be evaluated with callback A replaced by B during catchup and during an already-started send; both must notify B for later state events, with exactly the same initial catchup/history work count. Also consider B replaced by `undefined`, an abandoned render carrying callback C, and cancellation of an old catchup before a late state event. These scenarios distinguish freshness from accidental reloads and from speculative-render publication.
