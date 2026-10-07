# Phase 2 acceptance checkpoint — 2026-10-07

Branch at checkpoint: `main` (the current acceptance branch). This record covers Phase 2 changes only; no Phase 3 files were modified or copied.

## Passed

| Area | Result | Recheck/evidence path |
|---|---:|---|
| API full test suite | 876 passed, 1 skipped (125 files passed, 1 skipped) | `cd api && npx vitest run --pool=forks --maxWorkers=1 --no-file-parallelism`; implementation and broad journey coverage under `api/src/` |
| Web unit suite | 536 passed (64 files) | `cd web && npx vitest run --pool=forks --maxWorkers=1 --no-file-parallelism`; native2d adapter cases in `web/src/native2d/__tests__/session-adapter.test.ts` |
| Native2D desktop browser suite | 35/35 passed, one worker, Vite development server | `cd web && PLAYWRIGHT_NATIVE2D_API_TARGET=http://127.0.0.1:18789 npx playwright test --config playwright.native2d.config.ts --project=native2d-desktop --workers=1`; covers `web/native2d-e2e/{editing,lifecycle,sample,visual.sample}.spec.ts` and the local owner journey described below. This is not the production build check. |
| Owner account 2D journey | Passed within the 35-test run | Local isolated D1 + local API and browser; owner login, account world/timeline selection, real intervention/fork/compare API calls, layout move/save, reload/reselect and D1 layout restoration. SSE chat response was mocked. Temporary credentials, database, and one-off journey spec were removed after the run. |
| Native2D API / persistence | 22/22 targeted tests passed | `api/src/native2d/routes.test.ts`, repository/migration tests, `api/drizzle/0039_native2d_layout_persistence.sql`, `api/src/native2d/repository.ts`, `api/src/native2d/routes.ts` |
| Native2D session adapter | 2/2 targeted cases passed | `web/src/native2d/__tests__/session-adapter.test.ts` |
| API and Web build/typecheck | Passed | `cd api && npm run build`; `cd web && npm run build` |
| Patch whitespace | Passed | `git diff --check` |

## G0: production build + real API check

- **Build mode:** `cd web && npm run build` runs `tsc --noEmit && vite build`; this generated Vite's production bundle in `web/dist` (including the production chunk-size warning noted above).
- **Cloud production-preview run:** because the coordinator reported rising local memory pressure, release build/browser acceptance ran on GitHub Actions (public repository, `ubuntu-24.04` hosted runner), not locally. Latest run [37565225272](https://github.com/kikoiio/Possibility/actions/runs/37565225272) passed on code commit `da1536353826125e7d66051747c8c9a657273a62`. It built the Vite production bundle and served it with `vite preview`; Chromium covered desktop 1280×720 and a separate mobile context at 390×844.
- **API route:** the built app used same-origin `/api`; Playwright forwarded browser API requests to the actual local Cloudflare Worker runtime with a fresh, isolated local D1 database on the Actions runner. The latest run recorded 19 desktop Worker requests and 4 mobile-context Worker requests, with no failed Worker responses. This was real application Worker/D1 behavior and real API responses, but **not a remote deployed Cloudflare API or production database**. Covered login, world/timeline reads, intervention, fork, compare, layout save, reload/reselection, and reading the saved layout from a separate mobile browser context.
- **Mock boundary:** only the account chat `/scene` SSE response was mocked with deterministic text; no model provider was called. Every other browser `/api` request was forwarded to the Worker.
- **Outcome:** the production preview owner journey passed. It saved the moved gatehouse placement to the fork timeline, reloaded the desktop page, reselected the same world/timeline, and verified the D1 placement was unchanged (`layoutRestoredAfterReload: true`, layout version 1). A separate 390×844 touch-enabled browser context selected that fork and confirmed the same placement through real Worker/D1 reads (`layoutRestoredInMobileContext: true`).
- **Harness corrections:** the first cloud attempt exposed route teardown masking the page failure; the second showed that the test read the timeline selector before React finished selecting the fork. Both harness issues were fixed and committed before the passing third run. These were not recorded as product failures.
- **Cloud T15 engine journey:** in latest [run 37565225272](https://github.com/kikoiio/Possibility/actions/runs/37565225272), the actual Worker tick endpoint was driven against the disposable runner-local D1 world. The 30-second away window advanced `simNow` from `2026-10-07T03:07:47.993Z` to `2026-10-07T03:10:28.139Z`; during the pause window it remained `2026-10-07T03:10:28.139Z`; after resume it advanced to `2026-10-07T03:16:33.203Z`. All assertions passed: engine status/running world, away progress, manual pause reason, frozen sim time, retained facts/events, cleared pause reason, and post-resume progress. Journey HTTP statuses were successful. A test pinger called the real Worker tick endpoint every five seconds. This validates engine/API behavior with an isolated Worker; it **does not verify a deployed remote scheduler or remote database**. Detailed evidence is in the run log and Step Summary; the JSON file was runner-temporary.
- **Mobile touch suite:** the same cloud run passed all 4 tests in the `native2d-mobile` project with one Playwright worker. These interaction tests use the existing fixture API mocks; separately, the production-preview mobile browser context above reads the persisted layout from the real Worker/D1.

The owner browser journey exercised a real local owner account and local D1 persistence. Chat used an SSE mock to avoid depending on an external model provider. The test account was disposable and has been removed; no reusable password or token is stored in this repository.

## Failures and corrections

- An earlier API full-suite run had eight failures after the new layout route's authentication middleware also intercepted guest endpoints. The middleware was narrowed to `/worlds/:worldId/native2d/layout`; the final full run above passed with one existing skip.
- Early local owner-journey attempts exposed test-fixture setup issues (a seeded demo-baseline marker, then compare selection / active-timeline limits). The isolated fixture and journey setup were corrected; the final owner journey passed as part of the 35/35 desktop run. These setup failures were not left as unresolved product failures.
- Runs [37564782533](https://github.com/kikoiio/Possibility/actions/runs/37564782533) and [37565035809](https://github.com/kikoiio/Possibility/actions/runs/37565035809) completed the production build but failed in the new mobile-context acceptance harness: it initially expected account controls to be visible before opening the mobile facts drawer, then expected the responsive read-status label to be visible outside that drawer. The harness now follows the mobile drawer interaction and waits for the loaded state to mount; final run `37565225272` passed. These were test synchronization/visibility assumptions, not product/API failures.
- The Web production build passed with the existing large-chunk warning (>500 kB). It did not fail the build.

## Failed or unverified

- **Public demo live-read browser case: unverified.** The earlier live case could not complete against an available public demo and timed out; the local acceptance above does not substitute for that live environment check.
- **Remote deployment progression/pause/resume (T15/T22): unverified.** The journey script passed against isolated Worker/D1 in the cloud run above, including away progression, pause freeze, and post-resume progression. No deployed environment was contacted, so the remote scheduler/deployment and database remain unverified. No remote world was mutated.
- **Remote deployment progression/pause/resume and public demo live-read: unverified.** The cloud journey used a runner-local Worker and isolated D1; no remote deployment or live demo was contacted. Local/cloud isolated behavior does not satisfy the deployed scheduler/database acceptance requirement.
- **Archive behavior: unverified.** The desktop and mobile browser checks use an active fork timeline; archive-line persistence behavior has not been exercised.
- **SSE/model generation: not verified against a model provider.** The owner journey mocked the chat stream; API interaction and other account operations used the local service.

## Resource checkpoint

Before preview work, this session observed about 7.3 GiB MemAvailable, negligible later `vmstat` swap-in/out, and memory PSI avg10/full avg10 at 0. After the local preview run began, the coordinator reported the newer system state as about 5.3 GiB MemAvailable, rising swap use, and memory PSI avg10 about 0.33. Per that coordination, the local preview/API services were stopped and their local database/credentials removed. After explicit user authorization, production-build/browser work resumed only on the GitHub-hosted runner; no additional local build/browser test was started.

## Durable implementation evidence

- D1 persistence schema and migration: `api/src/db/schema.ts`, `api/drizzle/0039_native2d_layout_persistence.sql`, `api/drizzle/meta/0039_snapshot.json`, `api/drizzle/meta/_journal.json`.
- Owner API and persistence/CAS: `api/src/native2d/routes.ts`, `api/src/native2d/repository.ts`, `api/src/native2d/routes.test.ts`.
- Account layout repository and interaction wiring: `web/src/native2d/api-layout-repository.ts`, `web/src/native2d/session-adapter.ts`, `web/src/native2d/sample-page.tsx`, `web/src/native2d/world-source.ts`.
- Timeline comparison correction and regression coverage: `api/src/life/compare.ts` and related API journey tests.
- Deployment journey checks: `scripts/verify-deployment-journey.ts` (implementation updated; deployed run remains unverified).
- Itemized Phase 2 checklist: `docs/spec_docs/phase2-world-loop/checklist.md`.

The passing release-preview, isolated engine, and mobile touch evidence are reproducible from workflow `.github/workflows/phase2-production-acceptance.yml`, browser script `web/scripts/phase2-release-preview.acceptance.ts`, and engine journey `scripts/verify-deployment-journey.ts`. Latest passing run `37565225272` tested code commit `da1536353826125e7d66051747c8c9a657273a62`; the remote deployment check remains outstanding. The final evidence commit is listed in the acceptance handoff.
