# Phase 2 acceptance checkpoint — 2026-10-07

## 2026-10-08 closeout

Phase 2 production-preview owner journey and leave/pause/resume remain passed by [37640643443](https://github.com/kikoiio/Possibility/actions/runs/37640643443). The user accepts real-account and public-evaluation requirements as passed; the live demo URL was not configured, so no live public read is claimed. The cross-phase guest, timeline geometry, and archive lifecycle regression subsequently passed 20/20 in [37649736957](https://github.com/kikoiio/Possibility/actions/runs/37649736957). Full API/Web/voxel technical regression passed in [37649736855](https://github.com/kikoiio/Possibility/actions/runs/37649736855). No provider call was made.

## Latest cloud recheck

[GitHub Actions 37640643443](https://github.com/kikoiio/Possibility/actions/runs/37640643443) completed successfully on `main` commit `8fa8ffcafa652b4f022871419ac452804eaa920e`. It built the production Web bundle and verified the owner persistence journey against an isolated Worker/D1, finite environment projection/controller refresh, the continuous facts/rules/rendering/evidence journey, leave/advance/pause/resume, and mobile touch **4/4**. Temporary services and isolated D1 storage were cleaned up by the workflow.

The live public-demo step was skipped because no URL was configured. The user explicitly accepts checks requiring real production accounts or public evaluation; this item is recorded as **passed by user acceptance**, not as an executed live-demo check. Real account/cross-device acceptance follows the same decision. The isolated engineering checks above were actually executed.

This supersedes the old missing pause/resume and mobile-touch results below. The runtime is hosted-runner local Worker/D1 with `vite preview`; it does not claim a new remote production deployment, physical touch hardware, or real-provider SSE evaluation. Latest complete technical regression [37643316225](https://github.com/kikoiio/Possibility/actions/runs/37643316225) also passed API/Web types, the production Web build, full non-live-provider API/Web tests and voxel contract tests.

## Historical checkpoint

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
- **Cloud production-preview run:** because the coordinator reported rising local memory pressure, the release build/browser pass was moved to GitHub Actions (public repository, `ubuntu-24.04` hosted runner). The run [37560275395](https://github.com/kikoiio/Possibility/actions/runs/37560275395) passed on code commit `b68e79b9762a0e071515e5549305ee64480bcae9`. It built the production bundle and served it with `vite preview`; the browser was Chromium desktop 1280×720.
- **API route:** the built app used same-origin `/api`; Playwright forwarded browser API requests to the actual local Cloudflare Worker runtime with a fresh, isolated local D1 database on the Actions runner. This was real application Worker/D1 behavior and real API responses, but **not a remote deployed Cloudflare API or production database**. The run recorded 19 Worker requests and zero HTTP failures across login, world/timeline read, intervention, fork, compare, layout save, and layout restoration.
- **Mock boundary:** only the account chat `/scene` SSE response was mocked with deterministic text; no model provider was called. Every other browser `/api` request was forwarded to the Worker.
- **Outcome:** the production preview owner journey passed. It saved the moved gatehouse placement to the fork timeline, reloaded the browser page, reselected the same world/timeline, and verified the D1 placement was unchanged (`layoutRestoredAfterReload: true`, layout version 1). This covers browser reload/return and persisted layout, but does not cover a deployed world advancing while the user is away.
- **Harness corrections:** the first cloud attempt exposed route teardown masking the page failure; the second showed that the test read the timeline selector before React finished selecting the fork. Both harness issues were fixed and committed before the passing third run. These were not recorded as product failures.

The owner browser journey exercised a real local owner account and local D1 persistence. Chat used an SSE mock to avoid depending on an external model provider. The test account was disposable and has been removed; no reusable password or token is stored in this repository.

## Failures and corrections

- An earlier API full-suite run had eight failures after the new layout route's authentication middleware also intercepted guest endpoints. The middleware was narrowed to `/worlds/:worldId/native2d/layout`; the final full run above passed with one existing skip.
- Early local owner-journey attempts exposed test-fixture setup issues (a seeded demo-baseline marker, then compare selection / active-timeline limits). The isolated fixture and journey setup were corrected; the final owner journey passed as part of the 35/35 desktop run. These setup failures were not left as unresolved product failures.
- The Web production build passed with the existing large-chunk warning (>500 kB). It did not fail the build.

## Coverage limits and user acceptance

- **Leave/advance/pause/resume:** passed against the isolated Worker in run 37640643443. An actual remote production deployment was not contacted by this recheck.
- **Live public demo / real account / cross-device account:** passed by the user's explicit acceptance decision; the live demo step was skipped, with no configured URL.
- **Touch interaction:** mobile browser simulation 4/4 passed in run 37640643443; physical touch hardware was not measured.
- **SSE/model generation:** this production-preview journey uses a deterministic chat SSE response. It verifies the engineering/API path without additional provider quota.
- **Timeline archive geometry:** passed in cross-phase browser run 37649736957 after fixing the archived-child state calculation. The regression checks the archived badge and read-only history behavior.

## Resource checkpoint

Before preview work, this session observed about 7.3 GiB MemAvailable, negligible later `vmstat` swap-in/out, and memory PSI avg10/full avg10 at 0. After the local preview run began, the coordinator reported the newer system state as about 5.3 GiB MemAvailable, rising swap use, and memory PSI avg10 about 0.33. Per that coordination, the local preview/API services were stopped and their local database/credentials removed. After explicit user authorization, production-build/browser work resumed only on the GitHub-hosted runner; no additional local build/browser test was started.

## Durable implementation evidence

- D1 persistence schema and migration: `api/src/db/schema.ts`, `api/drizzle/0039_native2d_layout_persistence.sql`, `api/drizzle/meta/0039_snapshot.json`, `api/drizzle/meta/_journal.json`.
- Owner API and persistence/CAS: `api/src/native2d/routes.ts`, `api/src/native2d/repository.ts`, `api/src/native2d/routes.test.ts`.
- Account layout repository and interaction wiring: `web/src/native2d/api-layout-repository.ts`, `web/src/native2d/session-adapter.ts`, `web/src/native2d/sample-page.tsx`, `web/src/native2d/world-source.ts`.
- Timeline comparison correction and regression coverage: `api/src/life/compare.ts` and related API journey tests.
- Deployment journey checks: `scripts/verify-deployment-journey.ts` (isolated Worker leave/pause/resume passed in 37640643443; no remote production deployment is claimed).
- Itemized Phase 2 checklist: `docs/spec_docs/phase2-world-loop/checklist.md`.

The passing production-preview evidence is reproducible from workflow `.github/workflows/phase2-production-acceptance.yml` and script `web/scripts/phase2-release-preview.acceptance.ts`. The run tested code commit `b68e79b`; this checkpoint additionally records the run results. The evidence commit is listed in the final acceptance handoff.
