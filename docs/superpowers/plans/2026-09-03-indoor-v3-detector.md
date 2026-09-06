# Indoor v3 detector deployment checklist

User authorized a separate RF-DETR detector deployment named Indoor v3 using the exact epoch 16 checkpoint. Reuse the established Argus architecture: native CVAT detector with instance masks, full-image or native ROI inference, threshold 0.2 default, no sliced inference, no UI or existing-model changes. Worktree feat/indoor-v3-detector; no commits or pushes.

- [x] Verify checkpoint, architecture, input geometry, and 11-class training category order.
- [x] Adapt the existing detector package and tests to Indoor v3; pin checkpoint/config/category hashes and source commits.
- [x] Prepare an isolated build context and read-only deployment copy of the checkpoint using prepare.py.
- [x] Run the focused package tests; strictly load all model tensors and compare candidate inference with the bridge validation pipeline on an indoor image and a crop.
- [x] Build the function image; check real masks, labels, confidence and malformed/empty response contracts.
- [x] Deploy pth-rfdetr-indoor-v3 through nuctl with a function-only manifest on cvat_cvat and one worker.
- [x] Verify Nuclio readiness, CVAT detector discovery and ROI translation, preserving all existing container identities. Save a receipt and report the model ready.

Deployment completed and verified on 2026-09-04 Europe/Rome. Receipt: `/data/cvat/data/deployments/indoor-v3/deployment-20260904.json`. 105 package tests, strict loading of 572 tensors, exact GPU/reference parity for full image and crop, live CVAT label/ROI/RLE mapping, HTTP validation and threshold-one empty results passed. All 25 pre-existing containers unchanged. Browser annotation creation was not performed. No commits or pushes.
