# Argus detector implementation

> Use subagent-driven-development. User approved single-pass detector and native ROI; slicing deferred. No commit, push or live deployment in this stage.

## Contract and fixed inputs
- New function `pth-rfdetr-argus-outdoor-v1`, standard detector version 2. No UI or server edits.
- Checkpoint: rfdetr-argus-outdoor-v1-ext-lr1e6/checkpoints/epoch=074-map=0.1016.ckpt.
- SHA256 bb57ce7417e8bab675910d5278057ba456389a3683764248f77c5533fb1cbb8d.
- RF-DETR Seg Large, six classes (0-based): crack, crack_map, spall, exposed_rebar, efflorescence, concrete_water_marks.
- Input 504, mask_downsample_ratio 2, RGB, longest-side OpenCV resize, centered black padding, ImageNet normalization.
- Toolkit 8e5b3232e1aa4e63bebeb771ace948f93c69242b and rf-detr 27eceb15ff74a4f5be0d5e7c860e5760497cd5fb bundled from clean Git archives. Torch 2.8/CUDA12.8.
- Use pinned toolkit adapter, pretrained=none, weights_only checkpoint load, strict state load. Full 504 mask decoding (val_mask_downsample=1) for annotation; toolkit class-aware mask-IoU NMS 0.7, maximum 100 detections.
- Input JSON image(base64), optional finite threshold [0,1], default0.2. Reject invalid input with400; failures500, never silently empty.
- Return flat detector list: label, type=mask, confidence, attributes=[], mask=dense cropped binary values followed by inclusive [left,top,right,bottom]. Preserve holes/components. Return coordinates relative to received image; CVAT owns ROI crop and translation.

## Tasks
1. [x] Backend, handler and meaningful TDD tests: geometry, serialization topology, class IDs, thresholds, strict loading. Implementer owns Python handler/backend/test files only.
2. [x] Root packages pinned dependencies and model artifact, Nuclio manifest, reproducible preparation and Docker build commands, source provenance. Narrow build context only.
3. [x] Focused tests then isolated GPU1 inference compared to bridge adapter: full frame, non-square crop, threshold and serialized masks. Test real CVAT ROI adapter translation without annotation writes.
4. [x] Independent spec review then quality review, resolve substantive findings.
5. [x] Build and probe final candidate image, archive evidence and deployment command. Live deployment requires user approval of verified candidate.

## Verification boundaries
- Baseline legacy RF-DETR tests: 149 passed before edits.
- Do not load or modify live SAM3/GPU0, UI, server, annotations or training repo state.
- Real inference parity must cover normalization/resize and mask geometry, not just successful startup.
- Image-only full-frame resize can miss small defects; ROI is the intended first-stage remedy. No slice controls or SAHI.

## Completion evidence

Candidate receipt: `/data/cvat/data/deployments/argus-outdoor-v1/candidate-20260903.json`. All 105 Argus tests passed in bridge environment; shared RF-DETR suite253 passed and1 optional dependency skip. Offline GPU parity, healthy temporary Nuclio processor, actual CVAT ROI/mapping/RLE adapter checks, source hash verification, spec review and quality review passed. Temporary containers removed; all24 original containers unchanged. No function registered. Live deployment and browser smoke remain separately approved work.

## Authorized deployment completed

User requested deployment after candidate verification. Function `pth-rfdetr-argus-outdoor-v1` deployed ready on port32769 using approved image5f5a89ba9eeb. Live CVAT gateway discovered the six-class detector; fullimage7masks andROI3masks passed mapping/translation/RLE checks with zeroqueries/writes. Existing24containers unchanged. Deployment receipt: `/data/cvat/data/deployments/argus-outdoor-v1/deployment-20260903.json`. Authenticated browser annotation smoke not performed; gateway verification used fixture image and in-memory task labels. No commits.
