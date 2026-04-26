# Crop Instance Segmentation Interactor Design

## Goal

Implement a **native CVAT interactor** for local instance-segmentation models that works by letting the user draw a crop box on a high-resolution image, running inference only on that crop, and creating the returned masks back in the full-image coordinate space.

The first version is optimized for a **personal CVAT fork** and a local deployment model where weights and configs live on the filesystem. It should support multiple deployed model variants, feel like a normal CVAT interactor inside **AI Tools**, and reuse as much of the existing interactor flow as possible without pretending the models accept SAM-style point prompts.

## Scope decisions

- **In scope**
  - Native CVAT interactor integration
  - Box-only crop-driven interaction
  - 2D image tasks/jobs
  - Multiple returned masks per interaction
  - Multiclass predictions with label mapping
  - Multiple deployed model variants visible as separate interactor choices
  - Local filesystem weights/config paths
  - Generic backend support for:
    - Ultralytics YOLO segmentation
    - RF-DETR instance segmentation
    - Mask2Former

- **Out of scope for the first version**
  - Point prompts
  - Full-image sliced inference
  - Remote checkpoint downloads
  - Video tracking
  - Hosted/upstream packaging as a primary goal

## Product behavior summary

The interactor should behave as a **crop inference helper**, not as a prompt-refinement tool like SAM or SAM3.

Expected user flow:

1. The user opens **AI Tools** and selects one of several deployed crop-interactor variants.
2. The interactor panel shows label mapping for the selected model variant.
3. The user enters interaction mode and draws a **bounding box**.
4. CVAT sends the image and the selected crop box to the serverless function.
5. The function crops the region, preprocesses it for the selected backend, runs inference, and returns multiple masks with class identity and confidence.
6. CVAT previews those masks, allows post-result confidence filtering, and then creates annotations back in the full image using the mapped CVAT labels.

This interactor is **always box-started** in the first version. The UI should not expose the usual optional point-based interaction mode for this model family.

## Architecture

The implementation should be split into five clear layers.

### 1. Generic crop-interactor serverless function

Add a new serverless interactor family parallel to the recent SAM3 work, but make it explicitly model-agnostic.

Responsibilities:

- accept CVAT interactor requests
- decode the image
- validate the crop box
- receive label-mapping selections
- call the selected backend adapter
- return normalized interactor shapes

The same codebase should back multiple deployed model variants. Different Nuclio function deployments can point to different model families, weights, configs, labels, and preprocessing settings while still sharing the same runtime contract.

### 2. Backend adapter layer

Inside the function, define a shared backend interface such as:

`predict(crop_image) -> instances`

Normalized instance output:

- `class_name`
- `score`
- `binary_mask`

Concrete adapters should exist for:

- Ultralytics YOLO segmentation
- RF-DETR instance segmentation
- Mask2Former

Each adapter owns:

- model/config loading from local paths
- backend-specific inference calls
- translation from raw backend outputs into the normalized instance format

### 3. Crop preprocessing and mask postprocessing

This layer is the heart of the feature.

Preprocessing responsibilities:

- extract the exact crop from the user-drawn CVAT box
- preserve aspect ratio
- resize to the configured model input size
- use padding rather than stretching when a fixed-size canvas is required

Padding requirements:

- fixed padding color must be **`rgb(147, 147, 149)`**
- preprocessing must also track the **valid crop region** so padding is explicitly distinguishable from real crop content

Postprocessing responsibilities:

- map masks from model-space back into crop-space and then full-image-space
- clip every predicted mask against the valid crop region
- drop predictions that end up empty after clipping
- keep the non-padded portion when a prediction crosses the crop/padding boundary
- run one final **class-aware NMS pass using IoS threshold 0.8**

Important rule:

- backend-native postprocessing is allowed to happen first
- the crop interactor then applies its own final normalized IoS NMS so behavior remains consistent across YOLO, RF-DETR, and Mask2Former

### 4. Interactor-side label mapping

The interactor panel should include a **label mapping UI** analogous to the existing detector runner mapping.

Design rules:

- mapping is from **model output labels -> CVAT task labels**
- exact-name automapping should be attempted first
- the user can override mappings before running crop inference
- returned masks use the **mapped model-predicted class**, not the currently active CVAT label

If a predicted model class is not mapped:

- skip that returned instance
- surface a warning/summary in the UI
- do not fail the whole request

### 5. CVAT interactor response extension

CVAT already supports the interactor response shape `result.shapes[]`, but the current client construction flow still assumes one active label for the created objects.

This feature therefore needs a small extension:

- each returned interactor shape must be able to carry **per-shape class identity**
- the client must construct objects using the mapped model label for each shape rather than stamping all shapes with the selected active label

A legacy-compatible design is:

- keep supporting old interactors that return a single `mask`
- keep supporting existing `shapes[]` responses
- add an optional per-shape class field for the new crop interactor path
- if the field is absent, preserve current active-label behavior

## Deployment model

Multiple deployed model variants should appear as separate choices in the **AI Tools > Interactors** list.

Each deployed function can vary by:

- backend family
- weights path
- config path
- declared model labels
- input size / preprocessing settings

The initial deployment story is intentionally local and explicit:

- weights/configs come from local filesystem paths on the host/container
- no automatic remote downloads
- no fallback to other backends or other weights

## Confidence handling

Confidence filtering should intentionally separate **backend permissiveness** from **annotation-time user filtering**.

Rules:

- backend candidate threshold defaults to **0.2**
- returned shapes include per-shape confidence
- CVAT reuses its existing post-result interactor confidence slider
- slider default remains **0.5**
- slider range remains **0.2–0.9**

This means the backend returns a permissive candidate set, while the user can still tighten or relax the final visible/constructible masks after seeing the crop result.

## Error handling

The first version should fail explicitly and diagnostically.

### Initialization failures

- missing local weights
- missing config
- unsupported backend family
- import/runtime dependency failure
- invalid declared model labels

### Request-time failures

- invalid crop box
- unreadable image/crop
- backend inference failure
- malformed backend output that cannot be converted into masks

### Result-time behavior

- if no predictions survive thresholding, mapping, clipping, or final IoS NMS, return an empty result cleanly
- never silently fall back to another backend, another model variant, or another weight set

Tooltip/help text should explicitly tell the user that this is a **crop inference helper**, not a point-prompt refinement tool.

## Testing strategy

Testing should verify the integration contract and the crop-specific behavior rather than model quality.

### 1. Backend adapter unit tests

- normalize outputs from each backend family into `{class_name, score, binary_mask}`
- validate local-path configuration and explicit initialization failures

### 2. Crop/postprocessing unit tests

- crop extraction and coordinate remapping back to full image
- aspect-ratio-preserving resize plus padding bookkeeping
- padding color behavior
- clipping of mask pixels that fall in padding
- dropping masks that exist only in padding
- preserving masks that partially overlap valid crop content
- final class-aware IoS NMS behavior
- mapping and confidence filtering behavior

### 3. CVAT interactor contract tests

- interactor can return multiple shapes
- shapes carry per-shape class identity and confidence
- legacy interactor responses still work
- the client constructs annotations using mapped model labels rather than the single active label

### 4. UI tests

- interactor sidebar shows multiple deployed crop-model variants
- box-only interaction starts cleanly with no point mode
- label mapping UI appears in the interactor panel
- post-result confidence slider works with returned confidences

### 5. Manual validation

Use at least:

- one YOLO-based variant
- one non-YOLO variant (RF-DETR or Mask2Former)

Manual checks:

- draw a crop on a high-resolution image
- verify masks are created only inside the crop ROI
- verify mapped labels are preserved
- verify padding-only predictions are dropped
- verify boundary-crossing predictions are clipped correctly

## Upstreamability assessment

This is primarily a **personal-fork feature**. The design intentionally optimizes for local workflows with custom locally hosted models and explicit deployment-time configuration.

Still, the design keeps the CVAT-facing pieces relatively clean:

- native interactor UX
- reuse of existing interactor confidence behavior
- reuse of the detector-style label mapping concept
- backward-compatible extension of the interactor response contract

That keeps future upstream discussion possible, even though upstreamability is not the main goal of the first version.

## Recommended next step

Write an implementation plan for a **generic crop-driven instance-segmentation interactor** that:

1. defines the new serverless function family and adapter structure,
2. identifies the CVAT UI/core changes needed for per-shape model labels in interactor responses,
3. reuses or adapts the existing label-mapper UI for the interactor panel,
4. and specifies test coverage for crop remapping, padding clipping, multiclass creation, and backend adapters.
