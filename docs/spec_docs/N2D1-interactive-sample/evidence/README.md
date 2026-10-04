# N2D1 acceptance evidence

Collected on 2026-10-04 after integrating local main commit `2923d3d` into the acceptance branch. All logs and observations correspond to Chromium Headless 153 with one Playwright worker unless noted. Screenshots are full page and provide visual context for the named browser interactions.

## Final checks

| Artifact | Contents |
|---|---|
| [web-unit.log](web-unit.log) | Full web suite: 56 files, 468 tests passed. |
| [web-build.log](web-build.log) | TypeScript check and production build; build succeeded with the existing large main-chunk warning. |
| [browser-collection.log](browser-collection.log) | Three isolated projects and exact browser test collection, 39 tests total. |
| [unit-collection.log](unit-collection.log) | Vitest's collected unit tests; no `native2d-e2e` entries. |
| [native2d-browser.log](native2d-browser.log) | Desktop 34, mobile 4 and live 1 browser test; all 39 passed, workers=1. Includes pan, pinch and building preview samples. |
| [3d-regression.log](3d-regression.log) | Eight existing desktop 3D, landing, guest and world-list regression tests passed on the isolated S02 test database. |
| [production-entry.log](production-entry.log) | Production preview browser check: lazy route loaded, one canvas rendered, 11 assets returned HTTP 200, no page or console errors. |
| [production-entry.json](production-entry.json) | Production diagnostics and browser/WebGL renderer identification. The renderer is ANGLE SwiftShader, a software renderer. |
| [real-public-identity.json](real-public-identity.json) | Actual existing local read-only public API response for 雾影庄, all seven locations, residents, and the three GET requests. No seed or API stub. |
| [performance.json](performance.json) | Touch pan/pinch and desktop move-preview render and page-rAF observations, with duration and renderer metadata. |
| [narrow-layout-audit.json](narrow-layout-audit.json) | Enumeration of all 672 fixed-layout single-building candidates; no candidate is solely a disconnected failure. Synthetic corridor tests cover disconnection and legal bypass. |
| [SHA256SUMS.json](SHA256SUMS.json) | SHA-256 digests and byte sizes for saved artifacts. |

The host was an Intel Core i5-13500HX. The touch profile was a 390×844 Chromium simulation with a 364×497 viewport; DPR/resolution were 1. The observed page-rAF callback rate is not reported as application FPS. Real phone and hardware-GPU performance were not tested; the approved acceptance records the software renderer actually used.

## Visual review

| Screenshot | Observed state |
|---|---|
| [buildings-before-moves.png](buildings-before-moves.png) | Baseline exterior, road and pond paths. |
| [day-exterior.png](day-exterior.png), [night-exterior.png](night-exterior.png) | Fixed day/night comparison and warm accent layers. |
| [day-exterior-selected.png](day-exterior-selected.png), [day-hall-selected.png](day-hall-selected.png), [night-hall-selected.png](night-hall-selected.png) | Resident highlight and selected-resident foreground occluder fade. |
| [day-legal-preview.png](day-legal-preview.png), [day-invalid-preview.png](day-invalid-preview.png), [night-legal-preview.png](night-legal-preview.png), [night-invalid-preview.png](night-invalid-preview.png) | Semi-transparent candidate building, full footprint, legal/illegal state and text feedback in both lighting periods. |
| [gatehouse-moved.png](gatehouse-moved.png), [greenhouse-moved.png](greenhouse-moved.png), [main-house-moved.png](main-house-moved.png) | Each independent building layer at the applied location; the main-house screenshot follows the move and the test enters its bound hall. |
| [mobile-overview.png](mobile-overview.png) | 390×844 touch simulation after pan/pinch, resized overview and location/resident/building touch-pick interactions. |
| [production-entry.png](production-entry.png) | Production build opened at `/dev/native-2d`. |

## Browser behavior and lifecycle

- `acceptance.spec.ts` covers initial/follow-up read, stale/error recovery, source switching, same-input bounds stability, unknown time, resident placement limits, layout validation, damaged storage, quota retry, selection/follow and facts retention.
- `visual.sample.spec.ts` reads the actual Pixi display tree for the test and verifies terrain order, selected resident highlights/occluders, candidate layers, current camera picking, moved sprites and hall binding.
- `sample.mobile.spec.ts` dispatches real browser touch input. It checks pan/pinch, touch cancel, transformed-coordinate picking, 390×844/414×896 overview fitting, storage invariance and idle draw count.
- `lifecycle.spec.ts` delays the real Pixi initializer and source response, then checks that unmount disposes late applications and ignores old responses. Three route/size cycles count one active application/canvas, six host input bindings, one ResizeObserver and one window resize binding; leaving returns each count to zero.
- `editing.spec.ts` retries an actual renderer initialization failure after moving a building, then compares restored layout, facts, identity and object bounds.
- `readonly-live.spec.ts` requests the existing local public world without a stub or seed and records that sample interactions issue only `/api/public/` GETs.

The fixed exterior has open bypasses: exhaustive validation over its 672 one-building candidates returned zero cases where the sole failure reason was `disconnected`. This exact fixed-scene position therefore is not claimed. Pure synthetic corridor tests verify disconnected entrance/hill-path cases and a legal bypass; the browser verifies actual fixed-scene root/entrance blockage and a legal bypass.
