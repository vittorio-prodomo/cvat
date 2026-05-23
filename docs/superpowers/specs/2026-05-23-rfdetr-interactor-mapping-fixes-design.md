# RF-DETR Interactor Mapping Fixes Design

## Goal

Fix two linked RF-DETR interactor bugs:

1. the UI label-mapping editor resets auto-mapped rows after user edits
2. the backend interactor invoke path can resolve mapping but fail to include it in the payload sent to the function

The result should be a stable, user-editable mapper in CVAT and a function payload that always carries the resolved mapping.

## Scope

This design applies only to the RF-DETR interactor flow as exercised through the shared CVAT interactor mapping UI and lambda-manager interactor invocation path.

Expected user-visible behavior:

- exact name matches can still be auto-filled initially
- users can remove or change those mappings, and the UI must preserve those edits for the active interactor session
- when the interactor request is sent, the function must receive the resolved mapping, whether it came from the UI or from the server-side default mapping fallback

## Problem Statement

Two separate bugs currently combine into one broken experience.

### 1. Mapper UI reset bug

`ObjectMapper` initializes local state from `defaultMapping`, but it also resets local mapping whenever `leftData` or `rightData` changes. In the interactor flow, parent rerenders recreate label arrays, so a delete action briefly updates local state and then gets overwritten by the same auto-mapping. The visible result is a flicker where the row appears to disappear and then returns immediately.

### 2. Interactor payload mapping bug

The lambda-manager interactor call path computes and validates mapping, including server-side default mapping when the request omits one, but the interactor payload branch does not currently add the resolved `mapping` into the payload before invoking the function. As a result, the function can receive an empty mapping even when the UI shows mapped rows or the server computed a valid default mapping.

## Design

### Frontend mapper behavior

The mapper should treat `defaultMapping` as an initialization input, not as a continuously authoritative source after user interaction begins.

Design rules:

- Initialize from auto-mapping when the mapper is first shown for the active interactor
- Preserve user edits across rerenders for the same active interactor session
- Still allow the mapper to reset when the underlying interactor or label set actually changes

The implementation should prefer a narrow fix in the mapper component itself so existing consumers keep working. The reset logic must stop reapplying default mapping on ordinary rerenders caused by parent state updates.

### Backend mapping forwarding

After lambda-manager resolves the mapping to use for an interactor request, it must include that resolved mapping in the payload sent to the function.

Design rules:

- If the request provides an explicit mapping, validate it and send the resolved mapping
- If the request omits mapping or sends an empty mapping, compute the default mapping and send that resolved mapping
- Keep detector and interactor behavior aligned conceptually: the function should receive the mapping it is expected to use

This is a payload-construction fix only. It must not change inference logic, label compatibility rules, or postprocessing behavior.

## Components to Change

### Frontend

- `cvat-ui/src/components/model-runner-modal/object-mapper.tsx`
  - stop unconditional mapping reset on parent rerender
  - preserve user-edited mapping state for the current mapper instance
- possibly `cvat-ui/src/components/model-runner-modal/labels-mapper.tsx`
  - only if a small coordination change is needed to make mapper resets happen on real input changes rather than ordinary rerenders
- existing interactor UI wiring in `interactor-label-mapper.tsx` and `tools-control.tsx` should remain largely unchanged

### Backend

- `cvat/apps/lambda_manager/views.py`
  - ensure resolved mapping is added to the interactor payload before `self.gateway.invoke(...)`

## Testing Strategy

### Frontend regression coverage

Add a regression test proving:

- an auto-mapped row can be deleted
- the deletion persists after the parent update cycle instead of being restored by default mapping

The test should validate the actual mapper behavior, not just internal state.

### Backend regression coverage

Add regression tests proving:

- interactor payloads include mapping when the client explicitly supplies one
- interactor payloads include computed default mapping when the client omits mapping or sends an empty mapping

These tests should inspect the payload passed to `LambdaGateway.invoke`.

## Error Handling

This change is behavior-preserving apart from fixing the broken mapping flow.

- do not change validation rules for label compatibility
- do not add silent fallbacks beyond the existing default mapping behavior
- do not alter how unmapped predictions are filtered inside the function

## Non-Goals

- no redesign of the mapping UI
- no new persistence of mapper choices across page reloads
- no change to label compatibility rules beyond current exact-name auto-mapping
- no inference, threshold, or postprocessing changes in RF-DETR functions

## Verification

Success is:

1. deleting an auto-mapped row in the interactor mapper leaves it removed instead of immediately restoring it
2. an interactor request sends a non-empty mapping payload when exact label matches exist
3. the RF-DETR function logs show `mapping_keys > 0` for a matching-label task without requiring manual remapping
4. predicted instances are no longer dropped solely because the mapping payload was empty
