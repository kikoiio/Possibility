# Code quality refactor

- [x] Read the shared principles index.
- [x] Phase A: Frame. Ground first, then commit. Don't start the run until you can state:
  - [x] The definition of done as a falsifiable predicate (the **prove-it-works** principle skill).
  - [x] Scope, quantified: rough units and effort, plus the blockers grounding surfaced.
  - [x] The rigor level, biased high. One-way doors and high blast radius get more. Reversible low-stakes steps get less. Rigor is gates and artifacts, not "try harder".
  - [x] Present the framing and tradeoffs before committing to a long run. Reversible work proceeds (the **never-block-on-the-human** principle), but a multi-hour run earns one checkpoint.
- [x] Phase B: Design the workflow. Decompose into atomic, independently-landable units. Sequence riskiest-unknown-first. Scaffold and verification come before features (the **foundational-thinking** principle).
  - [x] Build the verification harness before the work, with the baseline captured from the pre-change state, so the check reads as "old value vs new value".
  - [x] For one-way-door design decisions, run the **architect** skill (it runs **arena**). Skip it for mechanical work whose shape is already concrete. A second arena over a settled design is over-engineering (the **laziness-protocol** principle).
  - [x] Decide what fans out. Parallelize only across seams, and give each worker its own worktree or branch (the **separate-before-serializing-shared-state** principle). Don't over-fan.
  - [x] Write the designed phase list down. That list is what the human reviews.
- [ ] Phase C: Run the loop. Each unit is an experiment. State the hypothesis, make the smallest change, measure against the predicate on the real artifact, keep it if it advanced, revert it if it didn't. Apply the **sequence-verifiable-units** principle, verifying each unit before starting the next instead of batching checks at the end.
  - [ ] Verify by inspecting the artifact, never a self-report. When something passes too easily, suspect the observation method before the system.
  - [ ] Pair delegated work with a judge. If a worker games the gate, reset and harden the contract. If the gate itself is wrong, fix it in its own change rather than routing around it.
  - [ ] A verdict is VERIFIED, NOT VERIFIED, or INCONCLUSIVE. Inconclusive is not a pass. Don't hide a negative.
- [ ] Phase D: Keep the audit trail. Log the run via the **show-me-your-work** skill. figure-it-out's work is usually ambitious enough that a reviewer needs the trail to trust the result. The trail plus the diff is what lets the human come back to it later.
- [ ] Phase E: Verify and hand back. Check the whole against the Phase A predicate on the real product, not just the harness. Encode any recurring correction as a gate, a lint rule, a check, or a script (the **encode-lessons-in-structure** principle).

## Designed units

- [x] U1. Add a pull-request quality workflow and a manual dispatch entry for the same checks, plus a `codex/**` push trigger so the baseline can run before any PR. Include all workspaces and one targeted browser journey. Run it on GitHub Actions before structural changes.
- [x] U2. Move world/time status contracts and pure status descriptions into a shared package. Update server and client imports. Verify workspace resolution and focused contract/API/UI tests.
- [x] U3a. Authorize visit targets before session reads or writes. Prove enter, replay, leave, and no-session leave reject a real foreign-owned world without database side effects.
- [x] U3b. Add a batch world-time context loader and batch visit-context loader. Use them for the home response and preserve single-target reads elsewhere. Verify values for owner, guest, archived, no-timeline, and large home fixtures; assert query count is bounded independently of timeline count.
- [ ] U4. Extract visit lifecycle from `WorldCanvasPage`, then separate one additional cohesive world-canvas workflow to reduce page orchestration without creating a controller god-object. Verify the page and targeted journey.
- [ ] U5. Split timeline-scoped scene revision storage from legacy world-scene operations. Keep canonical exports or migrate all callers in one unit. Verify scene repository, history, fork, and migration tests.
- [ ] U6. Reduce route mount-order coupling by moving auth to explicit path-owning routers or middleware. Add overlap/auth tests. Verify protected and public route behavior.
- [ ] U7. Run the full new GitHub Actions gate, inspect the run and artifacts, perform a diff review, and record unverified product acceptance cases honestly.
- [ ] U8. Review the current diff for comments and style, audit the decision trail, and report branch/push status.

## Definition of done

- A GitHub Actions workflow runs on `pull_request` to `main` and `workflow_dispatch`, and passes on the task branch.
- Shared world/time types and status behavior have one source of truth across API and Web.
- Home time contexts are loaded in a bounded number of database queries, independent of the number of returned timelines.
- `WorldCanvasPage` and scene repository no longer mix the responsibilities identified in the review; no production module newly crosses 1,000 lines.
- Protected/public route behavior is covered without relying on global app mount order for authorization.
- Existing phase 2B code and artifacts are preserved. Any product acceptance path not exercised in GitHub Actions remains explicitly unverified.
- The working tree, CI run, and external branch state are reported accurately.

## Current checkpoint

- The architecture review selected candidate A. Candidate B's route matrix and storage import-boundary check are grafted into the final design.
- The local pre-refactor worktree contains 58 paths: 34 modified and 24 untracked. They include phase 2B work and evidence and remain user work to preserve.
- The user explicitly authorized GitHub Actions. Manual dispatch returned 404 because the workflow is not on the default branch; the `codex/**` push trigger verified the same checks at commit `4d6b32e` without opening a PR. The PR and manual dispatch event paths are configured but not yet invoked.
- U1 passed on run `38783539070`: 978 API tests, 754 Web tests, 200 shared-contract tests, one browser journey, and an uploaded Playwright trace artifact.
- The stage 0 product acceptance listed in `docs/PLAN.md`, including phase 2B AC8 and AC12, remains a separate product check. CI does not close it by itself.
- U2 moved the world/time contract into `@possibility/world-contract` and passed on run `38784920480` at commit `5109f2a`; package, API, Web, and phase 2B browser checks are green.
- U3a passed at `c50f2d4` on Actions run `38787190687`; the visit-service suite contains four passing tests, including foreign-world no-read/no-write coverage.
- U3b's first two Actions runs stopped during fixture setup because 50-row and 20-row inserts exceeded the CI SQLite parameter limit. The seed now uses one prepared five-parameter insert per row; its baseline probe calls the current per-timeline context path directly, and the final test will exercise the full home read with 1,007 timelines after batching.
- U3b run `38789663094` still failed before recording the baseline because its 1,005 added timelines defaulted to active and tripped the three-active-timeline guard. The same run exposed a separate `original-sample-diagnostics` deadline miss at 10.256 seconds against its 10-second budget; inspect that behavior if it recurs, without widening the budget to hide it.
- U3b pre-change baseline passed the full gate at `b8bbc54` on run `38790765560`: API 981 passed/1 skipped, Web 754 passed, shared contracts 204 passed, and the browser journey passed with artifact `11999378548`. The old per-timeline path measured 12 context queries for 2 timelines and 4,032 for 1,007; the diagnostic repair used 19,197,242 work units and took 9.923 seconds, after 5.223 seconds on run `38787190687` and one 10.256-second timeout on `38789663094`. Keep the 10-second budget and list its runner-speed sensitivity as residual risk.
- U3b implementation run `38792291772` passed both home route tests, including the 1,007-timeline bounded-query case, but the full gate failed the unrelated Mist Manor repair timing assertion at 10,003.55 ms. The same commit passed the full gate on run `38793503212`, so U3b is verified. The repair wall-time variation remains a residual risk; the 10-second budget stays unchanged.
- Added `.github/workflows/scene-repair-profile.yml`, scoped to pushes on this branch, to profile only the Mist Manor diagnostic and upload its CPU profile. Run `38793503142` passed the test at 9.327 seconds, but the profiles contain no repair frames; the workflow now passes profiler options through Vitest `--execArgv`, pending another run.
- No merge, release, or deployment is authorized by this task.
