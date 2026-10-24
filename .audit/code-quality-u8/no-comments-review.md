# U8 No-Comments Review

Independent reviewer: `/root/u8_comment_review` (review-only; model not recorded).

## Finding

`web/src/components/ChatStream.tsx` suppressed `react-hooks/exhaustive-deps` on the initial-load effect. That effect captured `onStateChange`, so a callback replacement could leave catchup events calling a stale closure. The current `PersonDetail` caller uses a stable setter, but the component contract permits changing callbacks.

## Accepted fix

Synchronize a component-local callback ref in `useLayoutEffect`, read it from both catchup and send state-event handlers, and remove the suppression while keeping the load effect scoped to `conversationId` and `withCatchup`.

## Other reviewed comments

The exported `AgentStreamEvent` contract comment is useful and stays. The changed tests add no narration comments. The transport comments removed by U8 were obsolete after the endpoint wrappers replaced the raw public stream API.

No other actionable comment findings were reported. A final diff review and the full cloud gate remain pending.

## Final diff review

Reviewer model: `gpt-5.6-sol`.

The final U8 review found one redundant JSDoc above `AgentStreamEvent`; it has been removed. The reviewer found no `eslint-disable`, `@ts-ignore`, or `@ts-expect-error` directives in scope and no `MUST KILL` findings. The final U8 diff deletes eight comment or suppression units totaling eleven physical lines, restores none, and adds none. The StrictMode lifecycle note in `sample-page.tsx` remains because it records a framework constraint the code does not show.
