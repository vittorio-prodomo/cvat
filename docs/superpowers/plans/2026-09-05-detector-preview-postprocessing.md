# Detector Confidence Preview and Generic Postprocessing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add independently configurable confidence preview and class-aware NMS/NMM processing to interactive 2D detector runs while preserving the legacy threshold path and detector confidence.

**Architecture:** Preserve confidence at the lambda conversion boundary, normalize mapped detector shapes in the UI, and process them with a pure sparse-raster algorithm behind a sequenced Web Worker. The job AI Tools controller either previews the derived shapes transactionally or commits them immediately, while the canvas interaction layer renders all supported temporary 2D shapes.

**Tech Stack:** Django REST Framework, Python unittest, React 18 class and function components, TypeScript, Ant Design, Web Workers, SVG.js canvas rendering, Node test runner, Cypress.

---

## Execution setup

The design baseline is committed on `feat/detector-preview-postprocessing` at `d2c43db66`. The approved-status update, tag transaction clarification, and this implementation plan remain uncommitted until the user authorizes the documentation commit. Once authorized, stage only those two documents, commit them, and move the feature branch into an isolated worktree so unrelated untracked files in `/data/cvat` cannot enter task commits:

```bash
git add docs/superpowers/specs/2026-09-05-detector-preview-postprocessing-design.md \
  docs/superpowers/plans/2026-09-05-detector-preview-postprocessing.md
git commit -m "docs: plan detector preview postprocessing"
git switch develop
git worktree add /data/cvat/.worktrees/detector-preview-postprocessing feat/detector-preview-postprocessing
cd /data/cvat/.worktrees/detector-preview-postprocessing
```

Expected: the worktree is on `feat/detector-preview-postprocessing`, the two documents are present in its HEAD, and `git status --short` in the worktree contains no unrelated paths. Existing untracked paths remain only in the main `/data/cvat` checkout.

## File map

- Modify `cvat/apps/lambda_manager/views.py`: normalize detector confidence and preserve whether confidence was present through serializer validation.
- Modify `cvat/apps/lambda_manager/tests/test_lambda.py`: cover numeric, numeric-string, missing, and invalid detector confidence.
- Create `cvat-ui/src/components/model-runner-modal/label-mapping-types.ts`: break mapping types out of the React component so initialization helpers can be tested without React.
- Create `cvat-ui/src/components/model-runner-modal/label-mapping-initialization.ts`: construct label, attribute, and sublabel mappings atomically.
- Modify `cvat-ui/src/components/model-runner-modal/labels-mapper.tsx`: use atomic mapping entries for new automatic mappings.
- Modify `cvat-ui/src/components/model-runner-modal/label-mapping-utils.ts`: import the extracted mapping types.
- Create `cvat-ui/src/components/model-runner-modal/detector-runner-config.ts`: define the independent confidence-preview and postprocessing contracts.
- Modify `cvat-ui/src/components/model-runner-modal/detector-runner.tsx`: render the new controls only for interactive job runs and emit local run options separately from the server body.
- Modify `cvat-ui/src/components/model-runner-modal/styles.scss`: lay out and disable the detector controls without changing task-level modal behavior.
- Create `cvat-ui/src/utils/detector-postprocessing.ts`: implement pure confidence filtering, exact sparse-raster overlap, NMS, transitive NMM, and greedy NMM.
- Create `cvat-ui/src/utils/detector-postprocessing.worker.ts`: run the pure processor off the main thread.
- Create `cvat-ui/src/utils/latest-request-gate.ts`: provide a browser-independent sequence gate for stale worker responses.
- Create `cvat-ui/src/utils/detector-postprocessing-client.ts`: sequence worker requests, reject stale output, retry after worker failure, and dispose cleanly.
- Modify `cvat-canvas/src/typescript/canvasModel.ts`: add rotation to temporary interaction-shape data.
- Modify `cvat-canvas/src/typescript/interactionHandler.ts`: render temporary rectangles, ellipses, polylines, and points in addition to masks and polygons.
- Create `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-preview.tsx`: render the compact portal with count, slider, Retry, Cancel, and Done.
- Create `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-result-adapter.ts`: convert serialized detector results to preview payloads and final `ObjectState` instances.
- Modify `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx`: own detector preview sessions and immediate-versus-preview commit behavior.
- Modify `cvat-ui/src/components/annotation-page/standard-workspace/styles.scss`: style the compact detector preview panel.
- Create `tests/unit/detector-postprocessing.test.ts`: exhaustive pure algorithm tests using Node's built-in test runner.
- Create `tests/unit/label-mapping-initialization.test.ts`: regression test for atomic attribute and nested sublabel initialization.
- Create `tests/unit/detector-runner-config.test.ts`: test the independent option matrix and threshold contract.
- Create `tests/cypress/e2e/features2/detector_preview_postprocessing.js`: exercise the detector form, API body, preview transaction, canvas output, and stale-result protection.

### Task 1: Preserve detector confidence at the lambda boundary

**Files:**
- Modify: `cvat/apps/lambda_manager/tests/test_lambda.py:846-881`
- Modify: `cvat/apps/lambda_manager/views.py:839-920`

- [ ] **Step 1: Write failing API tests for valid and absent confidence**

Add two tests to `LambdaTestCases`. The first uses the existing mocked detector, whose confidences are numeric strings. The second supplies the valid `0` and `1` boundaries plus numeric-string, missing, boolean, nonnumeric, nonfinite, and out-of-range values.

```python
def test_api_v2_lambda_functions_preserves_detector_confidence(self):
    response = self._post_request(
        f"{LAMBDA_FUNCTIONS_PATH}/{id_function_detector}",
        self.admin,
        data={
            "task": self.main_task["id"],
            "frame": 0,
            "mapping": {"car": {"name": "car"}},
        },
    )

    self.assertEqual(response.status_code, status.HTTP_200_OK)
    self.assertEqual(
        [shape.get("score") for shape in response.json()["shapes"]],
        [0.9959098, 0.89535173, 0.59464583, 0.59464583],
    )

def test_api_v2_lambda_functions_omits_invalid_detector_confidence(self):
    values = [0, 1, "0.25", None, True, "not-a-number", "nan", -0.1, 1.1]

    def invoke_with_confidence_cases(func, payload):
        del func, payload
        return [
            {
                "label": "car",
                "type": "rectangle",
                "points": [index, 0, index + 1, 1],
                **({"confidence": value} if value is not None else {}),
            }
            for index, value in enumerate(values)
        ]

    with mock.patch(
        "cvat.apps.lambda_manager.views.LambdaGateway.invoke",
        side_effect=invoke_with_confidence_cases,
    ):
        response = self._post_request(
            f"{LAMBDA_FUNCTIONS_PATH}/{id_function_detector}",
            self.admin,
            data={
                "task": self.main_task["id"],
                "frame": 0,
                "mapping": {"car": {"name": "car"}},
            },
        )

    self.assertEqual(response.status_code, status.HTTP_200_OK)
    shapes = response.json()["shapes"]
    self.assertEqual([shape["score"] for shape in shapes[:3]], [0, 1, 0.25])
    self.assertTrue(all("score" not in shape for shape in shapes[3:]))
```

- [ ] **Step 2: Run the focused tests and verify the failure**

Run:

```bash
python manage.py test --settings cvat.settings.testing \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_preserves_detector_confidence \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_omits_invalid_detector_confidence -v 2
```

Expected: FAIL because the common converter currently inserts the serializer default `score = 1` and ignores top-level `confidence`.

- [ ] **Step 3: Add strict confidence normalization without changing global annotation defaults**

Import `math`, add this helper to `DetectionResultConverter`, and set `shape["score"]` only for valid values:

```python
@staticmethod
def _normalize_confidence(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        confidence = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(confidence) or not 0 <= confidence <= 1:
        return None
    return confidence
```

In `_parse_anno`, immediately after constructing `shape`:

```python
confidence = self._normalize_confidence(anno.get("confidence"))
if confidence is not None:
    shape["score"] = confidence
```

In `convert`, preserve absence across `LabeledDataSerializer`, whose global default must remain unchanged:

```python
score_presence = ["score" in shape for shape in data["shapes"]]
serializer = LabeledDataSerializer(data=data)
serializer.is_valid(raise_exception=True)
validated = serializer.validated_data
for shape, had_score in zip(validated["shapes"], score_presence):
    if not had_score:
        shape.pop("score", None)
return validated
```

- [ ] **Step 4: Run the focused tests and the existing detector conversion tests**

Run the command from Step 2, then:

```bash
python manage.py test --settings cvat.settings.testing \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_detector \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_convert_mask_to_rle \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_detector_with_roi -v 2
```

Expected: all five tests PASS.

- [ ] **Step 5: Commit the confidence slice**

```bash
git add cvat/apps/lambda_manager/views.py cvat/apps/lambda_manager/tests/test_lambda.py
git commit -m "fix(serverless): preserve detector confidence"
```

### Task 2: Initialize label and attribute mappings atomically

**Files:**
- Create: `cvat-ui/src/components/model-runner-modal/label-mapping-types.ts`
- Create: `cvat-ui/src/components/model-runner-modal/label-mapping-initialization.ts`
- Modify: `cvat-ui/src/components/model-runner-modal/labels-mapper.tsx:11-51,270-283`
- Modify: `cvat-ui/src/components/model-runner-modal/label-mapping-utils.ts:5-7`
- Create: `tests/unit/label-mapping-initialization.test.ts`

- [ ] **Step 1: Extract the shared mapping types and write the failing regression test**

Move `AttributeInterface`, `LabelInterface`, `Md2JobAttributesMapping`, `Md2JobLabelsMapping`, and `FullMapping` unchanged into `label-mapping-types.ts`, exporting each type. In `labels-mapper.tsx`, import the types for local use and re-export them so existing consumers such as `detector-runner.tsx` and `interactor-label-mapper.tsx` retain their current import paths:

```typescript
import type {
    AttributeInterface, FullMapping, LabelInterface, Md2JobAttributesMapping, Md2JobLabelsMapping,
} from './label-mapping-types';

export type {
    AttributeInterface, FullMapping, LabelInterface, Md2JobAttributesMapping, Md2JobLabelsMapping,
} from './label-mapping-types';
```

Update `label-mapping-utils.ts` to import directly from `label-mapping-types.ts`; do not change runtime behavior in this extraction step.

Create this Node test:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAutoMappingEntry } from '../../cvat-ui/src/components/model-runner-modal/label-mapping-initialization.ts';

test('builds label, attribute, and skeleton mappings in one value', () => {
    const model = {
        name: 'C2', type: 'skeleton', attributes: [{ name: 'model_confidence', values: [], input_type: 'text' }],
        sublabels: [{
            name: 'corner', type: 'points',
            attributes: [{ name: 'visibility', values: [], input_type: 'text' }],
        }],
    };
    const task = {
        name: 'C2_effloresc', type: 'skeleton', attributes: [{ name: 'model_confidence', values: [], input_type: 'text' }],
        sublabels: [{
            name: 'corner', type: 'points',
            attributes: [{ name: 'visibility', values: [], input_type: 'text' }],
        }],
    };

    const entry = buildAutoMappingEntry(model, task, (left, right) => (
        left.flatMap((source) => right.filter((target) => source.name === target.name).map((target) => [source, target]))
    ));

    assert.equal(entry[2][0][0]?.name, 'model_confidence');
    assert.equal(entry[2][0][1]?.name, 'model_confidence');
    assert.equal(entry[3][0][2][0][0]?.name, 'visibility');
    assert.equal(entry[3][0][2][0][1]?.name, 'visibility');
});
```

- [ ] **Step 2: Run the Node test and verify it fails**

Run:

```bash
node --experimental-strip-types --test tests/unit/label-mapping-initialization.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `label-mapping-initialization.ts`.

- [ ] **Step 3: Implement recursive atomic initialization**

Create `label-mapping-initialization.ts` with this public contract:

```typescript
import type {
    AttributeInterface, FullMapping, LabelInterface, Md2JobAttributesMapping,
} from './label-mapping-types';

type PairLabels = (
    model: LabelInterface[], task: LabelInterface[],
) => [LabelInterface, LabelInterface][];

export function computeAttributesAutoMapping(
    modelAttributes: AttributeInterface[] = [],
    taskAttributes: AttributeInterface[] = [],
): Md2JobAttributesMapping {
    return modelAttributes.flatMap((modelAttribute) => taskAttributes
        .filter((taskAttribute) => modelAttribute.name === taskAttribute.name)
        .map((taskAttribute) => [modelAttribute, taskAttribute]));
}

export function buildAutoMappingEntry(
    modelLabel: LabelInterface,
    taskLabel: LabelInterface,
    pairLabels: PairLabels,
): FullMapping[0] {
    const sublabels = modelLabel.type === 'skeleton' && taskLabel.type === 'skeleton' ?
        pairLabels(modelLabel.sublabels ?? [], taskLabel.sublabels ?? []).map(
            ([modelSublabel, taskSublabel]) => buildAutoMappingEntry(
                modelSublabel, taskSublabel, pairLabels,
            ),
        ) : [];
    return [
        modelLabel,
        taskLabel,
        computeAttributesAutoMapping(modelLabel.attributes, taskLabel.attributes),
        sublabels,
    ];
}
```

In `LabelsMapperComponent`, replace the local attribute helper with the imported helper. In the top-level reducer, keep an existing item unchanged; initialize a new item with:

```typescript
return [...acc, buildAutoMappingEntry(modelLabel, taskLabel, computeLabelsAutoMapping)];
```

Use the same helper when `updateSublabelsMapping` encounters a newly paired sublabel. This ensures child effects can update an already complete parent entry instead of racing its creation.

- [ ] **Step 4: Run the regression test and type-check mapping consumers**

Run:

```bash
node --experimental-strip-types --test tests/unit/label-mapping-initialization.test.ts
./node_modules/.bin/tsc -p cvat-ui/tsconfig.json
```

Expected: PASS and no TypeScript errors.

- [ ] **Step 5: Commit the mapping slice**

```bash
git add cvat-ui/src/components/model-runner-modal/label-mapping-types.ts \
  cvat-ui/src/components/model-runner-modal/label-mapping-initialization.ts \
  cvat-ui/src/components/model-runner-modal/labels-mapper.tsx \
  cvat-ui/src/components/model-runner-modal/label-mapping-utils.ts \
  tests/unit/label-mapping-initialization.test.ts
git commit -m "fix(ui): initialize detector attribute mappings atomically"
```

### Task 3: Add independent detector-run configuration controls

**Files:**
- Create: `cvat-ui/src/components/model-runner-modal/detector-runner-config.ts`
- Create: `tests/unit/detector-runner-config.test.ts`
- Modify: `cvat-ui/src/components/model-runner-modal/detector-runner.tsx:29-58,68-87,161-188,271-296`
- Modify: `cvat-ui/src/components/model-runner-modal/styles.scss:90-125`
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx:2072-2084`

- [ ] **Step 1: Write the failing option-matrix test**

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    DEFAULT_DETECTOR_RUN_OPTIONS,
    buildDetectorRequestThreshold,
    isPostprocessingThresholdValid,
} from '../../cvat-ui/src/components/model-runner-modal/detector-runner-config.ts';

test('preview and postprocessing defaults are independent', () => {
    assert.deepEqual(DEFAULT_DETECTOR_RUN_OPTIONS, {
        previewConfidence: true,
        postprocessing: { method: 'nms', metric: 'ios', threshold: 0.7 },
    });
    assert.equal(buildDetectorRequestThreshold(true, null), 0.1);
    assert.equal(buildDetectorRequestThreshold(false, null), null);
    assert.equal(buildDetectorRequestThreshold(false, 0.62), 0.62);
    assert.equal(isPostprocessingThresholdValid('nms', 0), true);
    assert.equal(isPostprocessingThresholdValid('nms', 1), true);
    assert.equal(isPostprocessingThresholdValid('nms', null), false);
    assert.equal(isPostprocessingThresholdValid('nms', Number.NaN), false);
    assert.equal(isPostprocessingThresholdValid('nms', -0.01), false);
    assert.equal(isPostprocessingThresholdValid('nms', 1.01), false);
    assert.equal(isPostprocessingThresholdValid('disabled', null), true);
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
node --experimental-strip-types --test tests/unit/detector-runner-config.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Define the local run-options contract**

```typescript
export type DetectorPostprocessingMethod = 'disabled' | 'nms' | 'nmm' | 'greedy_nmm';
export type DetectorOverlapMetric = 'iou' | 'ios';

export interface DetectorPostprocessingOptions {
    method: DetectorPostprocessingMethod;
    metric: DetectorOverlapMetric;
    threshold: number;
}

export interface DetectorRunOptions {
    previewConfidence: boolean;
    postprocessing: DetectorPostprocessingOptions;
}

export const DEFAULT_DETECTOR_RUN_OPTIONS: DetectorRunOptions = Object.freeze({
    previewConfidence: true,
    postprocessing: Object.freeze({ method: 'nms', metric: 'ios', threshold: 0.7 }),
});

export function buildDetectorRequestThreshold(preview: boolean, explicit: number | null): number | null {
    return preview ? 0.1 : explicit;
}

export function isPostprocessingThresholdValid(
    method: DetectorPostprocessingMethod,
    threshold: number | null,
): boolean {
    return method === 'disabled' ||
        (typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1);
}
```

- [ ] **Step 4: Render job-only controls and keep server options separate**

Extend `DetectorRunner` with:

```typescript
interface Props {
    // existing properties
    enableInteractiveOptions?: boolean;
    onModelChange?(modelID: string | null): void;
    runInference(model: MLModel, body: object, options?: DetectorRunOptions): void;
}
```

Add local method, metric, and `number | null` overlap-threshold state initialized from `DEFAULT_DETECTOR_RUN_OPTIONS`. Derive `postprocessingValid` with `isPostprocessingThresholdValid`; require it in `buttonEnabled`. When a non-disabled method has an invalid or empty overlap value, render `Overlap must be between 0 and 1` in `.cvat-detector-postprocessing-error` and disable **Annotate**. When `enableInteractiveOptions` is true, render:

```tsx
<Checkbox
    className='cvat-detector-preview-confidence-checkbox'
    checked={previewConfidence}
    onChange={(event) => setPreviewConfidence(event.target.checked)}
>
    Preview results before adding
</Checkbox>
```

Disable the legacy confidence input when `previewConfidence` is true. Render Method, Metric, and Overlap controls in one `.cvat-detector-postprocessing-row`. Disable only Metric and Overlap when Method is `disabled`. Keep the controls absent from the task-level model runner by default.

Assign stable classes to the interactive controls: `.cvat-detector-confidence-threshold`, `.cvat-detector-postprocessing-method`, `.cvat-detector-postprocessing-metric`, and `.cvat-detector-postprocessing-threshold`. Keep `.cvat-detector-preview-confidence-checkbox` on the checkbox wrapper. These classes are the browser-test and styling contract.

At submission, compute the request threshold and pass local options separately. Construct the numeric postprocessing threshold only after validation; use the retained default `0.7` for the irrelevant threshold value when Method is Disabled and the disabled field is empty. The `enableInteractiveOptions` guard is required so the shared task-level runner never inherits the preview default:

```typescript
const effectivePreview = !!enableInteractiveOptions && previewConfidence;
const requestThreshold = buildDetectorRequestThreshold(effectivePreview, detectorThreshold);
const postprocessing: DetectorPostprocessingOptions = {
    method: postprocessingMethod,
    metric: postprocessingMetric,
    threshold: postprocessingThreshold ?? DEFAULT_DETECTOR_RUN_OPTIONS.postprocessing.threshold,
};
const body: AnnotateTaskRequestBody = {
    type: 'annotate_task',
    mapping: serverMapping,
    cleanup,
    conv_mask_to_poly: convertMasksToPolygons,
    ...(requestThreshold !== null ? { threshold: requestThreshold } : {}),
    ...(Object.keys(nonNullExtraParams).length ? { extra_params: nonNullExtraParams } : {}),
    ...(regionOfInterest ? { roi: regionOfInterest } : {}),
};
runInference(model, body, enableInteractiveOptions ? {
    previewConfidence: effectivePreview,
    postprocessing,
} : undefined);
```

Pass `enableInteractiveOptions` only from `ToolsControlComponent.renderDetectorBlock`. The task-level `ModelRunnerDialog` therefore keeps its existing appearance and behavior.

In the model Select handler, call the optional `onModelChange` after updating local `modelID`. `ToolsControl` supplies this callback so choosing another detector invalidates an active preview; the task-level caller omits it.

- [ ] **Step 5: Run tests, type-check, lint, and commit**

```bash
node --experimental-strip-types --test tests/unit/detector-runner-config.test.ts
./node_modules/.bin/tsc -p cvat-ui/tsconfig.json
./node_modules/.bin/eslint \
  cvat-ui/src/components/model-runner-modal/detector-runner-config.ts \
  cvat-ui/src/components/model-runner-modal/detector-runner.tsx \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx
git add cvat-ui/src/components/model-runner-modal/detector-runner-config.ts \
  cvat-ui/src/components/model-runner-modal/detector-runner.tsx \
  cvat-ui/src/components/model-runner-modal/styles.scss \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx \
  tests/unit/detector-runner-config.test.ts
git commit -m "feat(ui): configure detector result processing"
```

Expected: test PASS, type-check and lint exit 0.

### Task 4: Implement exact class-aware postprocessing

**Files:**
- Create: `cvat-ui/src/utils/detector-postprocessing.ts`
- Create: `tests/unit/detector-postprocessing.test.ts`

- [ ] **Step 1: Write table-driven tests for metrics and all four methods**

Define helpers for rectangle and CVAT RLE mask shapes, then cover these exact expectations:

```typescript
import assert from 'node:assert/strict';
import test from 'node:test';
import {
    computeOverlap,
    processDetectorShapes,
    type DetectorShape,
} from '../../cvat-ui/src/utils/detector-postprocessing.ts';

const rectangle = (
    id: number, labelID: number, score: number | undefined, points: number[],
): DetectorShape => ({
    id, label_id: labelID, type: 'rectangle', points, rotation: 0,
    ...(score === undefined ? {} : { score }), attributes: [], sourceIndex: id,
    targetLabelType: 'any',
});

test('IoS is one for containment and IoU uses the union', () => {
    const outer = rectangle(0, 1, 0.9, [0, 0, 10, 10]);
    const inner = rectangle(1, 1, 0.8, [2, 2, 4, 4]);
    assert.equal(computeOverlap(outer, inner, 'ios', { width: 20, height: 20 }), 1);
    assert.equal(computeOverlap(outer, inner, 'iou', { width: 20, height: 20 }), 4 / 100);
});

test('NMS is confidence-ranked, class-aware, and inclusive at the threshold', () => {
    const shapes = [
        rectangle(0, 1, 0.9, [0, 0, 10, 10]),
        rectangle(1, 1, 0.8, [2, 2, 4, 4]),
        rectangle(2, 2, 0.7, [2, 2, 4, 4]),
        rectangle(3, 1, undefined, [3, 3, 5, 5]),
    ];
    const result = processDetectorShapes(shapes, { width: 20, height: 20 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nms', metric: 'ios', threshold: 1 },
    });
    assert.deepEqual(result.map((shape) => shape.id), [0, 2, 3]);
});

test('NMS keeps higher confidence even when it is the smaller shape', () => {
    const result = processDetectorShapes([
        rectangle(0, 1, 0.6, [0, 0, 10, 10]),
        rectangle(1, 1, 0.9, [2, 2, 4, 4]),
    ], { width: 20, height: 20 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nms', metric: 'ios', threshold: 1 },
    });
    assert.deepEqual(result.map((shape) => shape.id), [1]);
});

test('full NMM is transitive while greedy NMM only follows the anchor', () => {
    const chain = [
        rectangle(0, 1, 0.9, [0, 0, 4, 4]),
        rectangle(1, 1, 0.8, [2, 0, 6, 4]),
        rectangle(2, 1, 0.7, [4, 0, 8, 4]),
    ];
    const common = { metric: 'iou' as const, threshold: 0.3 };
    assert.equal(processDetectorShapes(chain, { width: 10, height: 5 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nmm', ...common },
    }).length, 1);
    assert.equal(processDetectorShapes(chain, { width: 10, height: 5 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'greedy_nmm', ...common },
    }).length, 2);
});
```

Append these concrete edge cases:

```typescript
const mask = (id: number, score: number, points: number[]): DetectorShape => ({
    id, label_id: 1, type: 'mask', points, score, attributes: [], sourceIndex: id,
    targetLabelType: 'mask',
});

test('uses stable response order for equal confidence', () => {
    const kept = processDetectorShapes([
        { ...rectangle(4, 1, 0.8, [0, 0, 5, 5]), sourceIndex: 0 },
        { ...rectangle(2, 1, 0.8, [0, 0, 5, 5]), sourceIndex: 1 },
    ], { width: 10, height: 10 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nms', metric: 'ios', threshold: 1 },
    });
    assert.deepEqual(kept.map((shape) => shape.id), [4]);
});

test('filters confidence before overlap grouping and Disabled preserves survivors', () => {
    const input = [
        rectangle(0, 1, 0.9, [0, 0, 6, 6]),
        rectangle(1, 1, 0.2, [1, 1, 5, 5]),
    ];
    for (const method of ['disabled', 'nmm'] as const) {
        const result = processDetectorShapes(input, { width: 10, height: 10 }, {
            confidenceThreshold: 0.35,
            postprocessing: { method, metric: 'ios', threshold: 0.5 },
        });
        assert.deepEqual(result.map((shape) => shape.id), [0]);
    }
});

test('compares mask foreground rather than only bounding boxes', () => {
    const diagonalA = mask(0, 0.9, [0, 1, 2, 1, 0, 0, 1, 1]);
    const diagonalB = mask(1, 0.8, [1, 2, 1, 0, 0, 1, 1]);
    assert.equal(computeOverlap(diagonalA, diagonalB, 'iou', { width: 2, height: 2 }), 0);
});

test('unions a mask hole with a foreground center pixel', () => {
    const ring = mask(0, 0.9, [0, 4, 1, 4, 0, 0, 2, 2]);
    const center = mask(1, 0.8, [1, 1, 2, 1, 4, 0, 0, 2, 2]);
    const [merged] = processDetectorShapes([ring, center], { width: 3, height: 3 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nmm', metric: 'ios', threshold: 0.5 },
    });
    assert.equal(merged.type, 'mask');
    assert.deepEqual(merged.points, [0, 9, 0, 0, 2, 2]);
});

test('rasterizes polygons and rotated ellipses deterministically', () => {
    const polygon: DetectorShape = {
        id: 0, label_id: 1, type: 'polygon', points: [1, 1, 6, 1, 6, 6, 1, 6],
        score: 0.9, rotation: 0, attributes: [], sourceIndex: 0, targetLabelType: 'any',
    };
    const ellipse: DetectorShape = {
        id: 1, label_id: 1, type: 'ellipse', points: [4, 4, 7, 2],
        score: 0.8, rotation: 30, attributes: [], sourceIndex: 1, targetLabelType: 'any',
    };
    assert.equal(computeOverlap(polygon, polygon, 'iou', { width: 10, height: 10 }), 1);
    assert.equal(computeOverlap(ellipse, ellipse, 'ios', { width: 10, height: 10 }), 1);
});

test('encloses rectangle groups and converts mixed groups to a union mask', () => {
    const first = rectangle(0, 1, 0.9, [0, 0, 4, 4]);
    const second = rectangle(1, 1, 0.8, [2, 0, 6, 4]);
    const [box] = processDetectorShapes([first, second], { width: 8, height: 6 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nmm', metric: 'iou', threshold: 0.3 },
    });
    assert.deepEqual(box.points, [0, 0, 6, 4]);
    assert.equal(box.rotation, 0);

    const polygon = {
        ...first, id: 2, type: 'polygon', points: [0, 0, 4, 0, 4, 4, 0, 4], targetLabelType: 'any',
    };
    const [mixed] = processDetectorShapes([polygon, second], { width: 8, height: 6 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nmm', metric: 'iou', threshold: 0.3 },
    });
    assert.equal(mixed.type, 'mask');
});

test('uses maximum confidence and rewrites only its mapped confidence attribute', () => {
    const high = {
        ...rectangle(0, 1, 0.9, [0, 0, 4, 4]),
        attributes: [{ spec_id: 7, value: 'incorrect' }, { spec_id: 8, value: 'anchor' }],
        confidenceAttributeSpecID: 7,
    };
    const low = rectangle(1, 1, 0.8, [2, 0, 6, 4]);
    const [merged] = processDetectorShapes([high, low], { width: 8, height: 6 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nmm', metric: 'iou', threshold: 0.3 },
    });
    assert.equal(merged.score, 0.9);
    assert.deepEqual(merged.attributes, [
        { spec_id: 7, value: '0.9000' }, { spec_id: 8, value: 'anchor' },
    ]);
});

test('passes through missing confidence and non-area shapes', () => {
    const missing = rectangle(0, 1, undefined, [0, 0, 4, 4]);
    const points = { ...missing, id: 1, sourceIndex: 1, type: 'points', points: [2, 2] };
    const polyline = { ...missing, id: 2, sourceIndex: 2, type: 'polyline', points: [0, 0, 4, 4] };
    const result = processDetectorShapes([missing, points, polyline], { width: 5, height: 5 }, {
        confidenceThreshold: 1,
        postprocessing: { method: 'nms', metric: 'ios', threshold: 0 },
    });
    assert.deepEqual(result.map((shape) => shape.id), [0, 1, 2]);
});

test('rejects an NMM union incompatible with the mapped label type', () => {
    const polygon = {
        ...rectangle(0, 1, 0.9, [0, 0, 4, 4]), type: 'polygon',
        points: [0, 0, 4, 0, 4, 4, 0, 4], targetLabelType: 'polygon',
    };
    const ellipse = {
        ...rectangle(1, 1, 0.8, [0, 0, 4, 4]), type: 'ellipse',
        points: [2, 2, 4, 0], targetLabelType: 'polygon',
    };
    assert.throws(() => processDetectorShapes([polygon, ellipse], { width: 6, height: 6 }, {
        confidenceThreshold: 0,
        postprocessing: { method: 'nmm', metric: 'ios', threshold: 0.5 },
    }), /label 1.*mask/i);
});

test('rejects malformed geometry and oversized work regions', () => {
    const malformed = mask(0, 0.9, [0, 2, 0, 0, 2, 2]);
    assert.throws(() => computeOverlap(
        malformed, malformed, 'iou', { width: 3, height: 3 },
    ), /RLE/i);
    assert.throws(() => processDetectorShapes(
        [rectangle(0, 1, 0.9, [0, 0, 9000, 9000])],
        { width: 9001, height: 9001 },
        { confidenceThreshold: 0, postprocessing: { method: 'nmm', metric: 'iou', threshold: 0.5 } },
    ), /64 million pixels/i);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
node --experimental-strip-types --test tests/unit/detector-postprocessing.test.ts
```

Expected: FAIL because `detector-postprocessing.ts` does not exist.

- [ ] **Step 3: Implement the pure public contract and sparse raster representation**

Use these exported types and entry points:

```typescript
import type {
    DetectorOverlapMetric,
    DetectorPostprocessingOptions,
} from '../components/model-runner-modal/detector-runner-config';

export type AreaShapeType = 'mask' | 'polygon' | 'rectangle' | 'ellipse';

export interface DetectorShape {
    id?: number;
    label_id: number;
    type: string;
    points: number[];
    rotation?: number;
    score?: number;
    attributes: { spec_id: number; value: string }[];
    sourceIndex: number;
    targetLabelType: string;
    confidenceAttributeSpecID?: number;
}

export interface FrameSize { width: number; height: number }
export interface ProcessingOptions {
    confidenceThreshold: number | null;
    postprocessing: DetectorPostprocessingOptions;
}

type Span = [number, number]; // inclusive x coordinates
interface SparseRaster {
    left: number;
    top: number;
    right: number;
    bottom: number;
    rows: Span[][]; // row index is y - top; spans are sorted and disjoint
    area: number;
}

export function computeOverlap(
    first: DetectorShape,
    second: DetectorShape,
    metric: DetectorOverlapMetric,
    frame: FrameSize,
): number;

export function processDetectorShapes(
    shapes: DetectorShape[],
    frame: FrameSize,
    options: ProcessingOptions,
): DetectorShape[];
```

Implement the internals with these fixed rules:

1. `normalizeScore` accepts only finite numeric `score` values in `[0, 1]`; missing or invalid scores are ineligible.
2. Filter eligible scored shapes below `confidenceThreshold` before any overlap calculation. Keep every ineligible shape.
3. Partition eligible area shapes by `label_id`; never compare partitions.
4. Rasterize on the native pixel grid using pixel centers. Decode CVAT mask RLE inside its final four-value bounding box. Convert rotated rectangles to four corners before polygon scan conversion. Rasterize polygons with an even-odd scanline fill. Rasterize ellipses by inverse-rotating each candidate pixel center and evaluating the ellipse equation.
5. Store each raster row as merged inclusive x spans. Compute intersection using a two-pointer span walk; compute union as `areaA + areaB - intersection`.
6. Return overlap `0` for disjoint bounding boxes. IoS divides by the smaller nonzero area; IoU divides by union. Two empty areas have overlap `0`.
7. NMS sorts by `score` descending and `sourceIndex` ascending, retaining the keeper and removing matching lower-ranked candidates.
8. NMM builds an undirected threshold graph and merges connected components. Greedy NMM compares every remaining candidate only with the current highest-ranked anchor.
9. A mask-only group unions sparse rasters and encodes the tight bounds as CVAT RLE. A rectangle-only group returns the axis-aligned min/max enclosure with rotation `0`. Every other merge returns the sparse union encoded as a mask. Allow a mask result only for target label types `any` and `mask`; allow the rectangle enclosure only for `any` and `rectangle`. Throw `DetectorPostprocessingError` with the label ID and required result type for an incompatible group.
10. A merged shape spreads the highest-ranked anchor, replaces `type`, `points`, and `rotation`, sets `score` to the maximum group score, and retains the anchor's `sourceIndex` and label. Copy anchor attributes; when `confidenceAttributeSpecID` is present, replace that attribute value with the maximum score formatted to four decimal places.
11. Merge processed groups and passthrough shapes by `sourceIndex` for deterministic display order.

Reject malformed mask RLE, invalid frame sizes, and a raster working region above 64 million pixels with a descriptive `DetectorPostprocessingError`. Do not partially return a failed merge.

- [ ] **Step 4: Run algorithm tests and lint the pure module**

```bash
node --experimental-strip-types --test tests/unit/detector-postprocessing.test.ts
./node_modules/.bin/eslint cvat-ui/src/utils/detector-postprocessing.ts
```

Expected: all algorithm tests PASS and lint exits 0.

- [ ] **Step 5: Commit the pure algorithm**

```bash
git add cvat-ui/src/utils/detector-postprocessing.ts tests/unit/detector-postprocessing.test.ts
git commit -m "feat(ui): add detector overlap postprocessor"
```

### Task 5: Run postprocessing through a sequenced worker

**Files:**
- Create: `cvat-ui/src/utils/detector-postprocessing.worker.ts`
- Create: `cvat-ui/src/utils/latest-request-gate.ts`
- Create: `cvat-ui/src/utils/detector-postprocessing-client.ts`
- Extend: `tests/unit/detector-postprocessing.test.ts`

- [ ] **Step 1: Add tests for stale-request and disposal behavior**

Create a small exported `LatestRequestGate` in its own dependency-free file and test it without a browser Worker:

```typescript
import { LatestRequestGate } from '../../cvat-ui/src/utils/latest-request-gate.ts';

test('latest request gate accepts only the newest live request', () => {
    const gate = new LatestRequestGate();
    const first = gate.issue();
    const second = gate.issue();
    assert.equal(gate.isCurrent(first), false);
    assert.equal(gate.isCurrent(second), true);
    gate.dispose();
    assert.equal(gate.isCurrent(second), false);
});
```

Run the test and expect `LatestRequestGate` to be missing.

Then extend the test with an injected fake worker. The production client must accept an optional worker factory so the test exercises the actual client protocol:

```typescript
import {
    DetectorPostprocessingClient,
    type DetectorProcessingRequest,
    type DetectorProcessingResponse,
} from '../../cvat-ui/src/utils/detector-postprocessing-client.ts';

class FakeWorker {
    public onmessage: ((event: MessageEvent) => void) | null = null;
    public onerror: ((event: ErrorEvent) => void) | null = null;
    public onmessageerror: ((event: MessageEvent) => void) | null = null;
    public sent: DetectorProcessingRequest[] = [];
    public terminated = false;

    public postMessage(request: DetectorProcessingRequest): void { this.sent.push(request); }
    public terminate(): void { this.terminated = true; }
    public reply(response: DetectorProcessingResponse): void {
        this.onmessage?.({ data: response } as MessageEvent);
    }
    public fail(message: string): void {
        this.onerror?.({ message } as ErrorEvent);
    }
}

test('client ignores stale output, resolves disposal, and retries a worker error', async () => {
    const workers: FakeWorker[] = [];
    const client = new DetectorPostprocessingClient(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
    });
    const request: Omit<DetectorProcessingRequest, 'id'> = {
        shapes: [rectangle(0, 1, 0.9, [0, 0, 2, 2])],
        frame: { width: 3, height: 3 },
        options: { confidenceThreshold: 0.35, postprocessing: { method: 'nms', metric: 'ios', threshold: 0.7 } },
    };

    const first = client.process(request.shapes, request.frame, request.options);
    const firstID = workers[0].sent[0].id;
    const second = client.process(request.shapes, request.frame, request.options);
    const secondID = workers[0].sent[1].id;
    assert.equal(await first, null);
    workers[0].reply({ id: firstID, shapes: [] });
    workers[0].reply({ id: secondID, shapes: request.shapes });
    assert.deepEqual(await second, request.shapes);

    const failed = client.process(request.shapes, request.frame, request.options);
    workers[0].fail('worker crashed');
    await assert.rejects(failed, /worker crashed/i);
    const retried = client.retry();
    const retryID = workers[1].sent[0].id;
    workers[1].reply({ id: retryID, shapes: [] });
    assert.deepEqual(await retried, []);

    const pending = client.process(request.shapes, request.frame, request.options);
    client.dispose();
    assert.equal(await pending, null);
    assert.equal(workers[1].terminated, true);
});
```

Run again and expect failure because `DetectorPostprocessingClient` and its worker protocol do not exist.

- [ ] **Step 2: Implement the worker protocol**

Use this protocol in both worker and client:

```typescript
export interface DetectorProcessingRequest {
    id: number;
    shapes: DetectorShape[];
    frame: FrameSize;
    options: ProcessingOptions;
}

export type DetectorProcessingResponse =
    | { id: number; shapes: DetectorShape[] }
    | { id: number; error: string };
```

Define and export the protocol from `detector-postprocessing-client.ts`; import those types into the worker so the client and worker cannot drift.

The worker calls `processDetectorShapes` and posts exactly one success or error response. Export a structural `DetectorWorkerPort` interface containing `postMessage`, `terminate`, `onmessage`, `onerror`, and `onmessageerror`. The client accepts `workerFactory?: () => DetectorWorkerPort` and defaults it to:

```typescript
new Worker(new URL('./detector-postprocessing.worker.ts', import.meta.url));
```

`process()` invalidates and resolves the previous pending preview request with `null`, sends a monotonically increasing ID, and returns only the matching response. `retry()` restarts a failed worker and resubmits the retained latest input. `dispose()` terminates the worker and resolves pending work with `null`. Worker startup, `error`, and `messageerror` all reject the current request with a descriptive `Error`.

Implement the gate exactly as:

```typescript
export class LatestRequestGate {
    private current = 0;
    private disposed = false;

    public issue(): number {
        if (this.disposed) throw new Error('Request gate is disposed');
        this.current += 1;
        return this.current;
    }

    public isCurrent(id: number): boolean {
        return !this.disposed && id === this.current;
    }

    public dispose(): void {
        this.disposed = true;
        this.current += 1;
    }
}
```

- [ ] **Step 3: Run tests, type-check, lint, and commit**

```bash
node --experimental-strip-types --test tests/unit/detector-postprocessing.test.ts
./node_modules/.bin/tsc -p cvat-ui/tsconfig.json
./node_modules/.bin/eslint \
  cvat-ui/src/utils/detector-postprocessing.worker.ts \
  cvat-ui/src/utils/latest-request-gate.ts \
  cvat-ui/src/utils/detector-postprocessing-client.ts
git add cvat-ui/src/utils/detector-postprocessing.worker.ts \
  cvat-ui/src/utils/latest-request-gate.ts \
  cvat-ui/src/utils/detector-postprocessing-client.ts \
  tests/unit/detector-postprocessing.test.ts
git commit -m "feat(ui): process detector results off the main thread"
```

Expected: tests PASS, type-check and lint exit 0.

### Task 6: Extend temporary canvas rendering to detector shapes

**Files:**
- Modify: `cvat-canvas/src/typescript/canvasModel.ts:134-156`
- Modify: `cvat-canvas/src/typescript/interactionHandler.ts:284-355`
- Create: `tests/cypress/e2e/features2/detector_preview_postprocessing.js`

- [ ] **Step 1: Write the failing browser test for all temporary canvas shapes**

Create `detector_preview_postprocessing.js` with the normal task/job setup used by adjacent `features2` tests, including at least two image frames for the later stale-response test and teardown that deletes only the task created by this spec. Add a test-only helper that reaches `ToolsControlComponent` through `.cvat-tools-control`'s React fiber, then directly calls the real canvas interaction API owned by that component:

```javascript
function putTemporaryShapes(win, shapes) {
    const tools = requireToolsControlComponent(win);
    tools.props.canvasInstance.interact({
        enabled: true,
        command: 'put_shapes',
        payload: { shapes },
    });
}

it('renders every supported detector shape in the temporary canvas layer', () => {
    cy.window().then((win) => putTemporaryShapes(win, [
        { shapeType: 'rectangle', points: [10, 10, 40, 30], rotation: 15 },
        { shapeType: 'ellipse', points: [70, 30, 90, 15], rotation: 30 },
        { shapeType: 'polygon', points: [100, 10, 130, 10, 120, 35] },
        { shapeType: 'mask', points: [0, 4, 150, 10, 151, 11] },
        { shapeType: 'polyline', points: [180, 10, 200, 30, 220, 10] },
        { shapeType: 'points', points: [240, 20, 255, 25] },
    ]));
    cy.get('.cvat_canvas_interact_intermediate_shape').should('have.length', 7);
});
```

Run:

```bash
cd tests
./node_modules/.bin/cypress run --browser chrome \
  --spec cypress/e2e/features2/detector_preview_postprocessing.js
cd ..
```

Expected: FAIL because rectangle, ellipse, polyline, and points do not yet enter the temporary layer.

- [ ] **Step 2: Add the temporary-shape fields and renderer branches**

Extend the interaction payload shape with `rotation?: number`. Refactor `putShapes` so every branch uses `.cvat_canvas_interact_intermediate_shape`, `pointer-events: none`, the current scale-adjusted stroke width, white translucent fill for area shapes, and the existing selected blue versus black outline. Define one local registrar before the shape-type branches:

```typescript
const registerShape = (element: SVG.Shape, filled: boolean): void => {
    element.attr({
        'color-rendering': 'optimizeQuality',
        'shape-rendering': 'geometricprecision',
        'stroke-width': consts.BASE_STROKE_WIDTH / this.geometry.scale,
        stroke: color,
        'pointer-events': 'none',
    }).fill(filled ? { opacity: this.effectiveShapeOpacity, color: 'white' } : 'none')
        .addClass('cvat_canvas_interact_intermediate_shape');
    this.container.node.prepend(element.node);
    this.intermediateShapes.push(element);
};
```

Implement branches with the following SVG.js construction:

```typescript
if (shapeType === 'rectangle') {
    const [xtl, ytl, xbr, ybr] = Array.from(points);
    const rectangle = this.container.rect(xbr - xtl, ybr - ytl).move(
        this.geometry.offset + xtl, this.geometry.offset + ytl,
    );
    rectangle.rotate(rotation ?? 0, this.geometry.offset + (xtl + xbr) / 2,
        this.geometry.offset + (ytl + ybr) / 2);
    registerShape(rectangle, true);
} else if (shapeType === 'ellipse') {
    const [cx, cy, rightX, topY] = Array.from(points);
    const ellipse = this.container.ellipse(2 * (rightX - cx), 2 * (cy - topY)).center(
        this.geometry.offset + cx, this.geometry.offset + cy,
    );
    ellipse.rotate(rotation ?? 0, this.geometry.offset + cx, this.geometry.offset + cy);
    registerShape(ellipse, true);
} else if (shapeType === 'polyline') {
    registerShape(this.container.polyline(
        stringifyPoints(translateToCanvas(this.geometry.offset, points)),
    ), false);
} else if (shapeType === 'points') {
    for (let index = 0; index < points.length; index += 2) {
        registerShape(this.container.circle(this.effectivePointSize * 2).center(
            this.geometry.offset + points[index], this.geometry.offset + points[index + 1],
        ), true);
    }
}
```

Keep existing polygon and mask rendering behavior, including mask URL revocation and outlines. Ignore an unknown shape type rather than throwing.

- [ ] **Step 3: Build, lint, and rerun the focused canvas test**

```bash
./node_modules/.bin/tsc -p cvat-canvas/tsconfig.json
./node_modules/.bin/eslint \
  cvat-canvas/src/typescript/canvasModel.ts \
  cvat-canvas/src/typescript/interactionHandler.ts
cd cvat-canvas
../node_modules/.bin/webpack --config webpack.config.cjs
cd ..
cd tests
./node_modules/.bin/cypress run --browser chrome \
  --spec cypress/e2e/features2/detector_preview_postprocessing.js
cd ..
```

Expected: type-check, lint, canvas build, and the focused browser test exit 0.

- [ ] **Step 4: Commit the canvas slice**

```bash
git add cvat-canvas/src/typescript/canvasModel.ts \
  cvat-canvas/src/typescript/interactionHandler.ts \
  tests/cypress/e2e/features2/detector_preview_postprocessing.js
git commit -m "feat(canvas): preview detector result shapes"
```

### Task 7: Integrate the transactional detector preview

**Files:**
- Create: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-preview.tsx`
- Create: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-result-adapter.ts`
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx:160-351,368-490,2056-2158,2205-2313`
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/styles.scss:170-315`
- Extend: `tests/cypress/e2e/features2/detector_preview_postprocessing.js`

- [ ] **Step 1: Add failing browser coverage for request and transaction boundaries**

Extend the Cypress file with a mock detector manifest, helpers to open the Detectors tab and choose the model, and an intercepted response containing two scored same-label masks plus one pass-through tag. Add these assertions before implementation:

```javascript
const previewResponse = {
    tags: [{ label_id: taskLabelIDs.damage, frame: 0, group: 0, source: 'auto', attributes: [] }],
    tracks: [],
    shapes: [
        {
            label_id: taskLabelIDs.damage, frame: 0, group: 0, source: 'auto', type: 'mask',
            points: [0, 100, 10, 10, 19, 19], score: 0.90, occluded: false, outside: false,
            z_order: 0, attributes: [{ spec_id: taskAttributeSpecIDs.damage, value: '0.9000' }],
        },
        {
            label_id: taskLabelIDs.damage, frame: 0, group: 0, source: 'auto', type: 'mask',
            points: [0, 36, 12, 12, 17, 17], score: 0.30, occluded: false, outside: false,
            z_order: 0, attributes: [{ spec_id: taskAttributeSpecIDs.damage, value: '0.3000' }],
        },
    ],
};

cy.get('.cvat-detector-preview-confidence-checkbox input').should('be.checked');
cy.get('.cvat-detector-confidence-threshold input').should('be.disabled');
cy.get('.cvat-detector-postprocessing-method').should('contain', 'NMS');
cy.get('.cvat-detector-postprocessing-metric').should('contain', 'IoS');
cy.get('.cvat-detector-postprocessing-threshold input').should('have.value', '0.70');

cy.intercept('POST', '**/api/lambda/functions/test-detector-preview**', (request) => {
    expect(request.body.threshold).to.equal(0.1);
    expect(request.body).not.to.have.property('postprocessing');
    expect(request.body).not.to.have.property('previewConfidence');
    request.reply({ statusCode: 200, body: previewResponse });
}).as('previewCall');
cy.contains('button', 'Annotate').click();
cy.wait('@previewCall');
cy.get('.cvat-objects-sidebar-state-item').should('not.exist');
cy.get('.cvat-detector-preview-wrapper').should('contain', '1 / 2 results');
cy.get('.cvat-detector-preview-cancel').click();
cy.get('.cvat-objects-sidebar-state-item').should('not.exist');
```

Run only this spec and expect it to fail because the controls, preview portal, and transaction do not exist yet.

- [ ] **Step 2: Implement the result adapter**

Export these focused functions:

```typescript
export interface SerializedDetectorResult {
    tags: SerializedDetectorTag[];
    shapes: SerializedDetectorShape[];
    tracks: unknown[];
}

export function normalizeDetectorShapes(
    shapes: SerializedDetectorShape[], labels: Label[],
): DetectorShape[];
export function toTemporaryCanvasShapes(shapes: DetectorShape[]): InteractionData['payload']['shapes'];
export function toObjectStates(
    result: { tags: SerializedDetectorTag[]; shapes: DetectorShape[] },
    context: { labels: Label[]; frame: number; zOrder: number },
): ObjectState[];
```

Define and export structural `SerializedDetectorShape`, `SerializedDetectorTag`, and `SerializedDetectorResult` types in the adapter, then remove the local `DetectorResults` alias from `tools-control.tsx`. `normalizeDetectorShapes` keeps `score` absent when the serialized response omits it, assigns `sourceIndex`, records the mapped label's `type`, and records the spec ID of its `model_confidence` attribute when present. `toTemporaryCanvasShapes` maps each serialized `type` to the canvas payload's `shapeType` and copies `points` and `rotation`. `toObjectStates` copies native `score`, mapped attributes, shape elements, geometry, and source; tags pass through unchanged. Throw a descriptive error for a missing mapped label instead of using a non-null assertion.

- [ ] **Step 3: Implement the compact preview portal**

`DetectorPreview` mounts into `.cvat-canvas-container` and accepts:

```typescript
interface Props {
    rawCount: number;
    visibleCount: number;
    confidence: number;
    processing: boolean;
    error: string | null;
    onConfidenceChange(value: number): void;
    onRetry(): void;
    onCancel(): void;
    onDone(): void;
}
```

Render `.cvat-detector-preview-wrapper` with a flex header (`visible / raw results` on the left and the confidence value formatted to two decimals on the right), an Ant slider (`min={0.1}`, `max={1}`, `step={0.01}`), an optional error row, and a right-aligned action row containing Retry when applicable, Cancel, and Done. Add stable action classes `.cvat-detector-preview-retry`, `.cvat-detector-preview-cancel`, and `.cvat-detector-preview-done`. Disable Done while processing or errored.

Make the canvas panel self-contained and stable with `position: absolute`, `top: $grid-unit-size`, `left: 50%`, `transform: translateX(-50%)`, `width: $grid-unit-size * 45` (360px), `max-width: calc(100% - #{$grid-unit-size * 2})`, `z-index: 100`, the normal secondary background, border, radius, and one-grid-unit padding. Give the slider a fixed row and use an 8px gap in the action row; error text may add one row without changing width.

- [ ] **Step 4: Add an explicit detector-preview session to ToolsControl**

Add state fields:

```typescript
detectorPreviewActive: boolean;
detectorConfidence: number;
detectorPreviewProcessing: boolean;
detectorPreviewError: string | null;
detectorRawCount: number;
detectorVisibleCount: number;
```

Add a private session:

```typescript
private detectorPreview: {
    revision: number;
    jobID: number | null;
    frame: number | null;
    raw: DetectorShape[];
    displayed: DetectorShape[];
    tags: SerializedDetectorTag[];
    options: DetectorRunOptions | null;
    debounce: number | null;
} = {
    revision: 0, jobID: null, frame: null, raw: [], displayed: [], tags: [], options: null, debounce: null,
};
```

Own one lazily created `DetectorPostprocessingClient`. `cancelDetectorPreview()` increments the revision, clears the debounce, disposes the worker, disables canvas interaction, empties the session, and resets preview state. Call it on AI Tools deactivation, frame/job change, the `DetectorRunner.onModelChange` callback, switching away from the Detectors tab, and unmount. A workspace change unmounts this standard-workspace controller, so the same teardown covers it.

- [ ] **Step 5: Replace immediate detector creation with the independent option matrix**

The `runInference` callback must:

1. snapshot `jobInstance.id`, task ID, frame, model ID, and a new revision before awaiting the lambda call;
2. omit only `cleanup` from the server body;
3. reject the response if the snapshot no longer matches;
4. normalize mapped shapes before constructing `ObjectState` instances;
5. when preview is disabled, process once with `confidenceThreshold: null`, then immediately create processed shapes plus tags;
6. when preview is enabled and there are shapes, retain raw shapes and tags, start at `0.35`, process, draw temporary shapes, and show the preview panel;
7. when preview is enabled but the result is tag-only, commit the tags through the legacy immediate path because tags are outside shape preview;
8. when the mapped result is empty, show `No detections found` and create nothing.

Use this ordering for every preview recomputation:

```typescript
const displayed = await client.process(raw, frameSize, {
    confidenceThreshold: this.state.detectorConfidence,
    postprocessing: options.postprocessing,
});
if (!displayed || revision !== this.detectorPreview.revision) return;
this.detectorPreview.displayed = displayed;
canvasInstance.interact({
    enabled: true,
    command: 'put_shapes',
    payload: { shapes: toTemporaryCanvasShapes(displayed) },
});
this.setState({
    detectorPreviewProcessing: false,
    detectorPreviewError: null,
    detectorVisibleCount: displayed.length,
});
```

Debounce slider changes by 75 ms. Every change processes the immutable `raw` pool again. Do not chain processing from the previously displayed collection.

- [ ] **Step 6: Implement Done, Cancel, Retry, and portal rendering**

`Done` snapshots the latest displayed shapes and pending tags, cancels the temporary canvas layer without discarding that snapshot, constructs all `ObjectState` instances once, and invokes `createAnnotations` once. `Cancel` discards everything. `Retry` restarts the worker and recomputes the current slider value. A worker error keeps raw data, clears temporary shapes, records the message, and disables Done.

Render `DetectorPreview` only when `isActivated`, `mode === 'detection'`, and `detectorPreviewActive`. Keep the existing blocking request modal only while the Nuclio request is pending; hide it after the response before showing preview.

- [ ] **Step 7: Type-check, lint, build, rerun the browser test, and commit**

```bash
./node_modules/.bin/tsc -p cvat-ui/tsconfig.json
./node_modules/.bin/eslint \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-preview.tsx \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-result-adapter.ts \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx
cd cvat-ui
../node_modules/.bin/webpack --config webpack.config.js
cd ..
cd tests
./node_modules/.bin/cypress run --browser chrome \
  --spec cypress/e2e/features2/detector_preview_postprocessing.js
cd ..
git add cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-preview.tsx \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-result-adapter.ts \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx \
  cvat-ui/src/components/annotation-page/standard-workspace/styles.scss \
  tests/cypress/e2e/features2/detector_preview_postprocessing.js
git commit -m "feat(ui): preview detector results before commit"
```

Expected: type-check, lint, production UI build, and focused Cypress assertions exit 0.

### Task 8: Complete browser regression coverage

**Files:**
- Extend: `tests/cypress/e2e/features2/detector_preview_postprocessing.js`

- [ ] **Step 1: Complete the mocked detector and deterministic response matrix**

Retain the React-fiber model injection helper introduced in Tasks 6-7. Replace Task 7's minimal response fixture with this detector and complete response builder in the spec:

```javascript
const detector = {
    id: 'test-detector-preview', name: 'Mock detector preview', kind: 'detector',
    description: 'Mock detector preview', version: 2,
    labels_v2: [
        { name: 'damage', type: 'mask', attributes: [{ name: 'model_confidence', input_type: 'text', values: [] }] },
        { name: 'stain', type: 'mask', attributes: [{ name: 'model_confidence', input_type: 'text', values: [] }] },
    ],
};

const makePreviewResponse = (taskLabelIDs) => ({
    tags: [{ label_id: taskLabelIDs.damage, frame: 0, group: 0, source: 'auto', attributes: [] }],
    tracks: [],
    shapes: [
        makeMask({ labelID: taskLabelIDs.damage, score: 0.90, confidence: '0.9000', box: [10, 10, 19, 19] }),
        makeMask({ labelID: taskLabelIDs.damage, score: 0.30, confidence: '0.3000', box: [12, 12, 17, 17] }),
        makeRectangle({ labelID: taskLabelIDs.damage, score: 0.80, points: [30, 10, 45, 25] }),
        makeMask({ labelID: taskLabelIDs.stain, score: 0.70, confidence: '0.7000', box: [10, 10, 19, 19] }),
        makePolygon({ labelID: taskLabelIDs.damage, points: [55, 10, 65, 10, 60, 20] }),
    ],
});
```

Obtain `taskLabelIDs` from the job instance before calling `makePreviewResponse`. The helper builders must include normal CVAT response fields (`frame`, `group`, `source`, `occluded`, `rotation`, `z_order`, and `attributes`). The mask helper emits valid CVAT RLE with the four-value bounding-box suffix.

This fixture provides:

- two contained same-class masks at scores `0.90` and `0.30`;
- one overlapping same-class rectangle at `0.80`;
- one identical-geometry different-class mask at `0.70`;
- one confidence-free polygon;
- mapped `model_confidence` attributes.

Use stable selectors beginning with `.cvat-detector-` for every new control. Do not select Ant Design controls by generated IDs.

- [ ] **Step 2: Test defaults and request contracts**

Verify the preview checkbox is checked, the legacy threshold input is disabled, Method is NMS, Metric is IoS, and Overlap is `0.70`. Click Annotate and assert the request contains `threshold: 0.1` but contains no postprocessing fields.

Cancel, uncheck preview, clear the legacy threshold, run again, and assert `threshold` is absent. Repeat with `0.62` and assert the request contains exactly `0.62`.

In each intercepted request, assert `postprocessing` and `previewConfidence` are absent so UI-only options never leak to the Nuclio handler.

With preview enabled again, focus the Overlap numeric input and press Enter; assert exactly one detector request is made, proving the existing primary-action keyboard behavior still reaches **Annotate** from the new controls. Open the Method dropdown and press Enter to select an option; assert that action does not submit inference.

- [ ] **Step 3: Test independent postprocessing controls**

Select Disabled and assert only Metric and Overlap are disabled while the preview checkbox remains active. Select each of NMS, NMM, and NMM (greedy) and assert Metric and Overlap re-enable. With preview unchecked and NMS selected, assert annotations are created immediately after the response.

While NMS is selected, clear Overlap and assert `.cvat-detector-postprocessing-error` is visible and Annotate is disabled. Enter `0`, `1`, and `0.70` in turn and assert both boundaries and the default are accepted. Clear it once more, choose Disabled, and assert Annotate re-enables while Metric and Overlap remain disabled.

- [ ] **Step 4: Test the preview transaction and confidence mapping**

With preview enabled, assert no object-sidebar items are created before Done, intermediate canvas shapes exist, the panel reports the expected visible/raw count, and moving the slider above `0.80` redraws without a second lambda request. Assert Cancel leaves the sidebar unchanged. Run again, press Done, and assert only visible shapes plus any pending tags are created. Expand a saved object and assert `model_conf` contains its returned confidence.

Record the pre-run sidebar count and compare against it instead of assuming an empty job. Count lambda requests in the intercept closure and assert it remains `1` after slider changes.

After Done, request `/api/jobs/${jobID}/annotations` and locate the created shape. Assert its native `score` equals the returned confidence and its attributes include the known `model_confidence` spec ID/value. Read the job label through `ToolsControlComponent.props.jobInstance.labels` and assert that attribute's stored name is still `model_confidence`; the sidebar assertion above verifies only its presentation is shortened to `model_conf`.

- [ ] **Step 5: Test stale result rejection and all canvas shape branches**

Delay a mocked response, navigate to another frame, then release it and assert no preview appears. Return rectangle, ellipse, polygon, mask, polyline, and points shapes and assert the corresponding `.cvat_canvas_interact_intermediate_shape` elements appear. Confirm that confidence-free polyline and points survive filtering but do not affect NMS/NMM counts within area-shape classes.

Return one malformed mask RLE and assert the preview shows a descriptive error, `.cvat-detector-preview-retry` is visible, `.cvat-detector-preview-done` is disabled, and no annotation is created. Click Retry and assert the retained malformed raw pool fails safely again, then Cancel and verify the preview and temporary shapes disappear. The fake-worker unit test in Task 5 covers successful recovery after a transient worker failure.

- [ ] **Step 6: Run the focused Cypress spec and commit**

Run against the development Compose stack:

```bash
cd tests
./node_modules/.bin/cypress run --browser chrome \
  --spec cypress/e2e/features2/detector_preview_postprocessing.js
```

Expected: all scenarios PASS.

```bash
cd /data/cvat/.worktrees/detector-preview-postprocessing
git add tests/cypress/e2e/features2/detector_preview_postprocessing.js
git commit -m "test(ui): cover detector preview postprocessing"
```

### Task 9: Complete focused and boundary verification

**Files:**
- Modify if required by findings: only files already listed in Tasks 1-8

- [ ] **Step 1: Run all new pure and server tests together**

```bash
node --experimental-strip-types --test \
  tests/unit/label-mapping-initialization.test.ts \
  tests/unit/detector-runner-config.test.ts \
  tests/unit/detector-postprocessing.test.ts
python manage.py test --settings cvat.settings.testing \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_preserves_detector_confidence \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_omits_invalid_detector_confidence \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_detector \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_convert_mask_to_rle \
  cvat.apps.lambda_manager.tests.test_lambda.LambdaTestCases.test_api_v2_lambda_functions_create_detector_with_roi -v 2
```

Expected: all tests PASS.

- [ ] **Step 2: Run static checks and production builds**

```bash
./node_modules/.bin/tsc -p cvat-ui/tsconfig.json
./node_modules/.bin/tsc -p cvat-canvas/tsconfig.json
./node_modules/.bin/eslint \
  cvat-ui/src/components/model-runner-modal/label-mapping-types.ts \
  cvat-ui/src/components/model-runner-modal/label-mapping-initialization.ts \
  cvat-ui/src/components/model-runner-modal/labels-mapper.tsx \
  cvat-ui/src/components/model-runner-modal/label-mapping-utils.ts \
  cvat-ui/src/components/model-runner-modal/detector-runner-config.ts \
  cvat-ui/src/components/model-runner-modal/detector-runner.tsx \
  cvat-ui/src/utils/detector-postprocessing.ts \
  cvat-ui/src/utils/detector-postprocessing.worker.ts \
  cvat-ui/src/utils/latest-request-gate.ts \
  cvat-ui/src/utils/detector-postprocessing-client.ts \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-preview.tsx \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/detector-result-adapter.ts \
  cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx \
  cvat-canvas/src/typescript/canvasModel.ts \
  cvat-canvas/src/typescript/interactionHandler.ts
cd cvat-canvas
../node_modules/.bin/webpack --config webpack.config.cjs
cd ../cvat-ui
../node_modules/.bin/webpack --config webpack.config.js
cd ..
```

Expected: every command exits 0.

- [ ] **Step 3: Run the focused Cypress spec**

```bash
cd tests
./node_modules/.bin/cypress run --browser chrome \
  --spec cypress/e2e/features2/detector_preview_postprocessing.js
```

Expected: PASS without browser-console errors.

- [ ] **Step 4: Review the complete branch diff against the approved spec**

```bash
cd /data/cvat/.worktrees/detector-preview-postprocessing
git diff --check develop...HEAD
git diff --stat develop...HEAD
git log --oneline develop..HEAD
```

Confirm explicitly that:

- confidence preview and postprocessing remain independent;
- task-level automatic annotation has no preview controls;
- no slider movement sends a lambda request;
- missing confidence cannot be confused with score `1` before processing;
- every overlap operation is confined to one final mapped label;
- NMM and greedy NMM differ on transitive chains;
- no annotation is created before Done in preview mode;
- no deployment, Compose replacement, Nuclio redeployment, push, or merge occurred.

- [ ] **Step 5: Commit only verified corrections, if any**

If verification required code corrections, stage only those files and commit with a message describing the corrected behavior. If no corrections were needed, do not create an empty commit.

## Live acceptance after a separately approved deployment

After implementation review, merge, and deployment are separately authorized, verify Argus Outdoor v1 and Indoor v3 in a disposable job/frame:

1. Confirm checked preview sends `0.10`, starts the slider at `0.35`, and performs one Nuclio call.
2. Move the slider repeatedly and confirm the function invocation count does not change.
3. Compare Disabled, NMS, NMM, and NMM (greedy) with IoS and IoU.
4. Confirm only same-label shapes suppress or merge.
5. Confirm unchecked preview restores blank-handler-default and explicit-threshold request behavior.
6. Press Cancel and verify saved annotations do not change.
7. Press Done and verify native score plus visible `model_conf` on the created shapes.
8. Verify frame navigation and closing AI Tools discard temporary results.
