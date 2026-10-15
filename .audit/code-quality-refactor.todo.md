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
- [ ] U2. Move world/time status contracts and pure status descriptions into a shared package. Update server and client imports. Verify workspace resolution and focused contract/API/UI tests.
- [ ] U3. Add a batch world-time context loader and batch visit-context loader. Use them for the home response and preserve single-target reads elsewhere. Verify values for owner, guest, and archived contexts. First fix visit authorization before mutation and assert there is no database side effect for foreign worlds.
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
- U2 has moved the world/time contract into `@possibility/world-contract`; package/API/Web build and behavior checks are pending Actions.
- No merge, release, or deployment is authorized by this task.
