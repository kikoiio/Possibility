# U8 Grounding

## Compatibility entry flow

`useWorldSceneCompatibility` owns the React scope for a compatibility session. Its attachment effect resolves the account or guest identity, reads the current scene, creates the session, subscribes to continuation updates, and replays one queued open. Identity epoch and active-effect checks prevent stale asynchronous work from attaching after a scope change.

`open()` first closes scene history, then reads the current scene version before calling `CompatibilitySession.check()`. `check()` publishes `checking` and, on an inspection failure, publishes `conflict` or `unknown` before rejecting. The hook subscription turns those states into `SceneCompatibilityPanel` UI. The normal `open()` catch also swallows failures from the earlier scene read, which never reach the session. The attachment catch clears readiness and continuation; a queued open then has no visible error or retry path. The panel is rendered only for a non-idle continuation.

Design constraints:

- Keep failures scoped by world, timeline, and auth identity epoch.
- Do not publish errors from an attachment or open that has become stale.
- Preserve the session's existing conflict and unknown continuation behavior.
- Give pre-session and current-scene-read failures visible, retryable UI rather than mapping them to submission recovery.
- A rejected `check()` is expected after its state has been published; unexpected rejection paths still need an explicit outcome.

Relevant files: `web/src/scene/useWorldSceneCompatibility.tsx`, `web/src/scene/compatibility-session.ts`, `web/src/scene/compatibility-store.ts`, `web/src/components/scene/SceneCompatibilityPanel.tsx`.

## POST SSE flow

`postSSE()` owns request credentials, fetch, stream reading, frame splitting, JSON parsing, and callback dispatch. It currently declares `{ type: string; [key: string]: any }`, with a suppression that removes useful checking. JSON parsing and callback dispatch share one catch, so a callback exception is swallowed as if the frame were malformed.

The event sets differ by endpoint. Chat and catchup emit Agent events plus route-level `pending`, `error`, and `skipped` values. Person timeline fork has `timeline` and a `fork` result attached to `done`. Scene chat has `scene_start`, `utterance`, `error`, and `done`. Existing `AgentStreamEvent` does not describe all those route variants; `SceneEvent` covers the scene set. `ScenePanel` casts its stream value to `SceneEvent`. `AccountSessionAdapter` lowers it to `Record<string, unknown>`, while the current native2d sample consumer does not switch on `type` and may append control events to the dialogue text.

Design constraints:

- Keep the shared transport independent of any one endpoint's event vocabulary.
- Parsed payload fields must be `unknown` until a consumer narrows them.
- Preserve forward compatibility for event types a consumer does not use.
- Keep endpoint-specific unions accurate where they provide a real contract.
- Catch malformed JSON separately from callback execution so consumer failures are not hidden.
- Do not change the transport's stream-close behavior without a contract decision; current consumers use request-status APIs for durable completion.

Relevant files: `web/src/api/client.ts`, `web/src/api/types.ts`, `web/src/components/ChatStream.tsx`, `web/src/components/world/ScenePanel.tsx`, `web/src/native2d/session-adapter.ts`, `web/src/native2d/sample-page.tsx`, `web/src/lib/sseParser.ts`.
