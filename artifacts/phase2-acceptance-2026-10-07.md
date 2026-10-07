# Phase 2 acceptance checkpoint — 2026-10-07

Branch at checkpoint: `main` (the current acceptance branch). This record covers Phase 2 changes only; no Phase 3 files were modified or copied.

## Latest validation refresh — 2026-10-07

The prior checkpoint below documents an earlier commit and remains useful as historical evidence. Current-main and deployed-test evidence is refreshed here; each result is limited to the environment and paths actually exercised.

| Run | Commit / result | Evidence and boundary |
|---|---|---|
| [Phase 2 production acceptance `37626544402`](https://github.com/kikoiio/Possibility/actions/runs/37626544402) | `c975c9a9024dd7cd9933847c0ff690135fb86e1e` / success | Current-main Vite production build + preview, targeted environment/controller tests, production-preview journey against runner-local Cloudflare Worker and isolated D1, environment facts/rules/rendering/direct evidence, leave/pause/resume, and mobile touch suite. Mobile touch uses fixture API; it is separate from the Worker-backed journey. The owner is a disposable test account/world in runner D1, not a production account. Chat SSE is mocked. Public demo read-only step was skipped because `PHASE2_PUBLIC_DEMO_API_URL` is not configured. |
| [Phase 3 presentation browser acceptance `37625990902`](https://github.com/kikoiio/Possibility/actions/runs/37625990902) | `c975c9a9024dd7cd9933847c0ff690135fb86e1e` / success | Current-main desktop presentation and touch browser journeys pass with isolated fixture APIs. This adds current presentation UI evidence; it does not prove production-bundle behavior against a real Worker/D1 or production account. |
| [Phase 2 temporary Cloudflare acceptance `37582832140`](https://github.com/kikoiio/Possibility/actions/runs/37582832140) | `252f1a39245c293ce3ce276e68096e33dd643982` / success | Created and migrated a run-scoped D1, deployed a run-scoped Worker, passed leave/pause/resume through that deployed Worker and D1, archived the temporary world and checked read-only behavior, then deleted resources and verified exact-name matches were zero. Tick requests came from a runner-side pinger every five seconds. This proves deployed endpoint/D1 behavior for that run, **not Cloudflare Scheduler/Cron firing**. The commit is an ancestor of current main; later current-main browser work is covered separately above. |

These runs do not establish a complete Phase 2 exit. The combined 2D/3D/API/SSE projection, the full evidence-to-fork-to-environment-to-compare-to-leave-and-return journey, actual Scheduler/Cron execution, and public demo live-read remain unverified. The current Phase 2 run used a runner-created test owner and mocked chat SSE; no actual production account or model provider was used.

## Passed

| Area | Result | Recheck/evidence path |
|---|---:|---|
| API full test suite | 876 passed, 1 skipped (125 files passed, 1 skipped), on the earlier checkpoint commit | `cd api && npx vitest run --pool=forks --maxWorkers=1 --no-file-parallelism`; this historical full-suite result is not a current-HEAD full-suite run. |
| Web unit suite | 536 passed (64 files), on the earlier checkpoint commit | `cd web && npx vitest run --pool=forks --maxWorkers=1 --no-file-parallelism`; this historical full-suite result is not a current-HEAD full-suite run. |
| Native2D desktop browser suite | 35/35 passed, one worker, Vite development server | `cd web && PLAYWRIGHT_NATIVE2D_API_TARGET=http://127.0.0.1:18789 npx playwright test --config playwright.native2d.config.ts --project=native2d-desktop --workers=1`; covers `web/native2d-e2e/{editing,lifecycle,sample,visual.sample}.spec.ts` and the local owner journey described below. This is not the production build check. |
| Owner account 2D journey | Passed within the 35-test run | Local isolated D1 + local API and browser; owner login, account world/timeline selection, real intervention/fork/compare API calls, layout move/save, reload/reselect and D1 layout restoration. SSE chat response was mocked. Temporary credentials, database, and one-off journey spec were removed after the run. |
| Native2D API / persistence | 22/22 targeted tests passed | `api/src/native2d/routes.test.ts`, repository/migration tests, `api/drizzle/0039_native2d_layout_persistence.sql`, `api/src/native2d/repository.ts`, `api/src/native2d/routes.ts` |
| Native2D session adapter | 2/2 targeted cases passed | `web/src/native2d/__tests__/session-adapter.test.ts` |
| API and Web build/typecheck | Passed | `cd api && npm run build`; `cd web && npm run build` |
| Patch whitespace | Passed | `git diff --check` |

## G0: production build + real API check

Current-main G0 refresh is run [`37626544402`](https://github.com/kikoiio/Possibility/actions/runs/37626544402), which passed on `c975c9a9024dd7cd9933847c0ff690135fb86e1e`. It supersedes the earlier run reference below for production build and isolated real-Worker API behavior. “Real API” here means the actual application Cloudflare Worker runtime with runner-local isolated D1, not a public production deployment or existing production account. See the refresh table above for scope and skipped live-demo check.

- **Build mode:** `cd web && npm run build` runs `tsc --noEmit && vite build`; this generated Vite's production bundle in `web/dist` (including the production chunk-size warning noted above).
- **Earlier cloud production-preview run:** because the coordinator reported rising local memory pressure, release build/browser acceptance ran on GitHub Actions (public repository, `ubuntu-24.04` hosted runner), not locally. Run [37565225272](https://github.com/kikoiio/Possibility/actions/runs/37565225272) passed on code commit `da1536353826125e7d66051747c8c9a657273a62`. It built the Vite production bundle and served it with `vite preview`; Chromium covered desktop 1280×720 and a separate mobile context at 390×844. Current-main recheck is `37626544402` above.
- **Earlier API route evidence from run `37565225272`:** the built app used same-origin `/api`; Playwright forwarded browser API requests to the actual local Cloudflare Worker runtime with a fresh, isolated local D1 database on the Actions runner. That run recorded 19 desktop Worker requests and 4 mobile-context Worker requests, with no failed Worker responses. This was real application Worker/D1 behavior and real API responses, but **not a remote deployed Cloudflare API or production database**. Covered login, world/timeline reads, intervention, fork, compare, layout save, reload/reselection, and reading the saved layout from a separate mobile browser context.
- **Earlier mock boundary in run `37565225272`:** only the account chat `/scene` SSE response was mocked with deterministic text; no model provider was called. Every other browser `/api` request was forwarded to the Worker. The current-main owner journeys also mock SSE, as noted above.
- **Earlier outcome in run `37565225272`:** the production preview owner journey passed. It saved the moved gatehouse placement to the fork timeline, reloaded the desktop page, reselected the same world/timeline, and verified the D1 placement was unchanged (`layoutRestoredAfterReload: true`, layout version 1). A separate 390×844 touch-enabled browser context selected that fork and confirmed the same placement through real Worker/D1 reads (`layoutRestoredInMobileContext: true`).
- **Harness corrections in run `37565225272`:** the first cloud attempt exposed route teardown masking the page failure; the second showed that the test read the timeline selector before React finished selecting the fork. Both harness issues were fixed and committed before the passing third run. These were not recorded as product failures.
- **Current-main T15 isolated engine journey:** run `37626544402` passed the leave/pause/resume check against runner-local Worker/D1; the test pinger explicitly calls `/api/engine/tick`. This is not a Scheduler/Cron test.
- **Temporary deployed T15 journey:** run [37582832140](https://github.com/kikoiio/Possibility/actions/runs/37582832140) passed leave/pause/resume against a run-scoped deployed Worker and Cloudflare D1. Its runner-side pinger also explicitly called `/api/engine/tick`; actual Cloudflare Scheduler/Cron execution was not exercised. The same run passed archive/read-only checks and verified that its temporary Worker and D1 were absent after cleanup.
- **Mobile touch suite:** run `37565225272` passed all 4 tests in the `native2d-mobile` project with one Playwright worker. These interaction tests use fixture API mocks; separately, its production-preview mobile browser context read persisted layout from the runner Worker/D1. Current-main run `37626544402` also passed its mobile touch step, with the fixture boundary unchanged.

The owner browser journeys exercised disposable test owner accounts and runner-local D1 persistence, not a real production account. Chat used an SSE mock to avoid depending on an external model provider. Test accounts were disposable; no reusable password or token is stored in this repository.

## Failures and corrections

- An earlier API full-suite run had eight failures after the new layout route's authentication middleware also intercepted guest endpoints. The middleware was narrowed to `/worlds/:worldId/native2d/layout`; the final full run above passed with one existing skip.
- Early local owner-journey attempts exposed test-fixture setup issues (a seeded demo-baseline marker, then compare selection / active-timeline limits). The isolated fixture and journey setup were corrected; the final owner journey passed as part of the 35/35 desktop run. These setup failures were not left as unresolved product failures.
- Runs [37564782533](https://github.com/kikoiio/Possibility/actions/runs/37564782533) and [37565035809](https://github.com/kikoiio/Possibility/actions/runs/37565035809) completed the production build but failed in the new mobile-context acceptance harness: it initially expected account controls to be visible before opening the mobile facts drawer, then expected the responsive read-status label to be visible outside that drawer. The harness now follows the mobile drawer interaction and waits for the loaded state to mount; final run `37565225272` passed. These were test synchronization/visibility assumptions, not product/API failures.
- In earlier run [37563089405](https://github.com/kikoiio/Possibility/actions/runs/37563089405), a disposable owner password was emitted in the public job log before masking was added. That account existed only in the runner's isolated D1, which the workflow deleted at job end; the password is no longer valid. The harness now masks the password before exporting it to later steps; the final run logs show it redacted. No real account credential was used.
- The Web production build passed with the existing large-chunk warning (>500 kB). It did not fail the build.

## Failed or unverified

- **Cloudflare Scheduler/Cron: unverified.** Runs `37626544402` and `37582832140` prove the tick API and leave/pause/resume logic with runner-side pingers; neither proves an actual scheduled event invoked the Worker.
- **Public demo live-read browser case: unverified.** In current-main run `37626544402`, the read-only live step was skipped because `PHASE2_PUBLIC_DEMO_API_URL` was not configured. Runner-local or temporary Worker/D1 evidence does not substitute for a public demo check.
- **Complete 2D/3D projection and end-to-end journey: unverified.** The environment-continuity journey verifies the native2d Pixi renderer, environment facts/rules, direct evidence, and blocked/reopened path. The current-main presentation run `37625990902` uses fixture APIs. No run here verifies that 2D, 3D, API, and SSE all consume the same projection through one complete journey.
- **Existing production account: not tested.** Production-preview journeys used a disposable owner/test world seeded in runner-local isolated D1. They do not establish behavior for an actual user account or production database.
- **SSE/model generation: not verified against a model provider.** The owner journey mocked the chat stream; no model provider was called.

## Resource checkpoint

Before preview work, this session observed about 7.3 GiB MemAvailable, negligible later `vmstat` swap-in/out, and memory PSI avg10/full avg10 at 0. After the local preview run began, the coordinator reported the newer system state as about 5.3 GiB MemAvailable, rising swap use, and memory PSI avg10 about 0.33. Per that coordination, the local preview/API services were stopped and their local database/credentials removed. After explicit user authorization, production-build/browser work resumed only on the GitHub-hosted runner; no additional local build/browser test was started.

## Durable implementation evidence

- D1 persistence schema and migration: `api/src/db/schema.ts`, `api/drizzle/0039_native2d_layout_persistence.sql`, `api/drizzle/meta/0039_snapshot.json`, `api/drizzle/meta/_journal.json`.
- Owner API and persistence/CAS: `api/src/native2d/routes.ts`, `api/src/native2d/repository.ts`, `api/src/native2d/routes.test.ts`.
- Account layout repository and interaction wiring: `web/src/native2d/api-layout-repository.ts`, `web/src/native2d/session-adapter.ts`, `web/src/native2d/sample-page.tsx`, `web/src/native2d/world-source.ts`.
- Timeline comparison correction and regression coverage: `api/src/life/compare.ts` and related API journey tests.
- Deployment journey checks: `scripts/verify-deployment-journey.ts` (runner-local and temporary deployed Worker/D1 journeys have passed; actual Scheduler/Cron remains unverified).
- Itemized Phase 2 checklist: `docs/spec_docs/phase2-world-loop/checklist.md`.

The current-main release-preview, isolated engine, and mobile touch evidence are reproducible from workflow `.github/workflows/phase2-production-acceptance.yml`, browser scripts `web/scripts/phase2-release-preview.acceptance.ts` and `web/scripts/phase2-environment-continuity.acceptance.ts`, and `scripts/verify-deployment-journey.ts`. Run `37626544402` is the current-main G0 check. Temporary deployed Worker/D1 and archive evidence is in run `37582832140`. Actual Scheduler/Cron and public demo live-read remain outstanding. The current-main Phase 3 presentation fixture journey is run `37625990902` and should be read as separate UI evidence.
