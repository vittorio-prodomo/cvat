# Reversible SAM3 mask morphology implementation plan

> Agent execution checklist. The user approved option 1: a reversible adjustment over the latest SAM3 output. Implement in the isolated feature worktree; no commits, push, or deployment in this stage.

**Goal:** Add a selected-mask erosion/dilation slider with responsive previews, exact reset, and unchanged SAM3 prompt seeds.

**Architecture:** Keep `interaction.latestResponse` as raw SAM3 results. A per-mask adjustment map stores the requested radius and last completed preview. Canvas drawing and Done use that preview; mask selection and point requests use raw results. A Web Worker computes disk morphology on a padded mask bounding box, clips to the image/ROI, caches distance maps, and coalesces redundant work. Radius is integer -20..20 original-image pixels.

**Baseline:** `feat/sam3-mask-morphology` from develop `1ba5b66b1` plus the exact deployed uncommitted prerequisites copied from `sam3-refinement-continuity`. All 887 deployed UI build inputs verified. Baseline copies and receipts: `/data/cvat/data/deployments/sam3/mask-morphology`.

## 1. Pure mask processing and worker (engine agent)
- [x] Write failing pixel tests against a brute-force Euclidean disk: positive/negative radii, holes, full disappearance, reset, nonzero crop origin, ROI/image clipping, immutable source, invalid RLE.
- [x] Implement `cvat-ui/src/utils/mask-morphology.ts`: cached exact squared distance fields with tight CVAT row-major RLE output. Include outside-image/ROI background for erosion.
- [x] Implement `mask-morphology.worker.ts` and `mask-morphology-client.ts`. API: `apply(rle: Int32Array, radius: number, bounds: [number,number,number,number]): Promise<Int32Array|null>` and `dispose()`. Bounds are half-open. Superseded/disposed requests resolve null; failures reject. Coalesce pending requests for the same source, preserve different masks' pending edits, and bound distance-map caching to the latest source.
- [x] Run engine/client tests and benchmark preprocessing plus cached radius updates on job182/frame0 girder RLE, outside Git.

## 2. Controller and UI (root)
- [x] Add failing controller tests: slider changes never invoke SAM3; raw seed/prompt history unchanged; latest raw SAM3 output gets same radius; per-mask values survive selection changes; zero exactly restores raw; only selected preview changes; empty erosion remains resettable; Done uses preview; cancel/frame/model changes invalidate pending work.
- [x] Add a per-mask map and lazy worker client to ToolsControl. Entries carry source identity, revision/object identity, requested radius, last completed preview, and pending state. Drop stale results after source/session changes. Clear map and dispose worker on new session/cancel/unmount.
- [x] Convert worker RLE to contours/approximation through existing helpers. Empty morphology returns empty preview without destroying raw mask. Preserve confidence and label. Refresh approximations for derived previews when polygon accuracy changes.
- [x] Keep `visibleInteractionResults` raw for selection; derive effective preview for drawing and annotation construction. Reapply the current radius after accepted SAM3 refinement and after removing all points. Never send derived RLE to SAM3.
- [x] Add `mask-morphology-control.tsx` below the existing confidence slider: signed integer slider -20..20, Erode/Dilate labels, current value in px, Reset, enabled only with selected mask, progress status. Keep unrelated tools unchanged. Disable Done while local adjustment is pending; canvas-level completion still saves the last displayed preview.
- [x] Extend the confidence panel through optional children and scoped styles, retaining its layout for other tools and avoiding overlap with polygon-accuracy control.

## 3. Browser, packaged candidate, and review
- [x] Clone the existing actual CVAT/AntD browser fixture; add real worker bundle served over localhost. Verify source hashes, slider effects on real bridge RLE, reset, per-mask switching, confidence hiding, point-response reapplication, pending/cancel/Done behavior, polygon export, disabled/no selection state and narrow layout.
- [x] Run all existing interaction and keyboard tests, new engine/controller tests, exact-dependency ESLint/stylelint/TypeScript, and production build.
- [x] Obtain independent review of state/async boundary and mask algorithm; resolve findings.
- [x] Build and verify UI image, worker asset loading and served hashes; preserve current UI rollback tag. Save candidate receipt and comparison evidence. SAM3 backend unchanged. Present ready candidate for the separate deployment decision.

## Verification receipt

- 81 focused unit tests passed (all existing interaction/keyboard suites plus 28 new controller/engine/client/worker cases).
- Exact-dependency ESLint, stylelint, and full UI TypeScript including Worker entrypoint passed.
- 30 actual CVAT/AntD browser checks passed at 1320/600/420 pixels; backend/persistence and contour helpers mocked in this fixture. Real Worker math and lifecycle verified.
- Independent controller and algorithm review approved after fixing the polygon preview/Done mismatch.
- Production image `cvat/ui:sam3-mask-morphology-20260903` built; packaged worker returned exact expected pixels in Chrome over localhost.
- Main bundle `assets/cvat-ui.54f9ccbf0bbffa8a4fea.min.js`; Worker `assets/952.5f4c0b6bc2e44d5b866f.min.js`. Source manifest, browser evidence, build log and package smoke under `/data/cvat/data/deployments/sam3/mask-morphology`.
- Current UI preserved as `cvat/ui:rollback-before-sam3-morphology-20260903`. Live UI/SAM3/Argus IDs confirmed unchanged. Deployment awaits separate user authorization.
- Additional real OpenCV girder check passed: actual wrapper/core contour extraction and approximation, +20/-20/zero reset, no errors. Full first adjustment 542 ms, cached erosion 260.5 ms, Reset 57.5 ms; maximum animation-frame gap 133.3 ms. Contour conversion still runs on the main thread.

## Authorized deployment

User authorized: "Deploy it now!" UI-only deployment completed and verified on 2026-09-03. Live UI container `a3ffc322f9dc47aad151aa4f31e164e4805e11244f1cdc7c1925370cf4de8270` runs the candidate image. All other 24 containers unchanged. Public/local UI/API and candidate asset hashes passed; public Chrome login/worker smoke passed. Receipt: `/data/cvat/data/deployments/sam3/mask-morphology/deployment-20260903.json`. No commits or pushes.
