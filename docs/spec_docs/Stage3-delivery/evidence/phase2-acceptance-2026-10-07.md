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
- **Preview mode:** `cd web && npm run preview -- --host 127.0.0.1 --port 15175` served that production output. The 35/35 desktop suite above used Vite's development server; it is recorded separately.
- **API route:** the built app uses same-origin `/api` paths. For this local preview check, Playwright forwarded those browser requests to an isolated local Cloudflare Worker/D1 on port 18891. API responses were real Worker responses, not fixtures. The Worker log showed successful auth/world list and snapshot reads, native2d layout GET/PUT, intervention, fork, and compare calls. The test account/database were disposable and have been removed.
- **Mock boundary:** only the account chat `/scene` SSE stream was intercepted with a deterministic response. No model provider was called. All other observed account API operations used the local Worker.
- **Outcome/limit:** production preview rendered the account world from the Worker; layout GET and PUT returned HTTP 200, and a later layout GET also returned 200. Compare was confirmed by the UI message `比较结果已读取；结果描述观察到的差异，不代表因果结论。` An early harness assertion expected different wording and timed out; this was an assertion mismatch. The later production-preview drag attempt did not reach a valid-move state, so equality of the saved placement after refresh/reselection was **not verified in production preview**. The separate development-server owner journey did verify save and refresh restoration. No additional browser/build verification was started after the coordinator reported rising resource pressure.

The owner browser journey exercised a real local owner account and local D1 persistence. Chat used an SSE mock to avoid depending on an external model provider. The test account was disposable and has been removed; no reusable password or token is stored in this repository.

## Failures and corrections

- An earlier API full-suite run had eight failures after the new layout route's authentication middleware also intercepted guest endpoints. The middleware was narrowed to `/worlds/:worldId/native2d/layout`; the final full run above passed with one existing skip.
- Early local owner-journey attempts exposed test-fixture setup issues (a seeded demo-baseline marker, then compare selection / active-timeline limits). The isolated fixture and journey setup were corrected; the final owner journey passed as part of the 35/35 desktop run. These setup failures were not left as unresolved product failures.
- The Web production build passed with the existing large-chunk warning (>500 kB). It did not fail the build.

## Failed or unverified

- **Remote deployment progression/pause/resume (T15/T22): unverified.** `scripts/verify-deployment-journey.ts` now checks that a dedicated running world advances while away, freezes while paused, then resumes. It was not run against a deployed world because this session had no deployment URL or credentials. No remote world was mutated.
- **Public demo live-read browser case: unverified.** The earlier live case could not complete against an available public demo and timed out; the local acceptance above does not substitute for that live environment check.
- **Touch-device interaction, cross-device layout restoration, and archive behavior: unverified.** Desktop browser refresh/reselection restoration passed, but these separate environments/flows were not exercised.
- **SSE/model generation: not verified against a model provider.** The owner journey mocked the chat stream; API interaction and other account operations used the local service.
- **Production-preview layout round-trip: partially verified.** The release bundle loaded and the real local API returned 200 for layout GET/PUT, but the preview browser drag did not produce an applicable move and saved-placement equality after refresh was not checked. Do not substitute the 35/35 development-server run for this missing check.

## Resource checkpoint

Before preview work, this session observed about 7.3 GiB MemAvailable, negligible later `vmstat` swap-in/out, and memory PSI avg10/full avg10 at 0. After the preview run began, the coordinator reported the newer system state as about 5.3 GiB MemAvailable, rising swap use, and memory PSI avg10 about 0.33. Per that coordination, the active preview/API services were stopped, their local database and credentials were removed, and no further build/browser tests were started.

## Durable implementation evidence

- D1 persistence schema and migration: `api/src/db/schema.ts`, `api/drizzle/0039_native2d_layout_persistence.sql`, `api/drizzle/meta/0039_snapshot.json`, `api/drizzle/meta/_journal.json`.
- Owner API and persistence/CAS: `api/src/native2d/routes.ts`, `api/src/native2d/repository.ts`, `api/src/native2d/routes.test.ts`.
- Account layout repository and interaction wiring: `web/src/native2d/api-layout-repository.ts`, `web/src/native2d/session-adapter.ts`, `web/src/native2d/sample-page.tsx`, `web/src/native2d/world-source.ts`.
- Timeline comparison correction and regression coverage: `api/src/life/compare.ts` and related API journey tests.
- Deployment journey checks: `scripts/verify-deployment-journey.ts` (implementation updated; deployed run remains unverified).
- Itemized Phase 2 checklist: `docs/spec_docs/phase2-world-loop/checklist.md`.

The exact final code and this checkpoint are reviewable in the commit that adds this file on the current branch.
