# U8 Cross-Judge

Scores use 1–5, where 5 meets the criterion with concrete invariants and 1 leaves a material gap.

| Criterion | Candidate A | Candidate B |
|---|---:|---:|
| 1. Entry failures are visible/retryable and distinct from session recovery | **5** — `Shape / Compatibility data and ownership` distinguishes pre-read failures from published `conflict`/`unknown`, preserves submitting/unknown behavior, and guards queued/direct opens. | **4** — `Shape` separates launch state from continuation and retains/retries the request, but retries after unexpected `check` rejection depend on session restart rules that remain less resolved. |
| 2. Identity, scope, cleanup, stale responses, and single ownership | **5** — `Shape / Compatibility data and ownership` names identity epoch, token, generation, request sequence, scope switches, dismissal, and per-owner state. | **4** — `Shape` specifies scope, credential, generation, invalidation, and close behavior; the launch panel is a separate presentation module, while some identity/credential retry details remain open. |
| 3. Typed endpoint contracts, no `any`, endpoint neutrality, runtime narrowing | **5** — `Shape / Stream data and boundaries` makes parsed payloads `unknown`, defines chat/catchup/fork/scene contracts, narrows known payloads, ignores unknown kinds, and keeps transport neutral. | **3** — `Shape` provides unknown transport and chat/scene decoders, but `ChatEvent` is shared for send and catchup, fork variants are not specified, and malformed-known versus unknown events remain unresolved in `Open questions and risks`. |
| 4. Short call paths, hidden complexity, no duplicate stream APIs | **4** — `Shape / Module map and interface depth` preserves `{ open, panel }` and endpoint wrappers, with useful private decoders; the hook's generation/attachment/intent policy is intricate and deserves focused helpers. | **4** — `Shape` keeps existing caller methods and private decoders; the added launch-panel module is presentation-only, though it adds a module for a small surface. |
| 5. Behavior preservation, forward compatibility, scope, focused cloud verification | **5** — `Shape / Stream data and boundaries` preserves framing and EOF behavior; `Next implementation step` and stream risks enumerate focused coverage and cloud-only verification. | **3** — `Shape` preserves EOF/request-status behavior and ignores unknown events, but leaves malformed-event policy, endpoint variants, and focused verification less concrete. |

## Recommendation

Use Candidate A as the stronger base shape. Its explicit endpoint-specific event unions and error classification address the rubric's highest-risk contract boundaries more completely. Candidate B's separate launch-panel component is a reasonable optional presentation extraction, but it is not necessary to the state ownership design and should not become a second owner of retry behavior.

## Material Risks

- Candidate A's compatibility guard has several dimensions (scope, identity token/epoch, attachment generation, request sequence). Keep the checks centralized so success and failure paths cannot drift; its own `Open questions and risks` correctly flags close/supersede races.
- Candidate A's API event unions must be reconciled against every emitted route variant, including replay metadata and fork completion; its decoder tests should use representative route payloads. Its `AgentStateUpdate` must not be passed to consumers as a complete `PersonState`.
- Candidate B's shared `ChatEvent` for catchup can promise variants the catchup route does not emit, while omitting fork-specific contract details. Its proposed `null` result for both malformed and unknown events loses the distinction needed to fail malformed known payloads predictably.
- Both candidates should preserve existing reader cleanup and callback rejection semantics; Candidate A spells this out more directly under `Stream data and boundaries`.
