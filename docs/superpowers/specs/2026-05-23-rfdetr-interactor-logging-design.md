# RF-DETR Interactor Logging Design

## Goal

Add persistent request-summary logging to the RF-DETR shape and stain interactors so that empty-result requests can be traced through the full serverless pipeline without changing inference behavior.

## Scope

This design applies only to:

- `serverless/pytorch/rfdetr/eagle-shape-v5`
- `serverless/pytorch/rfdetr/eagle-stain-v5`

The change is limited to logging in the request entrypoint and the model-handler pipeline. It does not alter model weights, postprocessing math, thresholds, or label mapping behavior.

## Problem Statement

The RF-DETR interactors can now be deployed and invoked from CVAT, but requests may return zero shapes without any traceback or obvious request-time explanation in the container logs.

Current logs are sufficient to confirm that:

- the function container starts correctly
- the interactor is called by CVAT
- the function returns HTTP 200

Current logs are not sufficient to explain where results disappear inside the pipeline.

## Recommended Approach

Add per-request summary logging at two layers:

1. `main.py`
   - log the request boundary
   - log enough input/output context to identify what CVAT sent and what the function returned
2. `model_handler.py`
   - log the filter-stage counts inside the interactor pipeline
   - make it clear whether empty results come from zero predictions, clipping, NMS, unmapped labels, or empty projected masks

This is preferred over backend-only logging because the current debugging need is to identify where shapes disappear across the whole pipeline, not just whether the backend produced predictions.

## Architecture

### Request boundary logging (`main.py`)

Each request should emit concise summary information, including:

- image size
- bounding box presence and coordinates
- mapping key count
- mapped label names or a compact representation of them
- final number of returned shapes

These logs should make it possible to correlate a CVAT interaction attempt with the handler result.

### Pipeline summary logging (`model_handler.py`)

Each request should emit the key stage counts:

- raw predictions returned from backend
- predictions surviving valid-region clipping
- predictions surviving class-aware NMS
- predictions skipped because their class is absent from the request mapping
- predictions skipped because the projected full-image mask is empty
- final number of returned shapes

These counts should identify the exact stage where shapes drop to zero.

## Logging Style

Use per-request summary logs only.

Do not log:

- raw tensors
- masks
- full image payloads
- verbose per-instance dumps by default

The intent is to keep logs readable and stable for ongoing use, not to create temporary debug-only output.

## Non-Goals

- No backend algorithm changes
- No threshold tuning
- No temporary logging guards or feature flags
- No broad refactor of shape/stain interactor structure
- No change to the request or response contract with CVAT

## Error Handling

The logging must be additive only:

- do not swallow exceptions
- do not change current error propagation
- do not add silent fallbacks

If a request fails, the original failure should still surface normally.

## Verification

Success is:

1. both shape and stain interactors emit request-summary logs
2. both shape and stain interactors emit pipeline-stage counts
3. a new interaction attempt makes it obvious whether zero shapes are caused by:
   - zero backend predictions
   - clipping/NMS removal
   - mapping mismatch
   - empty projected masks
4. deployment and inference behavior remain otherwise unchanged

