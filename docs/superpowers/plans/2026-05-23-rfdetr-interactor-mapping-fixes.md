# RF-DETR Interactor Mapping Fixes Implementation Plan

> **Status:** SHIPPED on fork-local `develop`.
> **Verified outcome:** `cvat.apps.lambda_manager.tests.test_lambda` currently passes with `67` tests (`6` skipped), and the external interactor Cypress spec passes `7/7` against `https://lambda.the-commander.net`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the RF-DETR interactor mapping flow so the mapper stays editable in the UI and the resolved mapping is always forwarded to the interactor payload.

**Architecture:** Keep the fix split across the two real fault lines. In the frontend, stabilize `ObjectMapper` so auto-mapping is used as initial state but does not overwrite user edits on ordinary rerenders. In the backend, preserve a payload-safe copy of the resolved mapping and explicitly include it in the interactor payload before invoking the function, then verify the end-to-end flow with existing Cypress and lambda-manager regression surfaces.

**Tech Stack:** React/TypeScript, Cypress, Django/Python, pytest-style Django tests, Nuclio-backed interactor payload flow.

---

## File Structure

### Files to modify

- `cvat-ui/src/components/model-runner-modal/object-mapper.tsx`
  - Preserve user-edited mapping state unless the actual mapper inputs change semantically.
- `tests/cypress/e2e/features2/crop_instance_segmentation_interactor.js`
  - Add a regression test that deletes an auto-mapped row and proves the edited mapping is what gets sent.
- `cvat/apps/lambda_manager/views.py`
  - Forward the resolved mapping into the interactor payload without leaking the server-only `md_label` / `db_label` objects.
- `cvat/apps/lambda_manager/tests/assets/functions.json`
  - Add a labeled interactor fixture so the backend default-mapping path can be tested realistically.
- `cvat/apps/lambda_manager/tests/test_lambda.py`
  - Add regression tests that capture interactor payloads with and without explicit mapping.

### File responsibilities

- `object-mapper.tsx` owns the local row-editing state and should decide when to reset from defaults.
- `crop_instance_segmentation_interactor.js` is the existing UI regression surface for mapped multiclass interactors and should stay the only frontend test file touched.
- `views.py` owns mapping resolution and payload construction for serverless functions.
- `functions.json` defines mocked lambda metadata used by `test_lambda.py`.
- `test_lambda.py` should assert what is sent to `LambdaGateway.invoke`, not just response status codes.

## Task 1: Forward resolved interactor mapping in lambda-manager

**Files:**
- Modify: `cvat/apps/lambda_manager/tests/assets/functions.json`
- Modify: `cvat/apps/lambda_manager/tests/test_lambda.py`
- Modify: `cvat/apps/lambda_manager/views.py`

- [ ] **Step 1: Add a labeled interactor fixture and write failing backend tests**

Add a new labeled interactor fixture to `cvat/apps/lambda_manager/tests/assets/functions.json` near the existing `test-openvino-dextr` entry:

```json
"test-openvino-dextr-with-labels": {
  "metadata": {
    "name": "test-openvino-dextr-with-labels",
    "annotations": {
      "name": "DEXTR with labels",
      "spec": "[\n  { \"id\": 0, \"name\": \"person\", \"type\": \"mask\" },\n  { \"id\": 1, \"name\": \"bicycle\", \"type\": \"mask\" },\n  { \"id\": 2, \"name\": \"car\", \"type\": \"mask\" }\n]\n",
      "type": "interactor",
      "version": "2",
      "min_pos_points": "0",
      "min_neg_points": "0",
      "startswith_box": "true"
    }
  },
  "spec": {
    "description": "Deep Extreme Cut with labels"
  },
  "status": {
    "state": "ready",
    "httpPort": 49167
  }
}
```

Then add these tests to `cvat/apps/lambda_manager/tests/test_lambda.py` near `test_api_v2_lambda_functions_create_interactor`:

```python
id_function_interactor_with_labels = "test-openvino-dextr-with-labels"

def test_api_v2_lambda_functions_create_interactor_without_mapping_forwards_default_mapping(self):
    captured_payload = {}

    def capturing_invoke(func, payload):
        captured_payload.update(payload)
        return []

    with mock.patch(
        "cvat.apps.lambda_manager.views.LambdaGateway.invoke",
        side_effect=capturing_invoke,
    ):
        data = {
            "task": self.main_task["id"],
            "frame": 0,
            "pos_points": [[3.45, 6.78]],
            "neg_points": [],
            "obj_bbox": [[10, 10], [100, 100]],
        }
        response = self._post_request(
            f"{LAMBDA_FUNCTIONS_PATH}/{id_function_interactor_with_labels}",
            self.admin,
            data=data,
        )

    self.assertEqual(response.status_code, status.HTTP_200_OK)
    self.assertEqual(set(captured_payload["mapping"]), {"person", "bicycle", "car"})
    self.assertEqual(captured_payload["mapping"]["car"]["name"], "car")

def test_api_v2_lambda_functions_create_interactor_forwards_explicit_mapping(self):
    captured_payload = {}

    def capturing_invoke(func, payload):
        captured_payload.update(payload)
        return []

    with mock.patch(
        "cvat.apps.lambda_manager.views.LambdaGateway.invoke",
        side_effect=capturing_invoke,
    ):
        data = {
            "task": self.main_task["id"],
            "frame": 0,
            "pos_points": [[3.45, 6.78]],
            "neg_points": [],
            "obj_bbox": [[10, 10], [100, 100]],
            "mapping": {
                "car": {"name": "car", "attributes": {}},
            },
        }
        response = self._post_request(
            f"{LAMBDA_FUNCTIONS_PATH}/{id_function_interactor_with_labels}",
            self.admin,
            data=data,
        )

    self.assertEqual(response.status_code, status.HTTP_200_OK)
    self.assertEqual(captured_payload["mapping"], {
        "car": {"name": "car", "attributes": {}},
    })
```

- [ ] **Step 2: Run the backend tests and verify they fail**

Run:

```bash
cd /data/cvat && python manage.py test --settings cvat.settings.testing \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_interactor_without_mapping_forwards_default_mapping \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_interactor_forwards_explicit_mapping \
  -v 2
```

Expected: FAIL because the current interactor path computes mapping but does not add it to the invoke payload.

- [ ] **Step 3: Implement the backend payload fix**

Update `cvat/apps/lambda_manager/views.py` so the payload-safe mapping is preserved before `update_mapping(...)` enriches it with server-only objects:

```python
        if not mapping:
            mapping = make_default_mapping(model_labels, task_labels)
        else:
            validate_labels_mapping(mapping, self.labels, task_labels)

        payload_mapping = deepcopy(mapping)
        mapping = update_mapping(mapping, self.labels, task_labels)
```

Then add `mapping` into the interactor payload branch:

```python
        elif self.kind == FunctionKind.INTERACTOR:
            payload.update(
                {
                    "image": self._get_image(db_task, mandatory_arg("frame")),
                    "pos_points": mandatory_arg("pos_points"),
                    "neg_points": mandatory_arg("neg_points"),
                    "obj_bbox": data.get("obj_bbox", None),
                    "mapping": payload_mapping,
                }
            )
```

- [ ] **Step 4: Re-run the backend tests and verify they pass**

Run:

```bash
cd /data/cvat && python manage.py test --settings cvat.settings.testing \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_interactor_without_mapping_forwards_default_mapping \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_interactor_forwards_explicit_mapping \
  -v 2
```

Expected: both tests PASS.

- [ ] **Step 5: Run the full lambda-manager test file**

Run:

```bash
cd /data/cvat && python manage.py test --settings cvat.settings.testing \
  cvat.apps.lambda_manager.tests.test_lambda -v 2
```

Expected: PASS for the lambda-manager test file.

- [ ] **Step 6: Commit the backend mapping fix**

```bash
cd /data/cvat && git add \
  cvat/apps/lambda_manager/tests/assets/functions.json \
  cvat/apps/lambda_manager/tests/test_lambda.py \
  cvat/apps/lambda_manager/views.py && \
  git commit -m "fix: forward interactor mapping payloads"
```

## Task 2: Preserve user-edited interactor mapping in the UI

**Files:**
- Modify: `tests/cypress/e2e/features2/crop_instance_segmentation_interactor.js`
- Modify: `cvat-ui/src/components/model-runner-modal/object-mapper.tsx`

- [ ] **Step 1: Add a failing Cypress regression for deleting an auto-mapped row**

Add this test to the `Mapped multiclass crop interactor` block in `tests/cypress/e2e/features2/crop_instance_segmentation_interactor.js`:

```javascript
it('Should preserve deleted auto-mapped rows and send the edited mapping', () => {
    openInteractorsWithModels([mappedCropInteractor], 'getEditableMappingFunctions');
    selectInteractor(mappedCropInteractor.id);

    cy.contains('.cvat-runner-label-mapping-row', 'person').within(() => {
        cy.get('.cvat-danger-circle-icon').click();
    });

    cy.contains('.cvat-runner-label-mapping-row', 'person').should('not.exist');

    cy.intercept('POST', '**/api/lambda/functions/test-crop-interactor**', (req) => {
        expect(req.body.mapping).to.have.property('car');
        expect(req.body.mapping).to.have.property('bicycle');
        expect(req.body.mapping).to.not.have.property('person');

        req.reply({
            statusCode: 200,
            body: {
                shapes: [
                    makeMaskShape({ label: 'car', left: 100, top: 100 }),
                ],
            },
        });
    }).as('editedMappingCall');

    startInteraction();
    drawBoxPrompt(100, 100, 300, 300);

    cy.wait('@editedMappingCall');
    finishInteraction();

    cy.get('.cvat-objects-sidebar-state-item').should('have.length', 1);
    cy.get('.cvat-objects-sidebar-state-item').should('contain', 'car');
});
```

- [ ] **Step 2: Run the Cypress spec and verify the new test fails**

Run:

```bash
cd /data/cvat/tests && npx cypress run --browser chrome --spec cypress/e2e/features2/crop_instance_segmentation_interactor.js
```

Expected: FAIL because deleting `person` only flickers and the request still includes the restored auto-mapping.

- [ ] **Step 3: Implement the mapper reset fix**

Update `cvat-ui/src/components/model-runner-modal/object-mapper.tsx` so it resets only when the actual mapper inputs change semantically, not when parent rerenders recreate arrays:

```tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';

const mappingSignature = useMemo(() => JSON.stringify({
    left: leftData.map((item) => getObjectName(item)),
    right: rightData.map((item) => getObjectName(item)),
    defaults: defaultMapping.map(([left, right]) => [getObjectName(left), getObjectName(right)]),
}), [leftData, rightData, defaultMapping, getObjectName]);

const previousSignature = useRef(mappingSignature);

useEffect(() => {
    if (previousSignature.current !== mappingSignature) {
        previousSignature.current = mappingSignature;
        setMapping(defaultMapping);
        setLeftValue(null);
        setRightValue(null);
    }
}, [mappingSignature, defaultMapping]);
```

Keep the existing delete/add behavior unchanged. The fix is to stop treating every rerender as a reset event.

- [ ] **Step 4: Re-run the Cypress spec and verify it passes**

Run:

```bash
cd /data/cvat/tests && npx cypress run --browser chrome --spec cypress/e2e/features2/crop_instance_segmentation_interactor.js
```

Expected: PASS, including the new deletion-persistence regression.

- [ ] **Step 5: Run frontend lint and type-check**

Run:

```bash
cd /data/cvat && yarn workspace cvat-ui run lint && yarn workspace cvat-core run type-check
```

Expected: PASS.

- [ ] **Step 6: Commit the frontend mapper fix**

```bash
cd /data/cvat && git add \
  cvat-ui/src/components/model-runner-modal/object-mapper.tsx \
  tests/cypress/e2e/features2/crop_instance_segmentation_interactor.js && \
  git commit -m "fix: preserve edited interactor label mappings"
```

## Task 3: Verify the real RF-DETR interactor flow after the fixes

**Files:**
- Verify: `cvat-ui/src/components/model-runner-modal/object-mapper.tsx`
- Verify: `cvat/apps/lambda_manager/views.py`
- Verify: `serverless/pytorch/rfdetr/eagle-stain-v5`
- Verify: `serverless/pytorch/rfdetr/eagle-shape-v5`

- [ ] **Step 1: Rebuild local CVAT frontend and backend with the dev overlay**

Run:

```bash
cd /data/cvat && docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build cvat_server cvat_ui
```

Expected: both services rebuild from the current branch sources and become healthy.

- [ ] **Step 2: Redeploy the RF-DETR functions**

Run:

```bash
cd /data/cvat && ./serverless/deploy_gpu.sh serverless/pytorch/rfdetr
```

Expected: both RF-DETR functions redeploy successfully.

- [ ] **Step 3: Confirm the functions are ready**

Run:

```bash
nuctl get function --platform local
```

Expected output includes:

```text
pth-rfdetr-eagle-shape-v5   cvat   ready
pth-rfdetr-eagle-stain-v5   cvat   ready
```

- [ ] **Step 4: Reproduce the original UI flow**

In CVAT:

1. open the job where the stain interactor is available
2. open the interactor popover
3. delete one auto-mapped row and confirm it stays deleted
4. restore or leave the desired mappings
5. run **RF-DETR Eagle Stain v5** on a patch that should contain a stain class

Expected: the mapper no longer flickers rows back into place.

- [ ] **Step 5: Inspect the stain logs**

Run:

```bash
docker logs --since 5m nuclio-nuclio-pth-rfdetr-eagle-stain-v5 2>&1 | tail -n 200
```

Expected: the new request shows `mapping_keys > 0`, and if the model predicts a mapped class, the result is no longer dropped solely because the mapping was empty.

- [ ] **Step 6: Repeat once for shape if needed**

Run:

```bash
docker logs --since 5m nuclio-nuclio-pth-rfdetr-eagle-shape-v5 2>&1 | tail -n 200
```

Expected: analogous request/pipeline/response summaries with a non-empty mapping payload when exact label matches exist.

## Self-Review

- **Spec coverage:** Task 1 fixes and tests the backend payload bug. Task 2 fixes and tests the UI reset bug. Task 3 verifies the real RF-DETR flow and the expected `mapping_keys > 0` outcome in live logs.
- **Placeholder scan:** The plan names exact files, concrete test code, concrete commands, and explicit expected outcomes. No `TBD`, `TODO`, or “similar to above” placeholders remain.
- **Type consistency:** The plan keeps the existing `ServerMapping` payload shape, preserves `ObjectMapper` as the frontend state owner, and uses the existing Cypress interactor spec plus lambda-manager test file instead of inventing new harnesses.
