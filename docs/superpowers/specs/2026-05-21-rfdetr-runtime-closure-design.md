# RF-DETR Nuclio Runtime Closure Design

## Goal

Unblock real checkpoint initialization for the RF-DETR crop interactors in:

- `serverless/pytorch/rfdetr/eagle-shape-v5`
- `serverless/pytorch/rfdetr/eagle-stain-v5`

without redesigning the CVAT-side adapter code or requiring full alignment with the bridge workspace's development environment.

## Problem Statement

The current RF-DETR Nuclio folders point at live mounted sources under `/opt/bdd`:

- `/opt/bdd/training-toolkit/src`
- `/opt/bdd/rf-detr/src`

but their function images are provisioned from a thin runtime:

- base image: `pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime`
- extra installs: `pillow`, `pytorch-lightning`, `torchvision`

That image is sufficient for unit tests with mocks, but not for importing and initializing the mounted RF-DETR stack against real checkpoints. Real smoke attempts failed before model initialization due to missing or incompatible runtime dependencies in the function image.

## Non-Goals

- No redesign of `main.py`, `model_handler.py`, `postprocess.py`, or RF-DETR backend logic unless runtime smoke proves a real backend bug.
- No attempt to replicate the entire bridge workspace lockfile inside the Nuclio image.
- No vendoring of RF-DETR or training-toolkit sources into the CVAT repository.
- No cross-project refactor of the bridge workspace packaging.

## Recommended Approach

Use a **function-local dependency closure** for the two RF-DETR Nuclio folders.

Each function image will remain responsible for importing the mounted `/opt/bdd` source tree, but the image provisioning will be expanded so the runtime actually satisfies the import and initialization requirements of those mounted sources.

This keeps the fix isolated to the two Nuclio folders and preserves the existing CVAT integration boundaries:

- mounted bridge repository remains the source of model code and checkpoints
- CVAT-side interactor flow remains unchanged
- only image provisioning changes

## Architecture

The runtime boundary remains:

1. Nuclio starts the RF-DETR function image.
2. `PYTHONPATH` exposes `/opt/bdd/training-toolkit/src` and `/opt/bdd/rf-detr/src`.
3. `rfdetr_backend.py` imports the mounted RF-DETR sources.
4. The backend discovers the best checkpoint from `shape_round1` or `stain_round1`.
5. The model initializes and serves predictions through the existing crop-interactor adapter flow.

The only planned change is the function image build step. The Python adapter files remain the same unless smoke validation reveals a genuine backend defect.

## Runtime Provisioning Strategy

Each RF-DETR Nuclio function manifest should provision three layers explicitly:

### 1. Base image

Keep the current PyTorch-based Nuclio runtime as the initial compatibility target:

- `pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime`

This minimizes deployment churn and isolates the unblock to dependency closure instead of combining it with a runtime-image migration.

### 2. System packages

Install the Linux libraries required by the imported RF-DETR dependency graph, especially the OpenCV/supervision path.

The exact package list should be derived from smoke evidence, but it is expected to include the graphical/runtime libraries needed to import OpenCV in the container.

### 3. Python packages

Install the RF-DETR runtime dependency set needed by the mounted `/opt/bdd` code, not just the packages directly imported by the CVAT adapter.

This includes the missing RF-DETR-side requirements such as:

- `requests`
- `pycocotools`
- `scipy`
- `tqdm`
- `transformers`
- `peft`
- `rf100vl`
- `pydantic`
- `supervision`
- `matplotlib`
- `roboflow`

plus the training-toolkit/runtime support packages that prove necessary for real initialization.

## Versioning Policy

The function image should use **function-local pins** chosen to be compatible with the current Nuclio base image and the mounted RF-DETR source tree.

It does **not** need to match the bridge workspace development lockfile exactly.

The priority order is:

1. real model initialization succeeds inside the function runtime
2. the dependency set is explicit and reproducible
3. the fix stays local to the two Nuclio functions
4. full workspace parity is deferred

If a bridge-workspace package version is incompatible with the current Nuclio base image, the function image may pin a lower compatible version as long as real checkpoint initialization succeeds.

## Error Handling

Runtime failures should remain early and explicit. The desired behavior is:

- missing dependency failures surface during initialization/model load
- version mismatch failures are visible from smoke validation
- request-time failures are avoided whenever possible

No silent fallbacks should be added to mask provisioning problems.

## Verification Plan

The unblock is considered complete only if all of the following succeed:

1. Existing unit tests remain green for:
   - `serverless/pytorch/rfdetr/eagle-shape-v5`
   - `serverless/pytorch/rfdetr/eagle-stain-v5`
2. Real checkpoint initialization succeeds for both folders against:
   - `/opt/bdd/runs/echo-combined-v5/shape_round1`
   - `/opt/bdd/runs/echo-combined-v5/stain_round1`
3. The existing CVAT-side adapter flow remains unchanged.

If real smoke still fails, the next step is to fix the exact failing dependency or version boundary revealed by the smoke output, rather than broadening scope into backend refactors.

## Alternatives Considered

### 1. Upgrade the base image to match the bridge stack more closely

This may become the right long-term direction, but it is a larger change with more deployment risk. It mixes the RF-DETR unblock with a runtime migration.

### 2. Vendor a frozen RF-DETR runtime into the function

This would improve isolation, but it is heavier, harder to maintain, and undermines the goal of using the current bridge RF-DETR work as future reference.

## Success Criteria

This design succeeds when:

- both RF-DETR function images can import the mounted `/opt/bdd` RF-DETR stack
- both real checkpoints initialize successfully
- both existing unit suites remain green
- no CVAT-side backend logic rewrite is required

