# RF-DETR Interactor Inference Threshold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session **Inference threshold** control to the three RF-DETR interactors so CVAT sends a request-level server-side confidence threshold for each invocation.

**Architecture:** Reuse CVAT's existing `extra_params_schema` / `extra_params` contract instead of inventing a new interactor-only path. Add a shared schema-driven parameter form in the frontend, wire it into `tools-control`, and consume the flattened payload in the RF-DETR serverless handlers while keeping the existing client-side post-response confidence filter unchanged.

**Tech Stack:** React + TypeScript + Ant Design, CVAT core lambda API wrappers, Django REST lambda-manager tests, Python Nuclio handlers/backends, pytest, Cypress

---

## File map

- Create: `cvat-ui/src/components/common/model-extra-params-form.tsx`  
  Shared schema-driven form renderer plus a helper for building default param values. Reused by the detector runner and the interactor panel so this feature does not fork the UI logic.

- Modify: `cvat-ui/src/components/common/styles.scss`  
  Add stable layout classes for the shared parameter form rows so detector and interactor UIs render the same control structure.

- Modify: `cvat-ui/src/components/model-runner-modal/detector-runner.tsx`  
  Replace the inline detector-only extra-params block with the shared form component and shared defaults helper.

- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx`  
  Hold interactor `extra_params` state, reset it on interactor switch, render the new form, and include `extra_params` in `core.lambda.call(...)`.

- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/styles.scss`  
  Add spacing for the interactor parameter block if the shared form needs a wrapper-specific margin in the tools popover.

- Modify: `tests/cypress/e2e/features2/rfdetr_combined_interactor.js`  
  Extend the mocked combined interactor model with `extra_params_schema`, edit the threshold in the UI, and assert the outgoing request body contains `extra_params.confidence_threshold`.

- Modify: `cvat/apps/lambda_manager/tests/assets/functions.json`  
  Add `extra_params_schema` to the combined RF-DETR interactor fixture so the API metadata tests exercise the new model contract.

- Modify: `cvat/apps/lambda_manager/tests/test_lambda.py`  
  Assert the combined interactor exposes `extra_params_schema` and that interactor `extra_params` are flattened into the Nuclio payload.

- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml`  
  Declare the `confidence_threshold` schema annotation for the shape interactor.

- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/main.py`  
  Read request-level `confidence_threshold` from the Nuclio event payload and pass it into the handler.

- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py`  
  Validate request-level threshold input, fall back to `MODEL_CONF_THRESHOLD`, and pass the effective threshold to the backend per request.

- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/rfdetr_backend.py`  
  Allow `predict()` to accept an optional request-level threshold override without mutating shared backend state.

- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py`  
  Assert the manifest exposes the new schema annotation and the expected numeric bounds/default.

- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py`  
  Assert `main.handler()` forwards `confidence_threshold` to `ModelHandler.handle(...)`.

- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py`  
  Assert valid overrides are passed to the backend and invalid values fail clearly.

- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/rfdetr_backend.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py`  
  Same responsibilities as the shape folder, but for the stain interactor.

- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/function-gpu.yaml`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/shape_backend.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/stain_backend.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/test_function_gpu.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/test_main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/test_model_handler.py`  
  Declare the shared threshold schema, forward the request-level threshold, validate the range, and ensure both internal backends receive the same effective value.

## Task 1: Lock the API contract for interactor metadata and payload forwarding

**Files:**
- Modify: `cvat/apps/lambda_manager/tests/assets/functions.json`
- Modify: `cvat/apps/lambda_manager/tests/test_lambda.py`
- Test: `cvat/apps/lambda_manager/tests/test_lambda.py`

- [ ] **Step 1: Write the failing API tests**

Add two targeted tests to `cvat/apps/lambda_manager/tests/test_lambda.py`:

```python
    def test_api_v2_lambda_functions_list_includes_combined_rfdetr_threshold_schema(self):
        response = self._get_request(LAMBDA_FUNCTIONS_PATH, self.admin)
        self.assertEqual(response.status_code, status.HTTP_200_OK)

        combined_func = next(
            (f for f in response.data if f["id"] == id_function_interactor_combined),
            None,
        )
        self.assertIsNotNone(combined_func)
        self.assertEqual(
            combined_func["extra_params_schema"],
            [
                {
                    "name": "confidence_threshold",
                    "type": "number",
                    "label": "Inference threshold",
                    "default": 0.2,
                    "min": 0.05,
                    "max": 0.99,
                    "step": 0.01,
                    "description": "Minimum confidence threshold applied during RF-DETR inference.",
                }
            ],
        )

    def test_api_v2_lambda_functions_create_interactor_with_extra_params(self):
        captured_payload = {}

        def capturing_invoke(func, payload):
            captured_payload.update(payload)
            return {"shapes": []}

        with mock.patch(
            "cvat.apps.lambda_manager.views.LambdaGateway.invoke",
            side_effect=capturing_invoke,
        ):
            response = self._post_request(
                f"{LAMBDA_FUNCTIONS_PATH}/{id_function_interactor_combined}",
                self.admin,
                data={
                    "task": self.main_task["id"],
                    "frame": 0,
                    "pos_points": [],
                    "neg_points": [],
                    "obj_bbox": [[10, 10], [100, 100]],
                    "mapping": {"(A13) danno_urto": {"name": "bridge_damage", "attributes": {}}},
                    "extra_params": {"confidence_threshold": 0.35},
                },
            )

        self.assertEqual(response.status_code, status.HTTP_200_OK)
        self.assertAlmostEqual(captured_payload["confidence_threshold"], 0.35)
```

- [ ] **Step 2: Run the targeted Django tests**

Run:

```bash
cd /data/cvat && python manage.py test --settings cvat.settings.testing \
    cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_list_includes_combined_rfdetr_threshold_schema \
    cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_interactor_with_extra_params \
    -v 2
```

Expected: the schema-listing test fails because the combined fixture does not yet expose `extra_params_schema`.

- [ ] **Step 3: Update the combined interactor fixture**

Add `extra_params_schema` to the combined interactor entry in `cvat/apps/lambda_manager/tests/assets/functions.json`:

```json
"extra_params_schema": "[{\"name\":\"confidence_threshold\",\"type\":\"number\",\"label\":\"Inference threshold\",\"default\":0.2,\"min\":0.05,\"max\":0.99,\"step\":0.01,\"description\":\"Minimum confidence threshold applied during RF-DETR inference.\"}]"
```

Keep it inside `metadata.annotations` for `test-rfdetr-combined-with-labels`.

- [ ] **Step 4: Re-run the targeted Django tests**

Run:

```bash
cd /data/cvat && python manage.py test --settings cvat.settings.testing \
    cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_list_includes_combined_rfdetr_threshold_schema \
    cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_interactor_with_extra_params \
    -v 2
```

Expected: PASS for both tests.

- [ ] **Step 5: Commit**

```bash
cd /data/cvat && git add \
    cvat/apps/lambda_manager/tests/assets/functions.json \
    cvat/apps/lambda_manager/tests/test_lambda.py && \
    git commit -m "test: cover RF-DETR interactor extra params contract"
```

## Task 2: Extract a shared schema-driven model parameter form

**Files:**
- Create: `cvat-ui/src/components/common/model-extra-params-form.tsx`
- Modify: `cvat-ui/src/components/common/styles.scss`
- Modify: `cvat-ui/src/components/model-runner-modal/detector-runner.tsx`
- Test: `yarn run type-check`, `yarn workspace cvat-ui run lint`

- [ ] **Step 1: Create the shared form component and defaults helper**

Create `cvat-ui/src/components/common/model-extra-params-form.tsx` with a stable row class and a shared defaults helper:

```tsx
import React from 'react';
import { Row, Col } from 'antd/lib/grid';
import Select from 'antd/lib/select';
import Switch from 'antd/lib/switch';
import InputNumber from 'antd/lib/input-number';
import Divider from 'antd/lib/divider';
import Text from 'antd/lib/typography/Text';
import { QuestionCircleOutlined } from '@ant-design/icons';

import CVATTooltip from 'components/common/cvat-tooltip';
import { clamp } from 'utils/math';

export interface ModelExtraParamSchemaItem {
    name: string;
    type: 'number' | 'boolean' | 'select' | 'number_list';
    label?: string;
    description?: string;
    default?: unknown;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];
}

export function buildExtraParamsDefaults(
    schema: ModelExtraParamSchemaItem[],
): Record<string, unknown> {
    return Object.fromEntries(
        schema.map((param) => [param.name, param.default !== undefined ? param.default : null]),
    );
}

interface Props {
    title?: string;
    schema: ModelExtraParamSchemaItem[];
    values: Record<string, unknown>;
    onChange(name: string, value: unknown): void;
}

export default function ModelExtraParamsForm({
    title = 'Model parameters',
    schema,
    values,
    onChange,
}: Props): JSX.Element | null {
    if (!schema.length) return null;

    return (
        <div className='cvat-model-extra-params'>
            <Divider orientation='left' plain style={{ marginTop: 8, marginBottom: 8 }}>
                <Text strong>{title}</Text>
            </Divider>
            {schema.map((param) => (
                <Row key={param.name} align='middle' className='cvat-model-extra-params-row'>
                    <Col span={12}>
                        <Text>{param.label ?? param.name}</Text>
                        {param.description && (
                            <CVATTooltip title={param.description}>
                                <QuestionCircleOutlined className='cvat-info-circle-icon' />
                            </CVATTooltip>
                        )}
                    </Col>
                    <Col span={12}>
                        {param.type === 'number' && (
                            <InputNumber
                                style={{ width: '100%' }}
                                min={param.min}
                                max={param.max}
                                step={param.step ?? 1}
                                value={values[param.name] as number | null}
                                onChange={(value) => {
                                    if (typeof value !== 'number' || Number.isNaN(value)) {
                                        return;
                                    }

                                    onChange(
                                        param.name,
                                        clamp(
                                            value,
                                            typeof param.min === 'number' ? param.min : value,
                                            typeof param.max === 'number' ? param.max : value,
                                        ),
                                    );
                                }}
                            />
                        )}
                        {param.type === 'boolean' && (
                            <Switch
                                checked={!!values[param.name]}
                                onChange={(checked) => onChange(param.name, checked)}
                            />
                        )}
                        {param.type === 'select' && (
                            <Select
                                style={{ width: '100%' }}
                                value={values[param.name] as string}
                                onChange={(value) => onChange(param.name, value)}
                            >
                                {(param.options ?? []).map((option) => (
                                    <Select.Option key={option} value={option}>
                                        {option}
                                    </Select.Option>
                                ))}
                            </Select>
                        )}
                        {param.type === 'number_list' && (
                            <Select
                                style={{ width: '100%' }}
                                mode='tags'
                                tokenSeparators={[',', ' ']}
                                value={(values[param.name] as string[] | null) ?? []}
                                onChange={(value) => onChange(
                                    param.name,
                                    (value as string[]).map(Number).filter((item) => !Number.isNaN(item)),
                                )}
                                notFoundContent={null}
                            />
                        )}
                    </Col>
                </Row>
            ))}
        </div>
    );
}
```

- [ ] **Step 2: Add shared form spacing styles**

Append these rules to `cvat-ui/src/components/common/styles.scss`:

```scss
.cvat-model-extra-params-row {
    margin-bottom: $grid-unit-size;
    align-items: center;

    .cvat-info-circle-icon {
        margin-left: $grid-unit-size;
    }
}
```

- [ ] **Step 3: Refactor the detector runner to use the shared component**

Replace the inline detector-only schema rendering in `cvat-ui/src/components/model-runner-modal/detector-runner.tsx`:

```tsx
import ModelExtraParamsForm, {
    buildExtraParamsDefaults,
    ModelExtraParamSchemaItem,
} from 'components/common/model-extra-params-form';

// ...
useEffect(() => {
    setExtraParams(
        buildExtraParamsDefaults((model?.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[]),
    );
}, [modelID]);

// ...
{isDetector && (
    <ModelExtraParamsForm
        schema={(model?.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[]}
        values={extraParams}
        onChange={(name, value) => {
            setExtraParams((prev) => ({ ...prev, [name]: value }));
        }}
    />
)}
```

Delete the old duplicated `Divider` / `Row` / `InputNumber` / `Switch` / `Select` block once the shared component compiles cleanly.

- [ ] **Step 4: Run frontend static checks**

Run:

```bash
cd /data/cvat && yarn run type-check && yarn workspace cvat-ui run lint
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /data/cvat && git add \
    cvat-ui/src/components/common/model-extra-params-form.tsx \
    cvat-ui/src/components/common/styles.scss \
    cvat-ui/src/components/model-runner-modal/detector-runner.tsx && \
    git commit -m "refactor: share schema-driven model parameter form"
```

## Task 3: Wire interactor extra params into `tools-control` and prove it in Cypress

**Files:**
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx`
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/styles.scss`
- Modify: `tests/cypress/e2e/features2/rfdetr_combined_interactor.js`
- Test: `tests/cypress/e2e/features2/rfdetr_combined_interactor.js`, `yarn run type-check`, `yarn workspace cvat-ui run lint`

- [ ] **Step 1: Extend the combined interactor Cypress spec with a failing request assertion**

Update `tests/cypress/e2e/features2/rfdetr_combined_interactor.js` so the mocked model declares the schema and the test edits the field before drawing the box:

```javascript
function makeInteractorModel({
    id,
    name,
    labels,
    extraParamsSchema = [],
    startWithBox = true,
    minPosPoints = 0,
    minNegPoints = 0,
    startWithBoxOptional = false,
}) {
    return {
        id,
        name,
        kind: 'interactor',
        description: name,
        version: 2,
        labels_v2: labels.map((label) => ({ name: label, type: 'mask' })),
        extra_params_schema: extraParamsSchema,
        min_pos_points: minPosPoints,
        min_neg_points: minNegPoints,
        startswith_box: startWithBox,
        startswith_box_optional: startWithBoxOptional,
    };
}

const combinedInteractor = makeInteractorModel({
    id: 'test-rfdetr-combined',
    name: 'Mocked RF-DETR combined interactor',
    labels: ['(A13) danno_urto', '(C5) infiltraz_cls'],
    extraParamsSchema: [{
        name: 'confidence_threshold',
        type: 'number',
        label: 'Inference threshold',
        default: 0.2,
        min: 0.05,
        max: 0.99,
        step: 0.01,
    }],
});

const plainInteractor = makeInteractorModel({
    id: 'test-plain-interactor',
    name: 'Mocked plain interactor',
    labels: ['person'],
});

openInteractorsWithModels([combinedInteractor, plainInteractor], 'getCombinedInteractorFunctions');
selectInteractor(combinedInteractor.id);
cy.contains('.cvat-model-extra-params-row', 'Inference threshold').find('input').clear().type('1.2{enter}');
cy.contains('.cvat-model-extra-params-row', 'Inference threshold').find('input').should('have.value', '0.99');
cy.contains('.cvat-model-extra-params-row', 'Inference threshold').find('input').clear().type('0.35{enter}');
cy.intercept('POST', '**/api/lambda/functions/test-rfdetr-combined**', (req) => {
    expect(req.body.extra_params).to.deep.equal({ confidence_threshold: 0.35 });
    req.reply({ statusCode: 200, body: { shapes: [] } });
}).as('combinedInteractorCall');
selectInteractor(plainInteractor.id);
cy.contains('.cvat-model-extra-params-row', 'Inference threshold').should('not.exist');
selectInteractor(combinedInteractor.id);
cy.contains('.cvat-model-extra-params-row', 'Inference threshold').find('input').should('have.value', '0.2');
```

- [ ] **Step 2: Run the Cypress spec to verify it fails**

Run:

```bash
cd /data/cvat/tests && npx cypress run \
    --config baseUrl=https://lambda.the-commander.net \
    --env user=$FIFTYONE_CVAT_USERNAME,password=$FIFTYONE_CVAT_PASSWORD \
    --browser chrome \
    --spec cypress/e2e/features2/rfdetr_combined_interactor.js
```

Expected: FAIL because the interactor UI does not yet render the schema-driven field or send `extra_params`.

- [ ] **Step 3: Add interactor parameter state, reset logic, rendering, and request forwarding**

Update `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx`:

```tsx
import ModelExtraParamsForm, {
    buildExtraParamsDefaults,
    ModelExtraParamSchemaItem,
} from 'components/common/model-extra-params-form';

interface State {
    // ...
    interactorExtraParams: Record<string, unknown>;
}

this.state = {
    // ...
    interactorExtraParams: buildExtraParamsDefaults(
        (props.interactors[0]?.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[],
    ),
};

private setActiveInteractor = (value: string): void => {
    const { interactors } = this.props;
    const [interactor] = interactors.filter((_interactor: MLModel) => _interactor.id === value);
    if (!interactor || this.state.activeInteractor?.id === interactor.id) {
        return;
    }

    this.setState({
        activeInteractor: interactor,
        interactorMapping: null,
        interactorExtraParams: buildExtraParamsDefaults(
            (interactor.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[],
        ),
    });
};

const response = await core.lambda.call(jobInstance.taskId, interactor, {
    ...data,
    job: jobInstance.id,
    ...(interactorMapping !== null ? { mapping: interactorMapping } : {}),
    extra_params: this.state.interactorExtraParams,
}) as InteractorResults;
```

Render the shared form inside `renderInteractorBlock()`:

```tsx
{activeInteractor && (activeInteractor.extraParamsSchema ?? []).length > 0 && (
    <div className='cvat-tools-interactor-extra-params'>
        <ModelExtraParamsForm
            schema={(activeInteractor.extraParamsSchema ?? []) as ModelExtraParamSchemaItem[]}
            values={this.state.interactorExtraParams}
            onChange={(name, value) => {
                this.setState((state) => ({
                    interactorExtraParams: { ...state.interactorExtraParams, [name]: value },
                }));
            }}
        />
    </div>
)}
```

- [ ] **Step 4: Add interactor wrapper spacing if needed**

If the new block sits too close to the switches, append this to `cvat-ui/src/components/annotation-page/standard-workspace/styles.scss`:

```scss
.cvat-tools-interactor-extra-params {
    margin-top: $grid-unit-size * 2;
}
```

- [ ] **Step 5: Re-run Cypress and frontend static checks**

Run:

```bash
cd /data/cvat && yarn run type-check && yarn workspace cvat-ui run lint
cd /data/cvat/tests && npx cypress run \
    --config baseUrl=https://lambda.the-commander.net \
    --env user=$FIFTYONE_CVAT_USERNAME,password=$FIFTYONE_CVAT_PASSWORD \
    --browser chrome \
    --spec cypress/e2e/features2/rfdetr_combined_interactor.js
```

Expected: PASS for the Cypress request assertion and PASS for lint/type-check.  
Important: run Cypress against a routed frontend build that includes the branch changes; otherwise the external URL can serve a stale bundle and hide the new control.

- [ ] **Step 6: Commit**

```bash
cd /data/cvat && git add \
    cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx \
    cvat-ui/src/components/annotation-page/standard-workspace/styles.scss \
    tests/cypress/e2e/features2/rfdetr_combined_interactor.js && \
    git commit -m "feat: send interactor extra params from tools control"
```

## Task 4: Add request-level threshold overrides to the shape and stain RF-DETR interactors

**Files:**
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/rfdetr_backend.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/rfdetr_backend.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py`
- Test: `serverless/pytorch/rfdetr/eagle-shape-v5`, `serverless/pytorch/rfdetr/eagle-stain-v5`

- [ ] **Step 1: Write failing shape/stain tests for manifest metadata and request overrides**

Add/update these assertions in both folders.

`test_function_gpu.py`:

```python
def test_function_gpu_declares_inference_threshold_schema():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'extra_params_schema' in manifest
    assert 'confidence_threshold' in manifest
    assert 'Inference threshold' in manifest
    assert '"default":0.2' in manifest or '"default": 0.2' in manifest
    assert '"min":0.05' in manifest or '"min": 0.05' in manifest
    assert '"max":0.99' in manifest or '"max": 0.99' in manifest
```

`test_main.py`:

```python
class DummyModel:
    def handle(self, *, image, obj_bbox, mapping, confidence_threshold):
        assert confidence_threshold == 0.35
        return []

event = SimpleNamespace(body={
    'image': encode_image(),
    'obj_bbox': [[1, 1], [3, 3]],
    'mapping': {'(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}}},
    'confidence_threshold': 0.35,
})
```

`test_model_handler.py`:

```python
def test_handle_passes_request_conf_threshold_to_backend(monkeypatch):
    received_thresholds = []

    class InspectorBackend:
        def __init__(self, **kwargs):
            pass

        def predict(self, image, conf_threshold=None):
            received_thresholds.append(conf_threshold)
            return []

    monkeypatch.setattr(MODEL_HANDLER_MODULE, 'RFDETRShapeBackend', InspectorBackend)
    handler = ModelHandler()
    handler.handle(
        image=Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8)),
        obj_bbox=[[0, 0], [39, 29]],
        mapping={},
        confidence_threshold=0.35,
    )

    assert received_thresholds == [0.35]

def test_handle_rejects_out_of_range_conf_threshold(monkeypatch):
    monkeypatch.setattr(MODEL_HANDLER_MODULE, 'RFDETRShapeBackend', DummyBackend)
    handler = ModelHandler()

    with pytest.raises(ValueError, match='confidence_threshold'):
        handler.handle(
            image=Image.new('RGB', (40, 30), 'white'),
            obj_bbox=[[0, 0], [39, 29]],
            mapping={},
            confidence_threshold=1.2,
        )

def test_handle_uses_env_default_when_request_threshold_missing(monkeypatch):
    received_thresholds = []

    class InspectorBackend:
        def __init__(self, **kwargs):
            pass

        def predict(self, image, conf_threshold=None):
            received_thresholds.append(conf_threshold)
            return []

    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    monkeypatch.setattr(MODEL_HANDLER_MODULE, 'RFDETRShapeBackend', InspectorBackend)

    handler = ModelHandler()
    handler.handle(
        image=Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8)),
        obj_bbox=[[0, 0], [39, 29]],
        mapping={},
        confidence_threshold=None,
    )

    assert received_thresholds == [0.2]
```

Mirror the same structure in the stain folder with `RFDETRStainBackend`.

- [ ] **Step 2: Run the single-model pytest suites and confirm they fail**

Run:

```bash
cd /data/cvat && \
    (cd serverless/pytorch/rfdetr/eagle-shape-v5 && PYTHONPATH=. pytest -q test_function_gpu.py test_main.py test_model_handler.py) && \
    (cd serverless/pytorch/rfdetr/eagle-stain-v5 && PYTHONPATH=. pytest -q test_function_gpu.py test_main.py test_model_handler.py)
```

Expected: FAIL because the manifests do not expose the schema and the handlers/backends do not yet accept request-level overrides.

- [ ] **Step 3: Implement manifest metadata, main forwarding, handler validation, and backend override support**

In both `function-gpu.yaml` files, add:

```yaml
    extra_params_schema: >-
      [{"name":"confidence_threshold","type":"number","label":"Inference threshold","default":0.2,"min":0.05,"max":0.99,"step":0.01,"description":"Minimum confidence threshold applied during RF-DETR inference."}]
```

In both `main.py` files, forward the flattened payload field:

```python
    confidence_threshold = data.get('confidence_threshold')
    shapes = context.user_data.model.handle(
        image=image,
        obj_bbox=obj_bbox,
        mapping=mapping,
        confidence_threshold=confidence_threshold,
    )
```

In both `model_handler.py` files, validate request input and keep the env default as fallback:

```python
class ModelHandler:
    def __init__(self, *, logger=None):
        self.input_size = int(os.environ.get('MODEL_INPUT_SIZE', '504'))
        self.default_conf_threshold = float(os.environ.get('MODEL_CONF_THRESHOLD', '0.2'))
        # backend init stays here

    def _resolve_conf_threshold(self, confidence_threshold):
        if confidence_threshold is None:
            return self.default_conf_threshold
        try:
            value = float(confidence_threshold)
        except (TypeError, ValueError) as exc:
            raise ValueError('confidence_threshold must be a number between 0.05 and 0.99') from exc
        if not 0.05 <= value <= 0.99:
            raise ValueError('confidence_threshold must be between 0.05 and 0.99')
        return value

    def handle(self, *, image, obj_bbox, mapping, confidence_threshold=None):
        effective_threshold = self._resolve_conf_threshold(confidence_threshold)
        predicted = self.backend.predict(prepared.image, conf_threshold=effective_threshold)
```

In both backend files, make the override explicit and side-effect free:

```python
def predict(self, image: np.ndarray, conf_threshold: float | None = None) -> list[PredictedInstance]:
    self._load_model()
    threshold = self.conf_threshold if conf_threshold is None else conf_threshold
    # ...
    keep = scores > threshold
```

- [ ] **Step 4: Re-run the single-model pytest suites**

Run:

```bash
cd /data/cvat && \
    (cd serverless/pytorch/rfdetr/eagle-shape-v5 && PYTHONPATH=. pytest -q test_function_gpu.py test_main.py test_model_handler.py) && \
    (cd serverless/pytorch/rfdetr/eagle-stain-v5 && PYTHONPATH=. pytest -q test_function_gpu.py test_main.py test_model_handler.py)
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /data/cvat && git add \
    serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml \
    serverless/pytorch/rfdetr/eagle-shape-v5/main.py \
    serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py \
    serverless/pytorch/rfdetr/eagle-shape-v5/rfdetr_backend.py \
    serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py \
    serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py \
    serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py \
    serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml \
    serverless/pytorch/rfdetr/eagle-stain-v5/main.py \
    serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py \
    serverless/pytorch/rfdetr/eagle-stain-v5/rfdetr_backend.py \
    serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py \
    serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py \
    serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py && \
    git commit -m "feat: add request-level threshold overrides to RF-DETR interactors"
```

## Task 5: Add the shared threshold override to the combined RF-DETR interactor

**Files:**
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/function-gpu.yaml`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/shape_backend.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/stain_backend.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/test_function_gpu.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/test_main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-combined-v5/test_model_handler.py`
- Test: `serverless/pytorch/rfdetr/eagle-combined-v5`

- [ ] **Step 1: Write the failing combined-interactor tests**

Extend the combined folder tests with the same manifest/main expectations plus a shared-backend assertion.

`test_function_gpu.py`:

```python
def test_function_gpu_declares_inference_threshold_schema():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'extra_params_schema' in manifest
    assert 'confidence_threshold' in manifest
    assert 'Inference threshold' in manifest
    assert '"default":0.2' in manifest or '"default": 0.2' in manifest
```

`test_main.py`:

```python
class DummyModel:
    def handle(self, *, image, obj_bbox, mapping, confidence_threshold):
        assert confidence_threshold == 0.35
        return []
```

`test_model_handler.py`:

```python
def test_handle_passes_one_request_threshold_to_both_backends(mock_image, mock_bbox, mock_mapping):
    import importlib
    from PIL import Image

    model_handler = importlib.import_module('model_handler')
    handler = model_handler.ModelHandler()

    shape_thresholds = []
    stain_thresholds = []

    handler.shape_backend.predict = lambda image, conf_threshold=None: (
        shape_thresholds.append(conf_threshold) or []
    )
    handler.stain_backend.predict = lambda image, conf_threshold=None: (
        stain_thresholds.append(conf_threshold) or []
    )

    handler.handle(
        Image.fromarray(mock_image),
        mock_bbox,
        mock_mapping,
        confidence_threshold=0.35,
    )

    assert shape_thresholds == [0.35]
    assert stain_thresholds == [0.35]

def test_handle_rejects_invalid_request_threshold(mock_image, mock_bbox, mock_mapping):
    import importlib
    from PIL import Image

    model_handler = importlib.import_module('model_handler')
    handler = model_handler.ModelHandler()

    with pytest.raises(ValueError, match='confidence_threshold'):
        handler.handle(
            Image.fromarray(mock_image),
            mock_bbox,
            mock_mapping,
            confidence_threshold='bad-value',
        )

def test_handle_uses_env_default_when_request_threshold_missing(mock_image, mock_bbox, mock_mapping):
    import importlib
    from PIL import Image

    model_handler = importlib.import_module('model_handler')
    handler = model_handler.ModelHandler()

    shape_thresholds = []
    stain_thresholds = []

    handler.shape_backend.predict = lambda image, conf_threshold=None: (
        shape_thresholds.append(conf_threshold) or []
    )
    handler.stain_backend.predict = lambda image, conf_threshold=None: (
        stain_thresholds.append(conf_threshold) or []
    )

    handler.handle(
        Image.fromarray(mock_image),
        mock_bbox,
        mock_mapping,
        confidence_threshold=None,
    )

    assert shape_thresholds == [0.2]
    assert stain_thresholds == [0.2]
```

- [ ] **Step 2: Run the combined pytest subset and confirm it fails**

Run:

```bash
cd /data/cvat && \
    (cd serverless/pytorch/rfdetr/eagle-combined-v5 && PYTHONPATH=. pytest -q test_function_gpu.py test_main.py test_model_handler.py)
```

Expected: FAIL because the combined manifest and runtime still only use the env-level threshold.

- [ ] **Step 3: Implement the combined manifest and runtime override**

In `function-gpu.yaml`, add the same schema annotation used by the single-model interactors:

```yaml
    extra_params_schema: >-
      [{"name":"confidence_threshold","type":"number","label":"Inference threshold","default":0.2,"min":0.05,"max":0.99,"step":0.01,"description":"Minimum confidence threshold applied during RF-DETR inference."}]
```

In `main.py`, forward the flattened payload field:

```python
    confidence_threshold = data.get('confidence_threshold')
    shapes = context.user_data.model.handle(
        image=image,
        obj_bbox=obj_bbox,
        mapping=mapping,
        confidence_threshold=confidence_threshold,
    )
```

In `model_handler.py`, validate once and pass the same effective value to both backends:

```python
class ModelHandler:
    def __init__(self, logger=None):
        self.input_size = int(os.environ.get('MODEL_INPUT_SIZE', '504'))
        self.default_conf_threshold = float(os.environ.get('MODEL_CONF_THRESHOLD', '0.2'))
        # backend init unchanged

    def _resolve_conf_threshold(self, confidence_threshold):
        if confidence_threshold is None:
            return self.default_conf_threshold
        try:
            value = float(confidence_threshold)
        except (TypeError, ValueError) as exc:
            raise ValueError('confidence_threshold must be a number between 0.05 and 0.99') from exc
        if not 0.05 <= value <= 0.99:
            raise ValueError('confidence_threshold must be between 0.05 and 0.99')
        return value

    def handle(self, image, obj_bbox, mapping, confidence_threshold=None):
        effective_threshold = self._resolve_conf_threshold(confidence_threshold)
        shape_instances = self.shape_backend.predict(prepared.image, conf_threshold=effective_threshold)
        stain_instances = self.stain_backend.predict(prepared.image, conf_threshold=effective_threshold)
```

In both combined backend files, update `predict()` exactly as in Task 4:

```python
def predict(self, image: np.ndarray, conf_threshold: float | None = None) -> list[PredictedInstance]:
    threshold = self.conf_threshold if conf_threshold is None else conf_threshold
    keep = scores > threshold
```

- [ ] **Step 4: Run the full combined-folder pytest suite**

Run:

```bash
cd /data/cvat && (cd serverless/pytorch/rfdetr/eagle-combined-v5 && PYTHONPATH=. pytest -q)
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /data/cvat && git add \
    serverless/pytorch/rfdetr/eagle-combined-v5/function-gpu.yaml \
    serverless/pytorch/rfdetr/eagle-combined-v5/main.py \
    serverless/pytorch/rfdetr/eagle-combined-v5/model_handler.py \
    serverless/pytorch/rfdetr/eagle-combined-v5/shape_backend.py \
    serverless/pytorch/rfdetr/eagle-combined-v5/stain_backend.py \
    serverless/pytorch/rfdetr/eagle-combined-v5/test_function_gpu.py \
    serverless/pytorch/rfdetr/eagle-combined-v5/test_main.py \
    serverless/pytorch/rfdetr/eagle-combined-v5/test_model_handler.py && \
    git commit -m "feat: add shared threshold override to combined RF-DETR interactor"
```

## Task 6: Run full verification across API, frontend, and serverless paths

**Files:**
- No new code files; verification only unless a real bug appears
- Test: Django lambda-manager suite, RF-DETR pytest suites, frontend static checks, Cypress

- [ ] **Step 1: Run the Django lambda-manager suite**

Run:

```bash
cd /data/cvat && python manage.py test --settings cvat.settings.testing cvat.apps.lambda_manager.tests.test_lambda -v 2
```

Expected: PASS.

- [ ] **Step 2: Run all three RF-DETR serverless pytest suites**

Run:

```bash
cd /data/cvat && \
    (cd serverless/pytorch/rfdetr/eagle-shape-v5 && PYTHONPATH=. pytest -q) && \
    (cd serverless/pytorch/rfdetr/eagle-stain-v5 && PYTHONPATH=. pytest -q) && \
    (cd serverless/pytorch/rfdetr/eagle-combined-v5 && PYTHONPATH=. pytest -q)
```

Expected: PASS.

- [ ] **Step 3: Run frontend lint and type-check**

Run:

```bash
cd /data/cvat && yarn run type-check && yarn workspace cvat-ui run lint
```

Expected: PASS.

- [ ] **Step 4: Run the combined interactor Cypress flow against the routed branch build**

Run:

```bash
source /data/projects/bridge_defect_detection/.env && \
cd /data/cvat/tests && \
npx cypress run \
    --config baseUrl=https://lambda.the-commander.net \
    --env user=$FIFTYONE_CVAT_USERNAME,password=$FIFTYONE_CVAT_PASSWORD \
    --browser chrome \
    --spec cypress/e2e/features2/rfdetr_combined_interactor.js
```

Expected: PASS.  
Important: make sure `https://lambda.the-commander.net` is serving the frontend bundle built from the branch under test; a stale or image-only UI will hide the new interactor control even if the code is correct.

- [ ] **Step 5: If verification exposed a real bug, fix it and commit the fix; otherwise stop without creating another commit**

If a real defect appears during Step 1-4, make the smallest safe fix, rerun the failing command, and commit with a specific message such as:

```bash
cd /data/cvat && git add <fixed-files> && git commit -m "fix: correct RF-DETR interactor threshold wiring"
```
