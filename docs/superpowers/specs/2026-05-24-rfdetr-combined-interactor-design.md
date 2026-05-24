# RF-DETR Combined Interactor Design

## Goal

Add a third RF-DETR crop interactor that behaves like a single CVAT model but internally runs both existing RF-DETR interactors on the same user-drawn box:

- `serverless/pytorch/rfdetr/eagle-shape-v5`
- `serverless/pytorch/rfdetr/eagle-stain-v5`

The new interactor should return one combined `shapes` response, using one mapping table that contains the union of both source label sets.

## Scope

This design covers a new standalone Nuclio function for the combined RF-DETR interactor and the minimal CVAT integration needed for it to appear as one interactor model.

Expected user-visible behavior:

1. the user selects one combined RF-DETR interactor in CVAT
2. the user draws one crop box
3. the function runs both RF-DETR models on that same crop, sequentially
4. predictions from both models are merged only when they resolve to the same mapped task label and overlap
5. the response contains one combined set of mask shapes in full-image coordinates

## Non-Goals

- no change to the behavior of the existing `eagle-shape-v5` and `eagle-stain-v5` interactors
- no HTTP orchestration that depends on the two existing Nuclio functions being deployed and reachable
- no partial-success behavior when one backend fails
- no redesign of the interactor mapping UI beyond exposing one new model with one combined source-label list

## Approved design choices

### 1. Deployment shape

The combined interactor will be a **new self-contained Nuclio folder**:

- `serverless/pytorch/rfdetr/eagle-combined-v5`

It will have its own:

- `function-gpu.yaml`
- `main.py`
- `model_handler.py`
- RF-DETR backend modules for shape and stain loading
- merge/postprocess helpers
- local tests

This keeps the feature fork-local and deployable as an independent interactor, without coupling runtime availability to the two existing functions.

### 2. Runtime ownership

The new function will load both RF-DETR checkpoints directly inside the same container rather than calling the existing functions over HTTP.

Reasons:

- CVAT sees one interactor, not an orchestrator with hidden network dependencies
- request failure semantics stay simple and explicit
- the function can prepare the crop once and reuse it for both models
- merge logic can operate on normalized prediction objects before final CVAT-shape serialization

### 3. Mapping model

The new function exposes one model label spec equal to the union of the current shape and stain label sets.

CVAT therefore shows one mapping table covering all source labels from both models. The function uses the resolved mapping to determine the task label of each prediction before merge decisions are made.

### 4. Failure rule

If either backend fails to initialize or fails during request handling, the entire interactor request fails.

The combined interactor must not silently drop one backend and return partial results, because that would make annotations look valid while being incomplete.

## Product behavior summary

1. The user selects `RF-DETR Eagle Combined v5`.
2. The user draws a bounding box on the image.
3. CVAT sends the image, box, and combined mapping table to the new function.
4. The function prepares the crop once.
5. The shape backend runs on the crop.
6. The stain backend runs on the same crop.
7. Each backend's masks are clipped to the valid crop region and projected back to full-image coordinates.
8. Predictions are resolved to mapped task labels.
9. Predictions with different mapped task labels remain separate.
10. Predictions with the same mapped task label are merged only when their masks overlap.
11. The function returns one combined `shapes` list.

## Architecture

### 1. Entrypoint

`main.py` keeps the same narrow responsibility as the existing RF-DETR functions:

- decode the image
- read `obj_bbox`
- read `mapping`
- delegate to the model handler
- return `{"shapes": ...}` JSON

No merge or backend-specific logic should live in `main.py`.

### 2. Combined model handler

`model_handler.py` becomes the orchestration layer for the combined function.

Responsibilities:

- validate the bounding box
- prepare the crop once
- invoke the shape backend
- invoke the stain backend
- clip each returned mask to the valid crop region
- project each surviving mask back to full-image coordinates
- resolve each prediction to a mapped task label
- merge overlapping predictions that share the same resolved task label
- serialize the merged predictions into CVAT mask shapes

The handler should log separate counts for:

- raw shape predictions
- raw stain predictions
- post-clip predictions
- merged groups
- returned shapes

### 3. Backend adapters

The shape and stain backend adapters should keep the same checkpoint-selection and RF-DETR-loading rules already used by the two existing functions.

The new combined function should reuse that logic rather than inventing a different RF-DETR runtime contract. Any helper extraction should stay tightly scoped to what the combined folder needs and should not become a broad refactor of the existing two folders unless that falls out naturally and safely during implementation.

### 4. Merge stage

Merge logic happens **after**:

- crop preparation
- inference
- valid-region clipping
- projection to full-image coordinates
- mapping-resolution to task labels

This ensures merge decisions are based on the labels CVAT will actually use, not on the raw model class names.

## Merge semantics

The word "union" in this design means a label-aware mask union, not a blind flattening of every prediction into one mask.

Rules:

- predictions with different resolved task labels must never merge
- predictions with the same resolved task label but no pixel overlap must remain separate shapes
- predictions with the same resolved task label and any pixel overlap must merge by pixel-wise mask union
- merging is transitive across an overlap-connected group; if A overlaps B and B overlaps C, all three end up in one merged shape when they share the same resolved task label

For each merged group:

- the returned CVAT label is the resolved task label
- the returned mask is the pixel-wise union of all masks in the group
- the score attribute value is the **maximum** score among the contributing predictions

Using the maximum score preserves a single confidence-like value without inventing a new scoring formula.

## Function metadata

The new manifest should advertise:

- `type: interactor`
- `startswith_box: true`
- one combined `spec` containing all source labels from shape and stain
- help text explaining that the interactor runs both RF-DETR models on the same crop and merges overlapping masks for the same mapped label

The function should have a distinct Nuclio metadata name and a distinct CVAT-visible annotation name so users can choose it independently from the two existing interactors.

## Configuration model

`function-gpu.yaml` should keep the same RF-DETR runtime conventions already used by the current shape/stain manifests:

- mounted `/opt/bdd` project path
- `PYTHONPATH` entries for `training-toolkit/src` and `rf-detr/src`
- explicit checkpoint/config env values for both models
- shared crop input size and confidence threshold configuration
- GPU resource limit
- `mountMode: volume`

The combined function needs separate env keys for the two backends, for example:

- shape checkpoint/config path
- stain checkpoint/config path
- shared input size
- shared confidence threshold

If later needed, the design can grow per-backend thresholds, but that is not required for the initial combined interactor.

## Error handling

The combined interactor should fail explicitly rather than degrade silently.

### Initialization failures

- missing external project mount
- missing shape or stain checkpoint directory
- no valid checkpoint in either backend directory
- RF-DETR import failure
- checkpoint/model incompatibility for either backend

### Request-time failures

- missing bounding box
- unreadable image payload
- inference-time failure in either backend
- malformed prediction output from either backend
- merge-stage failure caused by invalid projected masks

### Result-time behavior

- if both backends run successfully but no masks survive clipping, mapping, or merging, return an empty `shapes` list cleanly
- if a prediction's raw class is absent from the incoming mapping, skip that prediction without failing the whole request
- if one backend fails, do not return the other backend's shapes

## Testing strategy

Testing should verify contract behavior and merge correctness, not model quality.

### 1. Manifest coverage

- assert the new manifest declares an interactor
- assert it is box-started
- assert the combined label spec includes both source label families
- assert both backend checkpoint/config env groups are present

### 2. Handler coverage

- `init_context()` stores the combined model handler
- `handler()` decodes the image and returns `{"shapes": ...}` JSON
- missing `obj_bbox` fails explicitly

### 3. Combined-handler coverage

- both backends are invoked on the same prepared crop
- same mapped label + overlap produces one merged shape
- same mapped label + no overlap produces separate shapes
- different mapped labels + overlap still produces separate shapes
- transitive overlap merges an entire connected group
- merged shape score attribute uses the maximum member score
- unmapped predictions are skipped
- one backend failure fails the entire request

### 4. Backend coverage

- existing checkpoint-discovery and model-loading rules still apply
- shape and stain loaders remain independently testable inside the combined folder

### 5. Integration coverage

- lambda-manager model listing recognizes the combined interactor metadata
- browser-level verification confirms the combined interactor appears with one mapping table and can return shapes originating from both backend families in one interaction

## Recommended next step

Write the implementation plan for the approved combined-interactor design:

1. create the new `eagle-combined-v5` Nuclio folder and manifest
2. add tests for dual-backend orchestration and label-aware merge behavior
3. implement the combined model handler and reuse the two RF-DETR backend loaders
4. wire the new function into CVAT model discovery and verification flows
