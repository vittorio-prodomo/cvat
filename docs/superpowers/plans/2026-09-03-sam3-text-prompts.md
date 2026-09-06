# SAM3 Text Prompts Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the isolated Nuclio task and independent review; the controller integrates and verifies the UI. Keep all changes uncommitted unless requested.

**Goal:** Add the approved Text → preview → Done workflow to the existing SAM3 interactor for the current frame or ROI.

**Architecture:** Advertise text capability through the existing `extra_params_schema` entry `{name: "text_prompt", type: "text", max_length: 256, default: ""}`. The UI offers Points / box and Text modes only for models declaring this entry. Existing `extra_params` forwarding carries `text_prompt` to the Nuclio handler; existing RLE `shapes` responses, ROI translation, confidence filtering, label fallback, and annotation creation handle the output. No Django changes or new checkpoint are required.

**Tech Stack:** React/TypeScript, CVAT canvas, Python/Nuclio, pinned Meta SAM3 image processor, CUDA.

## Accepted behavior and boundaries

- Text mode requires a trimmed, nonempty phrase of at most 256 characters. Find masks immediately starts inference with empty point/box arrays and optional ROI. One phrase describes one concept; returned instances use the selected CVAT label.
- Text preview does not accept point or box prompts. Done adds all displayed instances separately; Esc, frame/job changes, and switching tools discard the preview and invalidate pending results. Nothing is persisted before Done and normal CVAT Save.
- Use SAM3 processor confidence floor 0.2, matching the existing UI confidence slider minimum; initial display threshold is 0.5 and the existing slider covers 0.2–0.9.
- Preserve the earlier optional-box transition fix copied from the dedicated worktree, including its regression tests. Point/box requests retain the legacy single-mask response.
- Implementation, candidate builds, isolated inference tests, and review are authorized. Live deployment requires its own user authorization. No commits, merges, pushes, or memory edits.

## Task 1 — Nuclio text inference

Files: `serverless/pytorch/facebookresearch/sam3/nuclio/{model_handler.py,main.py,function-gpu.yaml,test_model_handler.py,test_main.py,test_function_gpu.py}`; a focused helper/test file in that directory if needed.

- [x] Add failing tests for text-only requests, two distinct masks, confidence attributes, empty results, nonempty/length/type validation, mixed visual/text rejection, and retained point/box responses.
- [x] Run `python3 -m pytest serverless/pytorch/facebookresearch/sam3/nuclio -q` and confirm failures identify missing text support.
- [x] Retain the full model alongside its interactive predictor. Use `Sam3Processor(model, confidence_threshold=0.2)`, `set_image(image)`, and `set_text_prompt(prompt=trimmed_phrase, state=fresh_state)` per request.
- [x] Return `{ "shapes": [{ "type": "mask", "points": [run_lengths..., left, top, right, bottom], "attributes": [{"spec_id": 0, "value": "0.8"}]}] }`; each nonempty mask has its own tight-bounds row-major RLE. No model-derived label is returned so CVAT uses its selected label. Return `{"shapes": []}` for zero matches.
- [x] Keep visual requests on the existing `handle(image, pos_points=..., neg_points=..., obj_bbox=...)` path. Validate text requests before inference; report malformed or mixed prompts as HTTP 400.
- [x] Advertise the text schema and update help text; preserve runtime pins and checkpoint contract. Run the full focused SAM3 suite.

## Task 2 — UI text session

Files: `cvat-ui/src/components/common/model-extra-params-form.tsx`, `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx`, `tests/unit/interactor-text-prompts.cjs`, with a shared controller harness if useful.

- [x] Add failing controller tests that render the real component and exercise Text mode selection, input validation, immediate Find requests after activation, ROI forwarding, blocked request replay, rejection of canvas prompt events in Text mode, and point-mode exclusion of stale text.
- [x] Add `text` and `max_length` schema support to the parameter form. Treat the declared `text_prompt` field as the capability; hide it in Points / box mode and show it in Text mode. Hide Start with a bounding box in Text mode.
- [x] Start text sessions with `put_shapes` and an empty preview, leaving the canvas idle. Enqueue the initial text request after activation has reset session state. Reuse the existing request queue, blocker snapshot and inference processing.
- [x] Add controller tests for multi-instance preview then Done, confidence filtering, Esc and stale responses after cancellation/frame changes. Reject responses whose interaction session is obsolete; prevent old previews being accepted while a new request runs.
- [x] Run `node tests/unit/interactor-box-transition.cjs` and `node tests/unit/interactor-text-prompts.cjs` until green. Keep unit harness mocks at external canvas/network/render boundaries.

## Task 3 — Integration and review

- [x] Verify actual SAM3 processor inference in an isolated GPU container using the existing runtime image, mounted candidate handler, and read-only checkpoint; use a synthetic image and local repository test fixture, without changing live annotations or Nuclio deployment.
- [x] Verify backend `extra_params` forwarding and ROI translation of multiple RLE masks with focused existing lambda-manager tests or an isolated adapter probe.
- [x] Build the production UI and a uniquely tagged SAM3 candidate image; run production-dependency lint and controller tests. Run browser checks against the candidate UI with mocked API responses when no separate test server is available.
- [x] Independent spec review, then code-quality review; fix material findings and repeat only affected checks.
- [x] Record candidate tags, source paths, verification and remaining deployment step in the design document. Ask once for scoped deployment approval only after candidates are ready.

## Verification results

- SAM3 CPU suite: 38 passed, including native bfloat16 score regressions.
- UI controller suites: 16 text + 5 box-transition tests passed; production-dependency lint passed.
- Independent spec and quality reviews passed after fixes for repeat prompt snapshots, inactive frame changes, and controlled model selection.
- Browser: 23 checks with real React/AntD and mocked canvas/network/persistence boundaries.
- GPU: candidate image tested directly on GPU 1; two disjoint red-circle masks above display threshold, absent concept and changed-image zero matches, visual-after-text and text-after-visual correct. Initialization 8.1 s; warm text inference approximately 0.07 s for synthetic inputs. Peak allocated GPU memory 5,354 MiB.
- Live CVAT adapter probe: text forwarding, 200x200 ROI crop, two masks translated, confidences preserved, zero database queries.
- Candidate runtime config: `/data/cvat/data/deployments/sam3/function-text-prompts-runtime.yaml`; it contains no build section.

## Task 4 — Authorized deployment, 2026-09-03

User explicitly authorized: “yes, deploy it”.

- [x] Confirm both candidate image IDs and snapshot all 24 live containers.
- [x] Preserve UI and SAM3 rollback image tags and the previous runtime YAML.
- [x] Deploy the prepared SAM3 runtime through nuctl 1.16.3 with no build section; function healthy on port 32768.
- [x] Verify actual text, absent-concept, ROI, visual-after-text, and repeated-text inference through the live CVAT LambdaFunction and HTTP gateway. Only the frame provider is synthetic; zero database queries or annotation writes.
- [x] Retag the verified UI candidate as cvat/ui:dev and recreate only cvat_ui using all production Compose overlays, including email relay.
- [x] Local and public index, bundle, and API return HTTP 200. Public and container bundle SHA-256 match. All 22 other containers are unchanged.
- [x] Update canonical runtime configuration and save the durable deployment receipt.

Live UI image: `sha256:fec7a46ac8ae552ec27c22c15d1505125f6a9351339f2519516ba1ee57da6f66`.
Live SAM3 image: `sha256:8eeaaf38d4f9bad8ace411759448159bde9bd1342312bbe1c823674f1f1f5a7d`.
Receipt: `/data/cvat/data/deployments/sam3/text-prompts-deployment-20260903.json`.
Rollback runtime: `/data/cvat/data/deployments/sam3/function-rollback-before-text-prompts-20260903.yaml`.
Rollback UI: `cvat/ui:rollback-before-sam3-text-20260903`.
Canonical runtime: `/data/cvat/data/deployments/sam3/function-runtime.yaml`.

The production inference probe used synthetic images and did not create annotations in a real job. Browser workflow checks used real React/AntD with mocked canvas/network/persistence boundaries. Source remains uncommitted on `feat/sam3-text-prompts`; no merge or push occurred.
