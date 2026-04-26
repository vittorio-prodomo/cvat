# SAM3 Interactor Design

## Goal

Implement a **native, image-only SAM3 interactor** in the open-source CVAT codebase that works inside the existing AI Tools interactor flow, coexists with the built-in SAM interactor, and is structured so later SAM3-specific capabilities can be added without reworking the entire integration.

## Scope decisions

- **In scope**
  - Native CVAT interactor integration
  - Image-only segmentation flow
  - Self-hosted Linux deployment with an NVIDIA GPU
  - Manual checkpoint access / authentication if the official model requires it
  - Coexistence with the current SAM interactor
  - Architecture that is easy to extend later for SAM3-specific features

- **Out of scope for the first version**
  - Video tracking
  - Text prompting in the CVAT UI
  - CPU support
  - Replacing the built-in SAM interactor
  - Polishing for upstream PR acceptance as a primary goal

## Research findings that shape the design

1. **Open-source CVAT already has a native interactor path.**
   The repository includes the original Segment Anything interactor under `serverless/pytorch/facebookresearch/sam/nuclio/`, and the frontend/backend already treat interactors as first-class serverless functions.

2. **The current interactor flow is already a strong fit for a minimal SAM3 release.**
   Existing CVAT code sends an image plus point prompts and an optional box prompt to serverless interactors, and renders the returned mask through the current AI Tools flow.

3. **Recent SAM2 work shows a likely extension path, but also shows how fast the scope expands.**
   Upstream pull request `#10476` proposed richer SAM2 interactor behavior such as model selection, crop-region inference, logit feedback, and extra backend plumbing. That confirms the platform can be extended, but also reinforces that a first release should stay smaller.

4. **Official SAM3 deployment is materially heavier than the current built-in SAM interactor.**
   The official `facebookresearch/sam3` project documents a modern CUDA GPU requirement, newer PyTorch/CUDA tooling, and gated checkpoint access through Hugging Face.

5. **Existing community SAM3/CVAT work is not a drop-in native interactor.**
   The community repository `zhixinma/CVAT-SAM3-AI-Tracker` uses a separate FastAPI backend plus a browser userscript/Tampermonkey overlay rather than CVAT's native interactor pipeline. That is useful as evidence of interest, but not as a direct architectural template for this effort.

6. **The old “SAM is a plugin” memory is only partly true.**
   In open-source CVAT, SAM is fundamentally a serverless interactor. The UI does have plugin extension points for extra interactor controls, which likely created the impression that the feature itself was a plugin.

## Architecture

The first version should be implemented as a **new native interactor model** that reuses CVAT's existing interactor flow. The design should be intentionally split into three layers inside the serverless implementation:

1. **CVAT interactor adapter**
   - Accepts CVAT's current request payload:
     - base64-encoded image
     - positive points
     - negative points
     - optional bounding box
   - Performs request validation and prompt normalization.

2. **SAM3 inference wrapper**
   - Owns model initialization, checkpoint loading, device placement, and predictor calls.
   - Hides raw SAM3 API details from the CVAT-facing logic.

3. **Response adapter**
   - Converts raw SAM3 outputs into the response shape CVAT already expects.
   - Keeps the first version minimal while making it possible to expose richer SAM3 behaviors later.

This gives the first release a small product surface while preserving a clear seam for future features such as model selection, iterative refinement state, text prompts, or other SAM3-specific controls.

## Proposed repository shape

Add a new GPU-first serverless function parallel to the existing SAM interactor, for example:

- `serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml`
- `serverless/pytorch/facebookresearch/sam3/nuclio/main.py`
- `serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py`

Depending on how much shared logic emerges during implementation, it may also make sense to add a small helper module in that same directory for request/response adaptation.

The rest of CVAT should ideally need little or no product-code change if the function:

- advertises itself as `type: interactor`,
- declares compatible interactor metadata,
- returns a mask/result shape that current CVAT code can already render.

## Data flow

1. The user opens the annotation page and selects **SAM3** from the existing interactor dropdown.
2. The current AI Tools UI sends the normal interactor request payload.
3. CVAT backend lambda routing forwards the request to the SAM3 serverless function.
4. The SAM3 handler:
   - decodes the image,
   - converts prompts into the format SAM3 expects,
   - runs image segmentation inference,
   - receives one or more candidate masks and scores.
5. The response adapter picks the initial result deterministically, most likely the highest-confidence mask.
6. The adapter converts that result into the current CVAT interactor response format.
7. The frontend renders the returned mask exactly as it does for other interactors.

The important design choice is to keep the **raw SAM3 predictor output internal** for now. That preserves a clean path for later enhancements without making the first release depend on them.

## Coexistence strategy

SAM3 should **coexist** with the current built-in SAM interactor rather than replacing it.

Benefits:

- lower migration risk for the fork,
- easier side-by-side comparison,
- no need to break or rename the current SAM experience,
- natural future path where users choose between lightweight SAM and heavier SAM3.

## Deployment model

The first version should be documented and designed as:

- **self-hosted**
- **Linux**
- **NVIDIA GPU available**
- **manual checkpoint/auth setup accepted**

This integration should not pretend to support CPU fallback if that is not realistically usable. The deployment story should be honest about the heavier runtime profile compared with the existing SAM1 serverless function.

## Error handling

The first version should fail explicitly and diagnostically when prerequisites are not met.

Main failure classes:

1. **Bootstrap failures**
   - missing checkpoint
   - missing or invalid authentication
   - unsupported CUDA / PyTorch environment
   - model-load out-of-memory

2. **Request-time failures**
   - malformed prompt payload
   - inference timeout
   - runtime out-of-memory
   - unsupported image/prompt combination

3. **Conversion failures**
   - SAM3 output cannot be converted into the CVAT interactor response contract

Design requirement:

- do **not** silently fall back to another model or degraded behavior;
- return clear, deployment-relevant errors so the existing CVAT error path helps the operator debug the setup.

## Extension path for later SAM3-specific capabilities

The first release should not implement these, but the design should keep them straightforward to add:

- model variant selection
- crop-region inference
- iterative refinement / state feedback
- text prompts
- richer post-processing controls

The adaptation boundary inside the serverless function is what makes this possible. Future features should extend the adapter contract rather than force a rewrite of the minimal integration.

## Testing strategy

Testing should verify the **integration contract**, not the intrinsic quality of SAM3 itself.

### Automated tests

1. **Lambda metadata tests**
   - CVAT can discover the function as an interactor.
   - The function exposes expected metadata and versioning.

2. **Backend contract tests**
   - Existing lambda manager/backend paths continue accepting the normal interactor request shape.
   - No regression is introduced in how CVAT routes interactor calls.

3. **Handler conversion tests**
   - Prompt adaptation from CVAT request format to SAM3 call format is correct.
   - Response adaptation from SAM3 mask output back to CVAT format is deterministic and valid.

### Manual validation

Use a GPU-enabled local environment to verify:

- model loads successfully,
- the interactor appears in CVAT,
- a point/box-guided interaction returns a mask in the current AI Tools flow,
- the new interactor can coexist with the old SAM interactor.

## Upstreamability assessment

This design intentionally optimizes for a **personal fork first**. That is the right choice because:

- upstream appears to reserve some newer SAM capabilities for hosted / enterprise offerings,
- the current open issue requesting SAM3 deployment indicates user interest but not a committed upstream direction,
- the recent SAM2 enhancement PR was closed quickly and did not establish a merge path.

Still, this design preserves some optional upstream value:

- it keeps the first version minimal,
- uses native CVAT architecture,
- avoids sidecar/userscript coupling,
- and isolates heavier SAM3-specific logic mostly to the new serverless function.

## Recommended next step

Write an implementation plan for **Approach 1: native minimal SAM3 interactor**, starting from:

1. exact files to create under `serverless/`,
2. whether any backend/frontend code must change at all for the first version,
3. deployment docs for the GPU-only setup,
4. contract tests and manual validation steps.
