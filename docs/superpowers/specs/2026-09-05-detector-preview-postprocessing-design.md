# Detector confidence preview and generic postprocessing design

**Date:** 2026-09-05

**Status:** Approved

**Scope:** Interactive 2D detector runs in a CVAT job, plus shared detector-confidence conversion and label-attribute mapping fixes

## Problem

Interactive detector runs currently create annotations as soon as inference returns. An annotator must choose a confidence threshold before seeing the predictions, and correcting a poor threshold requires deleting results and running the detector again. Detector confidence is also lost by CVAT's common result converter, while automatic mapping of the custom `model_confidence` attribute is unreliable because nested React layout effects initialize label and attribute mappings in the wrong order.

CVAT also lacks a generic, class-aware overlap postprocessor. Each Nuclio handler must currently choose whether and how to apply NMS, and CVAT cannot consistently offer NMS, normal NMM, or greedy NMM across interactive detectors.

## Goals

1. Offer an opt-out confidence-preview workflow for interactive detector runs.
2. Preserve the legacy confidence-threshold workflow when confidence preview is disabled.
3. Add an independently configurable CVAT postprocessing step with Disabled, NMS, NMM, and NMM (greedy) methods.
4. Keep preview results temporary until the annotator presses **Done**.
5. Preserve detector confidence as native CVAT `score` and, when declared and mapped, as the existing `model_confidence` text attribute displayed as `model_conf`.
6. Fix automatic attribute mapping so compatible model and task attributes are mapped on the first render.
7. Support every area-bearing 2D detector shape for overlap processing and every supported 2D detector shape in the temporary preview.

## Non-goals

- Adding a preview to task-level, multi-frame automatic annotation.
- Re-running Nuclio inference when the confidence slider changes.
- Reversing NMS or other filtering already performed inside a detector handler.
- Adding postprocessing for tags, skeletons, 3D shapes, points, or polylines.
- Persisting detector-panel settings as user or server preferences.
- Changing existing ROI behavior or detector label mapping rules beyond the attribute-mapping race fix.

## User interface

### Detector setup

The existing detector form keeps its confidence-threshold field. A checkbox labelled **Preview results before adding** appears beside it and is checked by default.

When the checkbox is checked:

- the confidence-threshold field is disabled and visually greyed out;
- CVAT sends `0.10` as the inference confidence threshold;
- successful inference enters temporary preview mode;
- the confidence slider ranges from `0.10` to `1.00` in `0.01` steps and initially selects `0.35`.

When the checkbox is unchecked:

- the confidence-threshold field is editable;
- an empty field is omitted from the inference request, allowing the handler to use its own default;
- an entered value is passed exactly as entered;
- no confidence preview is shown;
- the postprocessed results are created immediately, following the existing detector-run lifecycle.

The checkbox controls only confidence preview. It does not enable or disable overlap postprocessing.

### Postprocessing controls

A compact **Postprocessing** row contains:

- **Method:** Disabled, NMS, NMM, or NMM (greedy); default NMS.
- **Metric:** IoS or IoU; default IoS.
- **Overlap:** a numeric value in the inclusive range `0.00` to `1.00`; default `0.70`.

Selecting **Disabled** greys out and disables Metric and Overlap. The confidence-preview checkbox and confidence filtering continue to work. Selecting any processing method enables Metric and Overlap, regardless of the confidence-preview setting.

Pressing Enter while focus is in a detector setup control invokes **Annotate**, except while a dropdown is open or another control consumes Enter for its normal operation.

### Preview panel

Preview mode uses the approved compact canvas panel. It contains:

- a `visible / raw returned` count;
- the confidence slider and its current numeric value;
- **Cancel** and **Done** actions.

The denominator is the number of mapped shapes returned at the `0.10` inference floor. The numerator is the number currently displayed after confidence filtering and the selected postprocessing method. Results without valid confidence count in both values while they remain displayed.

**Done** creates only the displayed shapes in one annotation-creation operation. **Cancel**, closing AI Tools, selecting a different detector, changing workspace, or navigating away from the frame discards the preview. Temporary preview shapes never enter saved annotations or undo history before **Done**.

Tags returned alongside previewed shapes are held with the preview and committed unchanged on **Done**; **Cancel** discards them with the shapes. A tag-only detector response follows the legacy immediate path because tags do not participate in shape confidence preview or overlap postprocessing.

If inference returns neither mapped shapes nor pass-through tags, CVAT reports that no detections were found and does not enter preview mode.

## Independent behavior matrix

| Confidence preview | Postprocessing | Inference threshold | Result handling |
| --- | --- | --- | --- |
| Enabled | Disabled | `0.10` | Local confidence filtering, temporary preview, Done/Cancel |
| Enabled | NMS/NMM | `0.10` | Local confidence filtering, live postprocessing, temporary preview, Done/Cancel |
| Disabled | Disabled | Omitted when blank; otherwise exact entered value | Existing immediate annotation creation |
| Disabled | NMS/NMM | Omitted when blank; otherwise exact entered value | Postprocess once, then create annotations immediately |

## Data flow

### Confidence preview enabled

1. Validate the detector form and label mapping.
2. Invoke the detector once with a confidence threshold of `0.10` and the existing ROI, mask-conversion, mapping, and extra-parameter values.
3. Convert and map the response while preserving valid detector confidence as native `score`.
4. Retain an immutable raw shape collection and any pass-through tags, scoped to the request and frame.
5. Filter scored results against the current slider value. Always retain results without a valid confidence.
6. Apply the selected postprocessing method to eligible filtered results.
7. Render the derived collection through the temporary canvas interaction layer.
8. Repeat steps 5-7 when the slider changes, without invoking the detector again.
9. On **Done**, create the latest displayed shapes plus pass-through tags. On cancellation, discard the raw shapes, derived shapes, and pending tags.

### Confidence preview disabled

1. Invoke the detector using the legacy threshold contract: omit an empty threshold or send the entered value.
2. Convert and map the response while preserving confidence.
3. Apply the selected postprocessing method once.
4. Create the resulting annotations immediately through the existing path.

Postprocessing settings are CVAT-side controls and are not sent to Nuclio. A handler's existing NMS may therefore run before the optional CVAT postprocessor.

## Confidence contract

The common detector response converter must copy a valid top-level detector `confidence` value into the native annotation `score`. A valid value is a finite number from `0` through `1`, inclusive. Invalid, nonnumeric, nonfinite, or out-of-range values are treated as absent rather than coercing or rejecting the complete detector response.

Objects without valid confidence:

- remain visible at every confidence-slider position;
- do not participate in confidence-ranked NMS or NMM;
- retain their original geometry and order;
- may still be committed.

The converter does not create arbitrary task attributes. When a detector manifest declares `model_confidence`, its response supplies that attribute, and the target task label declares a compatible attribute, automatic mapping must preserve it. The UI continues to display the task attribute as `model_conf`; its persisted and exported name remains `model_confidence`.

The automatic mapping fix must construct a model-label mapping and all unambiguous same-name attribute mappings atomically. It must not depend on a child component effect updating a mapping that the parent has not created yet.

## Postprocessing semantics

Postprocessing groups shapes by their final mapped CVAT label ID. Shapes mapped to different task labels never suppress or merge one another, even if they originated from the same model label.

Only area-bearing shapes with valid confidence participate. Points, polylines, unsupported shapes, and shapes without confidence pass through unchanged. Processing is deterministic. Candidates sort by descending confidence, with original detector-response order as the tie-breaker.

### Metrics

- IoU is `intersection area / union area`.
- IoS is `intersection area / min(area A, area B)`.
- Full containment therefore has IoS `1.0`.
- A pair matches when its metric is greater than or equal to the configured threshold.

The final metric uses actual geometry. Masks use foreground pixels, polygons use filled polygon area, ellipses use their filled area, and rectangles use their rectangular area. Bounding boxes may reject obviously disjoint pairs before exact comparison but must not substitute for the final mask, polygon, or ellipse calculation.

### Disabled

Return eligible and ineligible results unchanged after any confidence filtering.

### NMS

Process each class from highest to lowest confidence. Keep the current highest-confidence shape and suppress every remaining same-class eligible shape whose selected overlap metric with that keeper meets the threshold. Continue until no eligible candidates remain. Size does not decide which result survives.

### NMM

Build the complete same-class overlap graph and merge each connected component. This is transitive: if A matches B and B matches C, all three merge even when A does not directly match C.

### NMM (greedy)

Take the current highest-confidence shape as an anchor and merge only remaining same-class shapes that directly match that anchor. Do not expand the group through matches to newly added members. Remove the group and repeat with the next highest-confidence shape.

### Merged results

- Mask-only groups merge through pixel union.
- Rectangle-only groups become the smallest enclosing rectangle.
- Polygon, ellipse, or mixed area-geometry groups become a union mask so holes and disconnected foreground regions remain representable.
- The merged result receives the maximum confidence in the group as both native `score` and the mapped `model_confidence` value when that attribute exists.
- Its label and all other attributes come from the highest-confidence member.
- Its source order is the highest-confidence member's source order.

If a target label cannot accept the required merged representation, the processor must report the incompatibility and prevent committing that derived result. It must not silently replace NMM with NMS or discard part of the union. NMS remains available because it preserves each surviving shape's representation.

## Frontend architecture

The implementation must keep the following responsibilities separate:

1. **Detector form state** owns confidence-preview enablement and independent postprocessing settings.
2. **Response normalization** exposes mapped, serializable 2D shape records with label ID, shape type, geometry, attributes, confidence, and original response order.
3. **Pure postprocessing module** implements filtering, exact overlap, NMS, NMM, greedy NMM, and merged-output construction without React or canvas dependencies.
4. **Postprocessing worker adapter** sequences requests and responses and rejects stale results.
5. **Detector preview controller** owns the immutable raw pool, current derived pool, request/frame identity, and Done/Cancel lifecycle.
6. **Canvas interaction layer** renders every supported temporary 2D detector shape needed by the preview, extending the existing `put_shapes` behavior beyond masks and polygons.
7. **Annotation commit adapter** converts only the current derived pool into `ObjectState` instances and invokes the existing annotation-creation path once.

The pure processor is shared by preview-enabled and preview-disabled interactive runs. The worker is used for live preview calculations; a preview-disabled run may use the same worker and await one result before immediate creation.

## Responsiveness and stale-work protection

- Slider changes are debounced briefly while remaining visually responsive.
- Geometry processing runs outside the main rendering path.
- Bounding-box rejection precedes expensive exact-overlap calculations.
- Mask operations use encoded or sparse regions where practical rather than allocating full-frame dense masks for every pair.
- Each inference and worker request carries a monotonically increasing sequence identity.
- Only the newest request for the current job and frame may update preview state.
- Navigating away invalidates pending inference and worker responses.

The raw response stays in frontend memory only for the active run and is released after Done, Cancel, navigation, or component teardown.

## Validation and error handling

- The legacy confidence-threshold input preserves its existing accepted range of `0.01` through `1.00`. The overlap input accepts finite values from `0.00` through `1.00` inclusive.
- Invalid visible form values disable **Annotate** and show inline validation.
- Detector transport or handler errors use the existing inference-error presentation and create no annotations.
- A postprocessing worker failure retains the raw pool, disables **Done**, and offers retry and cancel actions. CVAT must not silently commit unprocessed output.
- Unsupported non-area shapes pass through unchanged and do not fail the run.
- Incompatible NMM output representations produce a clear error identifying the affected mapped label and prevent commit.
- An older inference response or postprocessing result cannot replace state belonging to a newer request, detector, job, or frame.

## Testing strategy

### Pure postprocessor tests

- IoU and IoS for disjoint, partial-overlap, identical, and contained shapes.
- Inclusive threshold equality.
- Actual-mask comparison where bounding boxes overlap but foreground does not.
- Polygon and ellipse filled-area comparison.
- Confidence ordering and stable response-order ties.
- Strict isolation by final mapped task label.
- NMS suppression by confidence rather than size.
- Transitive NMM for an A-B-C overlap chain.
- Greedy NMM for the same chain.
- Mask union with holes and disconnected regions.
- Rectangle enclosure and mixed-geometry union-mask output.
- Highest-confidence score and anchor-attribute propagation.
- Pass-through behavior for missing confidence and non-area shapes.

### Converter and mapping tests

- Valid boundary confidence values `0` and `1` populate native `score`.
- Invalid confidence values are treated as absent without rejecting other results.
- A declared and returned `model_confidence` attribute reaches the mapped task attribute.
- Initial automatic mapping contains both label and unambiguous same-name attribute mappings without waiting for nested effects.
- Persisted/exported attribute name remains `model_confidence` while the annotation UI renders `model_conf`.

### UI and lifecycle tests

- Confidence preview is checked by default and disables the legacy threshold field.
- Preview-enabled inference sends `0.10`; its slider starts at `0.35`.
- Preview-disabled blank threshold is omitted; an entered threshold is passed exactly.
- Postprocessing controls remain independent of the preview checkbox.
- Disabled postprocessing greys only Metric and Overlap.
- Slider changes filter first and then recompute the selected method from the immutable raw pool.
- Preview counts reflect displayed and raw mapped results.
- No annotation exists before Done.
- Cancel creates nothing; Done creates exactly the displayed shapes in one operation.
- Preview-disabled postprocessing runs once before immediate creation.
- Frame changes and component teardown discard preview state and reject late results.
- Temporary rendering covers masks, polygons, rectangles, ellipses, points, and polylines even though non-area types bypass overlap processing.

### Live verification before deployment

Use Argus Outdoor v1 and Indoor v3 to verify:

- default preview behavior at inference floor `0.10` and slider value `0.35`;
- live confidence filtering without additional Nuclio calls;
- class-aware NMS, NMM, and greedy NMM using IoS and IoU;
- Disabled postprocessing;
- legacy blank and explicit confidence-threshold paths with preview unchecked;
- populated native scores and visible `model_conf` values after Done;
- Cancel and navigation leave saved annotations unchanged.

Production deployment, including candidate image construction, rollback preparation, service replacement, and live endpoint checks, remains a separate approval boundary after implementation and verification.

## Acceptance criteria

The feature is complete when an annotator can independently choose whether to preview detector results by confidence and whether CVAT should apply Disabled, NMS, NMM, or greedy NMM postprocessing; preview changes require no additional inference; only explicitly accepted preview results become annotations; legacy threshold behavior remains available; overlap processing is class-aware and geometry-correct; and valid detector confidence survives as native score and mapped `model_confidence` data.
