# RF-DETR Crop Interactors Design

## Goal

Prepare two GPU-backed crop-instance-segmentation Nuclio functions that appear as separate interactors in CVAT:

- `serverless/pytorch/rfdetr/eagle-shape-v5`
- `serverless/pytorch/rfdetr/eagle-stain-v5`

Both functions should reuse the existing crop-interactor request/response contract, but load RF-DETR Segmentation models and checkpoints using the conventions already established in `/data/projects/bridge_defect_detection`.

## Scope decisions

- **In scope**
  - Two separate deployable Nuclio interactors visible independently in CVAT
  - RF-DETR Segmentation backend integration for the crop-interactor flow
  - Local host-path mounts for the bridge defect detection project and checkpoints
  - Deterministic checkpoint selection from each run's `checkpoints/` directory
  - Unit tests plus local smoke validation

- **Out of scope**
  - Refactoring the existing Ultralytics crop interactor into a shared multi-backend runtime
  - Exporting new `.pth` artifacts before deployment
  - Full-image sliced inference
  - Upstream/generalized packaging for arbitrary external projects

## Approved design choices

### 1. Deployment shape

The two RF-DETR functions will be **self-contained Nuclio folders** so that:

- Nuclio can deploy them independently without cross-folder packaging tricks
- CVAT can list them as two separate interactors
- each function can carry its own metadata, label spec, and checkpoint path

The folders will mirror the existing crop interactor structure:

- `function-gpu.yaml`
- `main.py`
- `model_handler.py`
- backend-specific RF-DETR loader/inference module
- `postprocess.py`
- local tests

The crop-specific postprocessing logic remains local to each folder rather than trying to share code outside the Nuclio build context.

### 2. Runtime source of truth

The runtime should use the **bridge defect detection project code and conventions** rather than inventing a new RF-DETR loader from scratch.

Each function will mount `/data/projects/bridge_defect_detection` read-only and extend `PYTHONPATH` so the runtime can import:

- `training-toolkit/src`
- `rf-detr/src`

This keeps checkpoint loading, model construction, and RF-DETR behavior aligned with the user's trained environment.

### 3. Checkpoint rule

Checkpoint selection is deterministic and based on the **highest `val/map` checkpoint** found directly under each run's `checkpoints/` directory.

Chosen checkpoints:

- shape: `/data/projects/bridge_defect_detection/runs/echo-combined-v5/shape_round1/checkpoints/epoch=068-map=0.1328.ckpt`
- stain: `/data/projects/bridge_defect_detection/runs/echo-combined-v5/stain_round1/checkpoints/epoch=037-map=0.3146.ckpt`

`best_per_class/` artifacts and `last.ckpt` are not used for these CVAT interactors.

## Product behavior summary

The user flow remains the same as the current crop interactor:

1. The user selects either `eagle-shape-v5` or `eagle-stain-v5` from CVAT's interactor list.
2. The user draws a crop box on the image.
3. CVAT sends the image, crop box, and label mapping to the selected Nuclio function.
4. The function crops and letterboxes the ROI.
5. RF-DETR runs instance-segmentation inference on the crop.
6. Returned masks are clipped to the valid crop region, deduplicated with class-aware IoS NMS, projected back to full-image space, and returned as CVAT RLE masks.
7. CVAT constructs mask annotations using the mapped labels from the response.

This remains a **box-only crop inference helper**, not a SAM-style prompt-refinement interactor.

## Architecture

### 1. Request/response entrypoint

`main.py` keeps the same responsibilities as the existing Ultralytics implementation:

- decode the base64 image
- read `obj_bbox`
- pass `mapping`
- return `{"shapes": ...}` JSON

No RF-DETR-specific logic should live in `main.py`.

### 2. Model handler

`model_handler.py` remains the orchestration layer:

- validate that a bounding box is present
- call crop preprocessing
- invoke the RF-DETR backend on the prepared crop
- clip masks to the valid crop area
- run class-aware IoS NMS
- map backend class names to CVAT labels
- convert projected masks to CVAT RLE

This preserves the current crop-interactor contract and keeps the architecture parallel to the Ultralytics implementation.

### 3. RF-DETR backend adapter

The RF-DETR-specific module is responsible for:

- importing the mounted `training_toolkit` / `rfdetr` code
- constructing the RF-DETR Segmentation model according to the run config conventions
- loading Lightning `.ckpt` weights using the same prefix-stripping logic already used in the bridge defect detection code
- running inference on the prepared crop
- translating raw predictions into normalized instances:
  - `class_name`
  - `score`
  - `mask`

The backend should fail explicitly if:

- the external project mount is missing
- imports from the mounted project fail
- the checkpoint directory does not exist
- no `epoch=...-map=...ckpt` files are present
- the model cannot be initialized from the selected checkpoint

### 4. Crop preprocessing and postprocessing

The RF-DETR functions should preserve the same crop logic already validated for the Ultralytics interactor:

- exact ROI crop from the CVAT bounding box
- aspect-ratio-preserving resize into the configured fixed input size
- padding with the established crop pad color
- valid-region bookkeeping so padding pixels can be clipped away
- projection of binary masks back to full-image coordinates
- final class-aware IoS NMS at the crop-interactor layer

This keeps backend differences limited to model loading and raw prediction extraction.

## Function metadata

Each function must advertise itself as:

- `type: interactor`
- `startswith_box: true`

Each manifest must declare its own label spec so the functions appear in CVAT as separate model choices.

### `eagle-shape-v5` labels

- `(A13) danno_urto`
- `(C1) difetti_esecuzione`
- `(C7) ammaloram_cls`
- `(C8) venatura_ruggine_armature`
- `(C9) fessure_distacchi_corr_staffe`
- `(C10) fessure_distacchi_corr_arm_long`
- `(C13) esposiz_arm_precompress`
- `(C14) danno_urto`
- `(C16) fessure_verticali`
- `(C18) fessure_longitudinali`
- `(C19) fessure_trasversali`

### `eagle-stain-v5` labels

- `(C2) effloresc_essudaz_pop-out`
- `(C5) infiltraz_cls`
- `(C6) superf_bagn_dilav_percolaz`

The help text should continue to describe the feature as a crop-box-driven interactor that creates mapped masks in full-image space.

## Configuration model

Each `function-gpu.yaml` should provide:

- a unique Nuclio function name
- a unique CVAT-visible annotation name
- `PYTHONPATH` including the mounted bridge defect detection sources
- the external project mount
- the run directory or checkpoint directory used by that function
- the model input size and confidence threshold
- GPU resource limit
- `mountMode: volume`

The two functions differ mainly in:

- visible model name
- declared label spec
- selected run/checkpoint directory
- any model-specific env values

## Error handling

The runtime should fail explicitly rather than silently degrading.

### Initialization failures

- missing external project mount
- missing checkpoint directory
- no checkpoint matching the highest-`val/map` selection rule
- RF-DETR import failure
- checkpoint/model incompatibility

### Request-time failures

- missing bounding box
- unreadable image payload
- inference-time backend error
- malformed prediction output

### Result-time behavior

- if no masks survive clipping, mapping, or IoS NMS, return an empty `shapes` list cleanly
- if a class is not present in the incoming mapping, skip that prediction without failing the whole request

## Testing strategy

Testing should mirror the existing crop interactor and focus on runtime contract correctness, not model quality.

### 1. Manifest tests

For each RF-DETR folder:

- assert the manifest declares an interactor
- assert it is box-started
- assert host-path volume mounts and `mountMode: volume` are present
- assert the expected RF-DETR-specific env keys are present

### 2. Handler tests

- `init_context()` stores a model handler
- `handler()` decodes the image and returns `{"shapes": ...}` JSON

### 3. Model-handler tests

- missing weights/checkpoint root fails explicitly
- missing bounding box fails explicitly
- mapped labels are returned as CVAT mask shapes
- unmapped labels are skipped
- tensor-like / torch-like prediction outputs are normalized before numpy use
- highest-`val/map` checkpoint selection picks the deterministic winner

### 4. Backend adapter tests

- checkpoint discovery and map parsing work for real filename shapes
- Lightning checkpoint loading strips the `model.` prefix correctly
- normalized predictions expose class names, scores, and binary masks

### 5. Smoke validation

Local validation should confirm that each folder can:

- import its runtime modules
- initialize the model handler against the mounted project paths
- pass the local unit tests for the Nuclio folder

Full end-to-end CVAT deployment testing can happen after the folders are generated, but the initial milestone is that both Nuclio folders are complete and locally smoke-testable.

## Recommended next step

Write the implementation plan for the approved design:

1. create the two self-contained RF-DETR Nuclio folders
2. add test-first coverage for checkpoint selection and RF-DETR prediction normalization
3. implement the backend adapter and manifests
4. run folder-level smoke tests
