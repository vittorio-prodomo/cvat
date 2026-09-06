# SAM3 Text Mask Refinement Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the isolated Nuclio implementation and independent reviews; the controller implements the canvas/UI integration. Keep all changes uncommitted.

**Goal:** Implement the approved Text → Find masks → select one mask → positive/negative points → select another mask or Done workflow.

**Architecture:** A text-schema capability flag enables preview selection. CVAT sends the selected mask as tight-bounds RLE in `extra_params.refinement_mask`, together with all current point prompts; it omits `text_prompt` for refinement. The SAM3 handler validates and converts that seed mask to the interactive predictor's actual mask-input dimensions. Requests are stateless and use a fixed seed per refinement visit, making point removal and queued requests deterministic. Only the selected result is replaced. Existing Django ROI translation handles points and response masks; the UI offsets the seed bounding box into ROI coordinates.

**Tech Stack:** React/TypeScript, CVAT canvas/SVG, Python/Nuclio, existing pinned SAM3 and checkpoint, CUDA.

## Scope and decisions

- The user approved the workflow on 2026-09-03 with “Alright, let's proceed.” Implementation, isolated tests, candidate builds, and review are authorized. The prior deployment approval concerned the completed text feature; this extension will be prepared for a separate deployment decision.
- Worktree `/data/cvat/.worktrees/sam3-text-refinement`, branch `feat/sam3-text-refinement`, copied the deployed uncommitted text feature from its preserved worktree. Baseline: 38 Python + 16 text UI + 5 box UI tests pass.
- Advertise `supports_mask_refinement: true` on the `text_prompt` schema item. Old function schemas continue using the previous preview flow.
- Preview selection uses exact mask foreground hit-testing, including holes, rather than bounding boxes. Overlapping masks remain selectable through a named mask selector in the overlay. Selection itself is not a positive point.
- Selected mask is highlighted. Left click adds a positive point; right click a negative point. “Back to masks” finishes that refinement visit and enables selecting another mask. Previously confirmed changes remain. Starting another visit seeds from its current confirmed mask.
- Preserve all other masks, labels, and original detection confidence. The predictor's quality score must not replace text detection confidence. Threshold-hidden results cannot be selected.
- Removing every point restores the visit's seed without a server request. A monotonically increasing request version prevents superseded responses from flashing or overwriting newer edits. Back to masks, selection changes, Esc, frame/job changes, and new sessions invalidate pending refinement responses.
- Done accepts the currently displayed, confirmed masks and cancels any pending work, matching existing preview semantics. It does not create duplicate annotations. Esc discards the complete preview. No annotation is persisted until normal Done/Save.
- Use the same verified checkpoint and runtime pins. No model training, backend deployment, commits, merges, pushes, or memory edits.

## Task 1 — Nuclio mask-seeded point refinement

Files: `serverless/pytorch/facebookresearch/sam3/nuclio/{main.py,model_handler.py,function-gpu.yaml,test_main.py,test_model_handler.py,test_function_gpu.py}`; a focused mask helper/test file if useful.

- [x] Add failing tests for `refinement_mask` dispatch, mixed text/refinement rejection, malformed RLE, wrong dimensions, invalid/empty points, one returned mask, native logits conversion, and unchanged text/visual dispatch.
- [x] Run `python3 -m pytest serverless/pytorch/facebookresearch/sam3/nuclio -q`; observe failures for missing refinement support.
- [x] Implement `handle_refine(image, *, refinement_mask, pos_points, neg_points)` using `predictor.set_image`, image-sized mask decoded from validated row-major tight RLE, signed seed logits resized to `predictor.model.sam_prompt_encoder.mask_input_size`, and `predict(..., mask_input=..., multimask_output=False)`. Avoid hard-coded 256: this SAM3 runtime uses a larger embedding grid.
- [x] Require nonempty finite point pairs with matching foreground/background labels. Validate mask integers (exclude booleans), nonnegative runs, exact run sum, in-image bbox, nonempty foreground, and reject mixed text or boxes. Return HTTP 400 for invalid requests and `{shapes: [...]}` for successful refinement.
- [x] Set text schema capability flag and run the focused suite.
- [x] Run an isolated real-GPU probe on GPU 1 with the read-only checkpoint and candidate source: text-derived seed, positive/negative clicks, point removal/replay, non-square image and ROI seed coordinates. Report concrete results; do not mutate live services or annotations.

## Task 2 — Canvas selection and UI refinement session

Files: `cvat-canvas/src/typescript/{canvasModel.ts,canvasView.ts,interactionHandler.ts}`, `cvat-ui/src/components/common/model-extra-params-form.tsx`, `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx`, a focused refinement overlay component and styles, `tests/unit/interactor-text-refinement.cjs` and canvas regression coverage.

- [x] Add failing tests for capability gating, selection without a prompt, mask hit-testing, accumulated positive/negative points, only selected-mask replacement, preservation of labels/confidence, point removal, stale responses, ROI seed offsets, Back to masks, and Done/Esc.
- [x] Add `select_shape` canvas command and stable shape IDs to preview payloads. Forward optional selected shape ID in the existing `canvas.interacted` event. Allow clearing prompts without ending the interaction; keep `put_shapes` preserving the drawing command by default.
- [x] Extend the controller with selected-result index, immutable seed for the current visit, and request revision snapshots. Send `extraParams.refinement_mask` with ROI-adjusted bbox and no text key. Preserve the other results and original confidence when applying the single returned mask.
- [x] Add overlay controls for selecting visible masks, selected-mask guidance, Back to masks, and Done. Reuse existing point drawing/removal behavior and confidence filter. Invalidate queued and in-flight refinement when changing selection or ending a visit.
- [x] Run `node tests/unit/interactor-text-refinement.cjs`, `node tests/unit/interactor-text-prompts.cjs`, and `node tests/unit/interactor-box-transition.cjs` plus the focused canvas harness.

## Task 3 — Integration, review, and deployable artifacts

- [x] Run production-dependency lint and UI build. Build a tagged SAM3 candidate on the existing runtime image and verify its source hashes.
- [x] Exercise actual canvas/SVG plus React controls in a browser with synthetic inference responses: select a mask, include/exclude clicks, switch objects, adjust confidence, remove points, finish, and cancel. Clearly report any mocked boundary.
- [x] Verify CVAT's real adapter with a synthetic frame, actual ROI translation, and candidate inference where practical; write no annotations.
- [x] Independent spec review, then independent quality review. Resolve material findings and repeat affected verification only.
- [x] Record exact candidate tags/IDs, verification results, rollback/deployment requirements, and remaining deployment decision in the human HTML design document. Keep original deployed worktrees and runtime unchanged.

## Completed verification

- 93 SAM3 Python tests passed, including malformed RLE/point validation and native threaded autocast regressions.
- 36 UI/canvas tests passed: 11 refinement controller, 4 canvas selection, 16 original text, 5 optional-box transition.
- 30 browser checks passed with zero JavaScript errors or console warnings. Actual React/AntD, svg.js interaction handler, coordinate/RLE helpers, and extracted canvas event bridge ran; full workspace initialization, inference, OpenCV contours, and persistence were fixture boundaries. Twelve source-file hashes match the final checkout.
- The final packaged SAM3 image passed real GPU acceptance without source mounts: positive inclusion, negative exclusion, non-square image, tight/wide ROI, splitting a merged text seed, point-removal replay, concurrent replay, and retained text/visual behavior. A single negative was ignored in one tight-ROI case; a second accumulated negative corrected it. Model prompts are guidance, not hard pixel constraints.
- Seed prior tuned from saturated logits to soft +/-1 after actual inference revealed saturated seeds resisted clicks. Use actual encoder mask input size 288x288. Per-request bfloat16 autocast fixes upstream constructor-only thread state; an inference lock prevents predictor image-feature interleaving.
- Existing live CVAT adapter verified refinement-mask forwarding, omitted text, translated points, 200x200 ROI crop, translated mask response, and capability exposure with zero database queries. The inference gateway response was mocked in that adapter probe.
- Independent specification and quality reviews passed. Resolved Done during pending requests, half-open ROI point bounds, and recomputing current polygon approximation when restoring a seed.
- Narrow browser checks found a new-panel overlap with existing confidence controls; moving the new panel to bottom-left fixed it across 1320/900/600/390px viewports.
- Final production lint, UI build, source-hash reconciliation (881 UI source files), and git diff --check passed. Build warnings are existing asset-size/Browserslist advisories.
- Live SAM3 and cvat_ui container IDs/image IDs remain unchanged from the preceding text-prompt deployment. No annotations, commits, merges, pushes, or live deployment changed in this task.

## Candidate artifacts

- UI: `cvat/ui:sam3-text-refinement-20260903`, image `sha256:56f03cc7c250dc1d025998b061e8854115bad43fbefcb1be72ac1eab181c64ed`.
- SAM3: `cvat.pth.facebookresearch.sam3.interactor:text-refinement-20260903`, image `sha256:37122817fa6a9042a75476ea794a5cd897e65d9be782641d8cb134ebf8cec446`.
- UI bundle: `assets/cvat-ui.b584348e33a3270fb68a.min.js`.
- Candidate runtime: `/data/cvat/data/deployments/sam3/function-text-refinement-runtime.yaml`; no build section; canonical live runtime remains unchanged.
- Candidate receipt: `/data/cvat/data/deployments/sam3/text-refinement-candidates-20260903.json`.
- Durable evidence: `/data/cvat/data/deployments/sam3/text-refinement-verification-20260903/`.
- Upon explicit deployment approval, preserve current UI/SAM3 rollback image tags and canonical runtime; deploy candidate Nuclio function with nuctl1.16.3, then retag candidate UI as cvat/ui:dev and recreate only cvat_ui using receipt Compose arguments including email-relay overlay. Verify actual live gateway text/refinement/visual inference and public bundle identity. Only then update canonical runtime.

## Authorized deployment completed

- User separately approved: “yes, deploy both now.” Deployment and live verification completed on 2026-09-03 at 11:58 CEST.
- Candidate image identities matched before deployment. Preserved rollback tags `cvat/ui:rollback-before-sam3-refinement-20260903` and `cvat.pth.facebookresearch.sam3.interactor:rollback-before-text-refinement-20260903`, previous runtime `function-rollback-before-text-refinement-20260903.yaml`, and Nuclio export `function-before-text-refinement-20260903.json` under `/data/cvat/data/deployments/sam3/`.
- Deployed the existing Nuclio function using the prepared runtime and nuctl 1.16.3; build was skipped. Function is ready, container healthy, exact candidate image verified, checkpoint remains read-only, and refinement capability is exposed.
- Actual CVAT gateway to deployed Nuclio passed text discovery, positive inclusion (+20,235 pixels), negative exclusion (3,261 pixels removed), accumulated ROI negatives with correct coordinate translation, exact replay, and original points/box inference. Only the synthetic frame provider was mocked; zero database queries and no annotation changes.
- Retagged verified UI image as `cvat/ui:dev`, recreated only `cvat_ui` with the recorded Compose arguments including the email relay overlay. Public/local UI and API returned HTTP 200; the public/local bundle matched the container SHA-256 `7f1dfaa88c65931aff3d9880163e9e927fdc0b1e398573c2c802117437b67e77`.
- Both target container IDs changed to the candidate images. All 22 unrelated containers retained their IDs and start times; their available health checks passed.
- Updated canonical `function-runtime.yaml` only after live checks passed. Durable receipt: `/data/cvat/data/deployments/sam3/text-refinement-deployment-20260903.json`. Live evidence and probe source are in the existing `text-refinement-verification-20260903/` directory.
- Earlier browser checks used inference fixtures; deployment checks verified the live gateway and served UI bundle, not a logged-in full-job browser session. Source remains uncommitted and unmerged; no push or memory edit occurred.
