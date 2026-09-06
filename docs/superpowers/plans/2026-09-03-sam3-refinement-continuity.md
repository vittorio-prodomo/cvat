# SAM3 refinement continuity and AI Tools interaction plan

> Agent execution checklist. Preserve existing deployed SAM3 behavior. No commits, pushes, merges, or deployment in this implementation stage.

**Goal:** Preserve the selected object's scope during point refinement, keep SAM3 prompt-mode layouts stable, and allow focused form submission with Enter.

**Baseline:** Worktree `/data/cvat/.worktrees/sam3-refinement-continuity`, branch `fix/sam3-refinement-continuity`, develop `1ba5b66b1` plus the existing deployed uncommitted SAM3 implementation and popup-width patch. Exact baseline snapshots are in `/data/cvat/data/deployments/sam3/refinement-continuity/baseline/`. New changes must be assessed against these snapshots, not interpreted as all new relative to Git HEAD.

## 1. Reproduce and choose the refinement fix
- [x] Read job 182 frame 0 using a read-only database transaction; retain the original image only outside Git.
- [x] Run `concrete surface` at confidence 0.2. Identify the girder mask with holes over the projecting rib (7,451,522 pixels; confidence 0.3984375).
- [x] Reproduce collapse with positive point [2124, 1220]: live function retains 2.08% of the seed.
- [x] Compare signed mask strengths, actual text logits, multiple candidates, and a seed bounding box. Bounding-box guidance retains 99.43% and includes the clicked hole; logits alone do not fix collapse.

## 2. SAM3 scope guidance (root agent)
Files: `serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py`, `test_model_handler.py`.
- [x] Add failing tests showing the predictor receives the validated seed bounding box, expands it for positive points outside the seed, and does not expand it for negative points.
- [x] In `handle_refine`, derive a float32 XYXY box from the validated seed's bounds and positive points, and pass it with the existing mask prior and accumulated points to `predict`.
- [x] Add a guarded retry without the extent when an explicit click is missed; use it only when click agreement improves. The unconditional box version failed an established negative correction and was rejected.
- [x] Preserve the stateless request contract, ROI coordinate frame, binary mask payload, confidence/label behavior, and external rejection of user-supplied boxes mixed with refinement.
- [x] Run SAM3 tests alone. Verify the actual bridge case plus negative corrections, positive extension outside the original bounds, and point-removal replay on the isolated GPU.

## 3. AI Tools layout and keyboard behavior (UI agent)
Files: `cvat-ui/src/components/annotation-page/standard-workspace/styles.scss`, `controls-side-bar/tools-control.tsx`, `cvat-ui/src/components/model-runner-modal/detector-runner.tsx`; a small shared key-handler utility and focused tests if useful.
- [x] Set the AI Tools fixed width to 520px, retaining the viewport cap and leaving OpenCV styles alone.
- [x] Remove the Text-mode explanatory paragraph. Give the text field and optional starting-box toggle an equally sized mode-specific area, keeping ROI, polygon conversion, and the main button at stable positions. Avoid a large fixed height for empty tabs. Keep other models' parameters working.
- [x] Plain Enter from a focused form field triggers the same enabled primary button action. Respect open selects, focused secondary buttons, IME composition, modifier keys, key repeats, disabled/busy state, and canvas keyboard scope. Do not cause duplicate inference.
- [x] Verify with the actual AntD/CVAT browser fixture: both prompt modes, Argus mapping and ROI, narrow viewport, keyboard focus on text/numeric fields, dropdown selection, disabled states, and repeated Enter.

## 4. Candidate verification and review
- [x] Inspect the delta from deployed baseline and run targeted checks; obtain independent spec and quality review.
- [x] Build a UI candidate and a SAM3 candidate from verified source. Preserve evidence and source hashes under the ignored deployment directory.
- [x] Verify packaged artifacts. Leave deployment as a separate approval, consistent with the user's workflow.

## Verified result
- Packaged SAM3: 99.44% of the 7,451,522-pixel girder seed retained; the clicked 12,513-pixel hole is fully filled. Negative/ROI/extension/replay checks pass.
- UI: 28 layout cases, 22 keyboard cases, 5 initial layout/action regression checks, 53 unit tests; SAM3: 102 unit tests. ESLint, stylelint, TypeScript and production build pass.
- Corrected a pre-existing activation-state typing error with functional setState; no change to the restored interaction setup.
- Candidate receipts and rollback references: `/data/cvat/data/deployments/sam3/refinement-continuity/candidate-20260903.json`. Deployment subsequently authorized and completed; see deployment receipt below.

## Authorized deployment completed
- User authorization: "deploy both, sure."
- Only `cvat_ui` and the SAM3 Nuclio function replaced; all 23 other running services retained their container identities.
- Real job182/frame0 through live CVAT gateway matched the tested candidate mask exactly, retained 99.44% of the seed, filled the clicked hole, and replayed identically.
- Public and local UI/API checks returned HTTP200 and the served bundle hash matched the candidate. Rollback images/config retained.
- Receipt: `/data/cvat/data/deployments/sam3/refinement-continuity/deployment-20260903.json`. No commits or pushes performed.
