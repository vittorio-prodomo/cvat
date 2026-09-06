# SAM3 Concept Exemplar Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit SAM3 “Find similar objects” mode that accepts text, one positive exemplar box, or both, while preserving single-object interaction, ROI behavior, confidence filtering, refinement, and mask morphology.

**Architecture:** Extend the existing SAM3 text capability annotation so the UI can expose two explicit task modes. Send `prompt_mode=concept` through CVAT's existing flattened `extra_params` channel, route legacy requests compatibly in Nuclio, and use only public `Sam3Processor` operations to combine language and normalized positive geometric prompts before serializing every returned mask and confidence.

**Tech Stack:** React 18, TypeScript 5.8, CVAT Canvas, Node.js test runner, Python 3.12, pytest, SAM3 `660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7`, PyTorch 2.10 CUDA 12.8, Nuclio 1.16.3, Docker Compose.

---

## Scope and compatibility contract

- `Single object` is the default. It keeps positive/negative points and the optional starting box and returns one best mask.
- `Find similar objects` accepts freeform text, exactly one positive exemplar box, or both; points are rejected for the initial concept request.
- `Use label name` copies the selected CVAT label into the freeform text field and leaves it editable.
- The exemplar box means “find objects like this.” CVAT ROI remains an independent crop; when present, concept search is limited to that submitted crop.
- Concept results keep the existing confidence slider, per-mask selection, point refinement, and erosion/dilation.
- A new concept request clears the prior result set, refinement selection, queued requests, and morphology previews.
- Explicit `prompt_mode` values are `single_object` and `concept`.
- Legacy requests without `prompt_mode` retain their contracts: text-only routes to concept search; point/box routes to single-object inference; legacy text mixed with visual prompts remains rejected.
- The backend accepts no private SAM3 calls. Combined text plus exemplar uses `set_text_prompt` followed by `add_geometric_prompt` on the same fresh image state.
- No checkpoint, dependency, or Indoor v3 change is part of this plan.

## File map

- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py` — concept prompt validation, coordinate normalization, processor calls, result serialization.
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/main.py` — explicit/legacy request routing and validation.
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml` — advertise concept-box capability and update help text.
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py` — processor adapter tests.
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_main.py` — HTTP contract tests.
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_function_gpu.py` — capability manifest tests.
- Modify: `cvat-ui/src/components/common/model-extra-params-form.tsx` — type the capability metadata.
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx` — explicit modes, exemplar drawing, request snapshots, label shortcut, and state resets.
- Modify: `tests/unit/interactor-harness.cjs` — concept-capable fixture.
- Create: `tests/unit/interactor-concept-prompts.cjs` — controller and rendered-control tests.
- Create at execution time: `data/deployments/sam3/concept-exemplar/*` — source, candidate, GPU, rollback, and deployment receipts.

### Task 1: Prepare the shared worktree from the exact deployed sources

**Files:**
- Use: `/data/cvat/.worktrees/account-session-fixes/`
- Use: `/data/cvat/.worktrees/sam3-refinement-continuity/serverless/pytorch/facebookresearch/sam3/nuclio/`
- Populate: `/data/cvat/.worktrees/sam3-concept-indoor-mapping/`

- [ ] **Step 1: Verify the integration base and deployed UI source**

Run:

```bash
cd /data/cvat
test "$(git rev-parse develop)" = "1ba5b66b1b5a5d7d7f28a0137c99948ae0e2f94e"
test "$(git -C .worktrees/account-session-fixes rev-parse HEAD)" = "1ba5b66b1b5a5d7d7f28a0137c99948ae0e2f94e"
sha256sum -c <(python3 - <<'PY'
import json
from pathlib import Path
root = Path('/data/cvat/.worktrees/account-session-fixes')
manifest = json.loads(Path('/data/cvat/data/deployments/account-session-fixes/inherited-source-manifest.json').read_text())
for relative, digest in manifest.items():
    print(digest, root / relative)
PY
)
```

Expected: both SHAs equal the recorded integration base and every inherited source file prints `OK`.

- [ ] **Step 2: Create or validate the shared implementation worktree**

Run:

```bash
cd /data/cvat
if [ ! -d .worktrees/sam3-concept-indoor-mapping ]; then
    git worktree add -b feat/sam3-concept-indoor-mapping .worktrees/sam3-concept-indoor-mapping develop
fi
test "$(git -C .worktrees/sam3-concept-indoor-mapping branch --show-current)" = "feat/sam3-concept-indoor-mapping"
test "$(git -C .worktrees/sam3-concept-indoor-mapping rev-parse HEAD)" = "1ba5b66b1b5a5d7d7f28a0137c99948ae0e2f94e"
```

Expected: the worktree is on the feature branch at the recorded base.

- [ ] **Step 3: Seed UI, canvas, and custom unit tests from the deployed aggregate**

Run:

```bash
cd /data/cvat
rsync -a --delete .worktrees/account-session-fixes/cvat-ui/ .worktrees/sam3-concept-indoor-mapping/cvat-ui/
rsync -a --delete .worktrees/account-session-fixes/cvat-canvas/ .worktrees/sam3-concept-indoor-mapping/cvat-canvas/
mkdir -p .worktrees/sam3-concept-indoor-mapping/tests/unit
rsync -a --delete .worktrees/account-session-fixes/tests/unit/ .worktrees/sam3-concept-indoor-mapping/tests/unit/
if [ ! -e .worktrees/sam3-concept-indoor-mapping/node_modules ]; then
    ln -s /data/cvat/node_modules .worktrees/sam3-concept-indoor-mapping/node_modules
fi
test "$(readlink -f .worktrees/sam3-concept-indoor-mapping/node_modules)" = "/data/cvat/node_modules"
```

Expected: the copied UI baseline matches `inherited-source-manifest.json` and uses the shared installed dependencies.

- [ ] **Step 4: Seed SAM3 from the exact live refinement-continuity source**

Run:

```bash
cd /data/cvat
test "$(sha256sum .worktrees/sam3-refinement-continuity/serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py | cut -d' ' -f1)" \
    = "f4ad6480e663babd10141113c7776a69e71e5832f48681dcb082aafa6180a62f"
rsync -a --delete \
    .worktrees/sam3-refinement-continuity/serverless/pytorch/facebookresearch/sam3/nuclio/ \
    .worktrees/sam3-concept-indoor-mapping/serverless/pytorch/facebookresearch/sam3/nuclio/
mkdir -p data/deployments/sam3/concept-exemplar
sha256sum .worktrees/sam3-concept-indoor-mapping/serverless/pytorch/facebookresearch/sam3/nuclio/* \
    > data/deployments/sam3/concept-exemplar/baseline-source.sha256
```

Expected: the copied handler hash equals the live deployment receipt; `main.py`, manifest, and tests match the refinement-continuity worktree; production remains unchanged.

### Task 2: Add the SAM3 concept processor adapter

**Files:**
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py:54-257`
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py:61-173`

- [ ] **Step 1: Extend the dummy processor and add failing adapter tests**

Add to `DummyTextProcessor.__init__`:

```python
self.geometric_prompts = []
```

Add this method after `set_text_prompt`:

```python
def add_geometric_prompt(self, *, box, label, state):
    self.geometric_prompts.append({'box': box, 'label': label, 'state': state})
    assert state is self.states[-1]
    state.update({
        'masks': DummyTensor(self.masks),
        'masks_logits': DummyTensor(self.masks.astype(np.float32)),
        'boxes': DummyTensor(np.zeros((len(self.masks), 4), dtype=np.float32)),
        'scores': DummyTensor(self.scores),
    })
    return state
```

Add these tests:

```python
def test_concept_combines_trimmed_text_and_normalized_positive_exemplar():
    handler = make_handler()
    handler.processor.masks = np.ones((1, 1, 100, 200), dtype=bool)
    handler.processor.scores = np.array([0.75], dtype=np.float32)

    shapes = handler.handle_concept(
        Image.new('RGB', (200, 100)),
        text_prompt='  unusual bracket  ',
        exemplar_bbox=[[20, 10], [60, 50]],
    )

    assert len(shapes) == 1
    assert handler.processor.prompts == ['unusual bracket']
    assert handler.processor.geometric_prompts == [{
        'box': [0.2, 0.3, 0.2, 0.4],
        'label': True,
        'state': handler.processor.states[0],
    }]
    assert shapes[0]['attributes'] == [{'spec_id': 0, 'value': '0.75'}]


@pytest.mark.parametrize('text_prompt, exemplar_bbox', [
    ('object', None),
    (None, [[20, 10], [60, 50]]),
])
def test_concept_accepts_either_text_or_one_exemplar(text_prompt, exemplar_bbox):
    handler = make_handler()
    handler.processor.masks = np.ones((1, 1, 100, 200), dtype=bool)
    handler.processor.scores = np.array([0.5], dtype=np.float32)
    assert len(handler.handle_concept(
        Image.new('RGB', (200, 100)), text_prompt=text_prompt, exemplar_bbox=exemplar_bbox,
    )) == 1


@pytest.mark.parametrize('bbox', [
    [[0, 0]], [[0, 0], [10, 10], [20, 20]], [[10, 10], [10, 20]],
    [[-1, 0], [10, 10]], [[0, 0], [201, 10]], [[0, float('nan')], [10, 10]],
])
def test_concept_rejects_malformed_or_out_of_bounds_exemplars(bbox):
    handler = make_handler()
    with pytest.raises(ValueError, match='exemplar'):
        handler.handle_concept(Image.new('RGB', (200, 100)), text_prompt=None, exemplar_bbox=bbox)


def test_concept_requires_text_or_exemplar():
    with pytest.raises(ValueError, match='text or one positive exemplar'):
        make_handler().handle_concept(
            Image.new('RGB', (200, 100)), text_prompt=None, exemplar_bbox=None,
        )
```

- [ ] **Step 2: Run the adapter tests to verify the new API fails**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping/serverless/pytorch/facebookresearch/sam3/nuclio
python -m pytest test_model_handler.py -q
```

Expected: the new tests fail because `handle_concept` is missing; established single-object, text, refinement, checkpoint, and concurrency tests continue to pass.

- [ ] **Step 3: Implement box validation, normalization, and shared serialization**

Add above `ModelHandler`:

```python
def normalize_exemplar_bbox(obj_bbox, image_size):
    if not isinstance(obj_bbox, list) or len(obj_bbox) != 2:
        raise ValueError('Concept mode requires exactly one positive exemplar bounding box')
    width, height = image_size
    values = []
    for point in obj_bbox:
        if not isinstance(point, list) or len(point) != 2:
            raise ValueError('Concept exemplar must contain two xy coordinate pairs')
        for value in point:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError('Concept exemplar coordinates must be finite numbers')
            values.append(float(value))
    left, top, right, bottom = values[0], values[1], values[2], values[3]
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ValueError('Concept exemplar must have positive area inside the image')
    return [
        (left + right) / (2 * width),
        (top + bottom) / (2 * height),
        (right - left) / width,
        (bottom - top) / height,
    ]
```

Replace `handle_text`'s duplicated output loop with these methods:

```python
def _concept_shapes(self, output):
    masks = output['masks'].detach().cpu().numpy()[:, 0]
    scores = output['scores'].detach().float().cpu().numpy()
    shapes = []
    for mask, score in zip(masks, scores):
        shape = mask_shape(mask, attributes=[{'spec_id': 0, 'value': str(float(score))}])
        if shape is not None:
            shapes.append(shape)
    return shapes

def handle_concept(self, image, *, text_prompt=None, exemplar_bbox=None):
    prompt = text_prompt.strip() if isinstance(text_prompt, str) else None
    box = normalize_exemplar_bbox(exemplar_bbox, image.size) if exemplar_bbox else None
    if not prompt and box is None:
        raise ValueError('Concept mode requires text or one positive exemplar bounding box')

    with self._inference_lock, self._autocast():
        state = self.processor.set_image(image)
        if prompt:
            state = self.processor.set_text_prompt(prompt=prompt, state=state)
        if box is not None:
            state = self.processor.add_geometric_prompt(box=box, label=True, state=state)
        return self._concept_shapes(state)

def handle_text(self, image, *, text_prompt):
    return self.handle_concept(image, text_prompt=text_prompt, exemplar_bbox=None)
```

Also add `import math` if the live handler does not already import it. Keep the inference lock around image setup and both prompt calls so concurrent requests cannot cross-contaminate processor state.

- [ ] **Step 4: Run all model-handler tests**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping/serverless/pytorch/facebookresearch/sam3/nuclio
python -m pytest test_model_handler.py -q
```

Expected: all tests pass, including exact normalized box `[0.2, 0.3, 0.2, 0.4]`, positive label `True`, fresh state per request, confidence attribute id 0, refinement continuity, and concurrency.

### Task 3: Route explicit concept requests while preserving legacy behavior

**Files:**
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_main.py:25-238`
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/main.py:25-70`

- [ ] **Step 1: Extend `DummyModel` and write failing routing tests**

Add `concept_calls = []` and:

```python
def handle_concept(self, image, *, text_prompt, exemplar_bbox):
    self.concept_calls.append({
        'size': image.size, 'text_prompt': text_prompt, 'exemplar_bbox': exemplar_bbox,
    })
    return self.shapes
```

Add tests covering the complete matrix:

```python
@pytest.mark.parametrize('text_prompt, bbox', [
    ('bracket', None),
    (None, [[0, 0], [2, 2]]),
    ('bracket', [[0, 0], [2, 2]]),
])
def test_explicit_concept_mode_accepts_text_exemplar_or_both(text_prompt, bbox):
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    body = {'image': encode_image(), 'prompt_mode': 'concept', 'pos_points': [], 'neg_points': []}
    if text_prompt is not None:
        body['text_prompt'] = text_prompt
    if bbox is not None:
        body['obj_bbox'] = bbox
    response = main.handler(context, SimpleNamespace(body=body))
    assert response.status_code == 200
    assert json.loads(response.body) == {'shapes': model.shapes}
    assert model.concept_calls == [{
        'size': (2, 2), 'text_prompt': text_prompt, 'exemplar_bbox': bbox,
    }]


@pytest.mark.parametrize('body, message', [
    ({'prompt_mode': 'unknown'}, 'prompt_mode'),
    ({'prompt_mode': 'concept'}, 'text or one positive exemplar'),
    ({'prompt_mode': 'concept', 'text_prompt': 'cat', 'pos_points': [[0, 0]]}, 'points'),
    ({'prompt_mode': 'concept', 'neg_points': [[0, 0]], 'obj_bbox': [[0, 0], [1, 1]]}, 'points'),
    ({'prompt_mode': 'single_object', 'text_prompt': 'cat'}, 'single-object'),
])
def test_explicit_prompt_modes_reject_invalid_combinations_before_image_decode(body, message):
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    response = main.handler(context, SimpleNamespace(body=body))
    assert response.status_code == 400
    assert message in json.loads(response.body)['error']
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


def test_legacy_requests_keep_existing_routing():
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    text_response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(), 'text_prompt': 'cat',
    }))
    box_response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(), 'pos_points': [], 'neg_points': [],
        'obj_bbox': [[0, 0], [1, 1]],
    }))
    assert text_response.status_code == box_response.status_code == 200
    assert len(model.text_calls) == 1
    assert len(model.calls) == 1
```

Retain the established test that rejects legacy text mixed with a box or points.

- [ ] **Step 2: Run tests to verify explicit concept routing fails**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping/serverless/pytorch/facebookresearch/sam3/nuclio
python -m pytest test_main.py -q
```

Expected: the new explicit-mode tests fail while legacy tests remain green.

- [ ] **Step 3: Implement the routing state machine**

Refactor `handler` so validation occurs before base64 decoding, using this decision order:

```python
data = event.body
refining = 'refinement_mask' in data
explicit_mode = data.get('prompt_mode')
if explicit_mode is not None and explicit_mode not in {'single_object', 'concept'}:
    return error_response(context, 'prompt_mode must be single_object or concept')

legacy_request = explicit_mode is None
prompt_mode = explicit_mode or ('concept' if 'text_prompt' in data else 'single_object')
text_prompt = None
if 'text_prompt' in data:
    text_prompt = data['text_prompt']
    if not isinstance(text_prompt, str):
        return error_response(context, 'Text prompt must be a string')
    text_prompt = text_prompt.strip()
    if not text_prompt:
        return error_response(context, 'Text prompt must not be empty')
    if len(text_prompt) > 256:
        return error_response(context, 'Text prompt must contain at most 256 characters')

if refining:
    if 'text_prompt' in data or data.get('obj_bbox'):
        return error_response(context, 'Mask refinement cannot be combined with text or a bounding box')
elif legacy_request and text_prompt is not None and any(
    data.get(name) for name in ('pos_points', 'neg_points', 'obj_bbox')
):
    return error_response(context, 'Text prompt cannot be combined with points or a bounding box')
elif prompt_mode == 'concept':
    if data.get('pos_points') or data.get('neg_points'):
        return error_response(context, 'Concept mode cannot be combined with positive or negative points')
    if text_prompt is None and not data.get('obj_bbox'):
        return error_response(context, 'Concept mode requires text or one positive exemplar bounding box')
elif text_prompt is not None:
    return error_response(context, 'Text is not supported in single-object mode')
```

After image decoding, use this complete routing order:

```python
if refining:
    try:
        shapes = context.user_data.model.handle_refine(
            image,
            refinement_mask=data['refinement_mask'],
            pos_points=data.get('pos_points', []),
            neg_points=data.get('neg_points', []),
        )
    except ValueError as error:
        return error_response(context, error)
    result = {'shapes': shapes}
elif legacy_request and text_prompt is not None:
    result = {'shapes': context.user_data.model.handle_text(image, text_prompt=text_prompt)}
elif prompt_mode == 'concept':
    try:
        shapes = context.user_data.model.handle_concept(
            image,
            text_prompt=text_prompt,
            exemplar_bbox=data.get('obj_bbox') or None,
        )
    except ValueError as error:
        return error_response(context, error)
    result = {'shapes': shapes}
else:
    result = {'mask': context.user_data.model.handle(
        image,
        pos_points=data.get('pos_points', []),
        neg_points=data.get('neg_points', []),
        obj_bbox=data.get('obj_bbox'),
    )}
```

This keeps legacy text-only routing through `handle_text` so existing tests and external callers retain the named adapter, and keeps refinement ahead of both modes.

- [ ] **Step 4: Run handler and model tests**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping/serverless/pytorch/facebookresearch/sam3/nuclio
python -m pytest test_main.py test_model_handler.py -q
```

Expected: all tests pass; malformed mode/prompt combinations return HTTP 400 before image decoding or inference.

### Task 4: Advertise the capability without exposing a generic parameter control

**Files:**
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml:13-31`
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_function_gpu.py:133-151`
- Modify: `cvat-ui/src/components/common/model-extra-params-form.tsx`

- [ ] **Step 1: Make the manifest test require concept exemplar metadata**

Change the expected text schema entry to include:

```python
'supports_concept_box': True,
```

Also assert:

```python
assert 'Find similar objects' in annotations['help_message']
assert 'positive exemplar box' in annotations['help_message']
```

- [ ] **Step 2: Run the manifest test to verify it fails**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping/serverless/pytorch/facebookresearch/sam3/nuclio
python -m pytest test_function_gpu.py::test_manifest_declares_text_capability_and_preserves_optional_visual_prompts -q
```

Expected: FAIL because `supports_concept_box` and the new help copy are absent.

- [ ] **Step 3: Update the manifest and frontend schema type**

In the `text_prompt` schema object add:

```json
"supports_concept_box": true
```

Set the help text to:

```text
Use Single object for points and an optional starting box. Use Find similar objects with text, one positive exemplar box, or both; then select a returned mask for point refinement.
```

Add this optional property to `ModelExtraParamSchemaItem` in `model-extra-params-form.tsx`:

```typescript
supports_concept_box?: boolean;
```

The generic form must ignore this metadata; only `tools-control.tsx` reads it.

- [ ] **Step 4: Run manifest and type tests**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
python -m pytest serverless/pytorch/facebookresearch/sam3/nuclio/test_function_gpu.py -q
/data/cvat/node_modules/.bin/tsc -p cvat-ui/tsconfig.json
```

Expected: all manifest tests and TypeScript checks pass; checkpoint path/hash, pinned packages, read-only volume, GPU resource, and model name remain unchanged.

### Task 5: Add frontend concept-mode controller behavior

**Files:**
- Modify: `tests/unit/interactor-harness.cjs:60-91`
- Create: `tests/unit/interactor-concept-prompts.cjs`
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx:169-1905`

- [ ] **Step 1: Update the harness capability and write failing controller tests**

Change `textSchema` to:

```javascript
const textSchema = {
    name: 'text_prompt', type: 'text', default: '', max_length: 256,
    supports_mask_refinement: true, supports_concept_box: true,
};
```

Change the harness signature from:

```javascript
function create({ activated = false, blocked = false, schema = [textSchema] } = {}) {
```

to:

```javascript
function create({
    activated = false, blocked = false, schema = [textSchema], promptMode = 'concept',
} = {}) {
```

Replace the old final assignment:

```javascript
component.state.interactorPromptMode = 'text';
```

with:

```javascript
component.state.interactorPromptMode = promptMode;
component.state.conceptUsesBox = false;
```

Leave the fixture's props, synchronous `setState`, request interception, text value, touched map, and return object unchanged.

Create `tests/unit/interactor-concept-prompts.cjs` with tests that assert:

```javascript
test('single object remains the default and sends no prompt_mode', async () => {
    const { component, requests } = create({ activated: true });
    component.state.interactorPromptMode = 'single_object';
    await component.interactionListener(event([
        { shapeType: 'points', type: 'positive', points: [30, 40] },
    ]));
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, {});
});

test('concept text-only sends an explicit concept request and preserves ROI', () => {
    const { component, requests } = create();
    component.state.interactorPromptMode = 'concept';
    component.state.conceptUsesBox = false;
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    button(component).props.onClick();
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].extraParams, {
        prompt_mode: 'concept', text_prompt: 'red circles',
    });
    assert.deepEqual(requests[0].data.roi, [10, 20, 200, 220]);
});

test('concept exemplar-only waits for one box then sends no points', async () => {
    const { component, commands, requests } = create({ activated: true });
    component.state.interactorPromptMode = 'concept';
    component.state.conceptUsesBox = true;
    component.state.interactorExtraParams.text_prompt = '';
    button(component).props.onClick();
    assert.equal(commands.at(-1).command, 'draw_box');
    assert.equal(requests.length, 0);
    await component.interactionListener(event([
        { shapeType: 'rectangle', type: 'positive', points: [20, 30, 80, 90] },
    ]));
    assert.deepEqual(requests.at(-1).extraParams, { prompt_mode: 'concept' });
    assert.deepEqual(requests.at(-1).data.obj_bbox, [[20, 30], [80, 90]]);
    assert.deepEqual(requests.at(-1).data.pos_points, []);
    assert.deepEqual(requests.at(-1).data.neg_points, []);
});

test('concept text plus exemplar snapshots both prompts while blocked', async () => {
    const { component } = create({ activated: true, blocked: true });
    component.state.interactorPromptMode = 'concept';
    component.state.conceptUsesBox = true;
    await component.interactionListener(event([
        { shapeType: 'rectangle', type: 'positive', points: [20, 30, 80, 90] },
    ]));
    assert.deepEqual(component.interaction.latestPostponedRequest.extraParams, {
        prompt_mode: 'concept', text_prompt: 'red circles',
    });
});

test('selecting a concept result retains refinement and omits concept prompts', async () => {
    const { component, requests } = create({ activated: true });
    component.state.interactorPromptMode = 'concept';
    component.interaction.latestResponse = [{
        rle: Int32Array.from([0, 100, 30, 40, 39, 49]), confidence: 0.8,
        points: [[30, 40], [39, 40], [39, 49]], contours: [], approximatedPoints: [], labelName: null,
    }];
    component.state.interactorResponseReceived = true;
    component.selectRefinementMask(0);
    await component.interactionListener(event([
        { shapeType: 'points', type: 'positive', points: [35, 45] },
    ]));
    assert.ok(requests.at(-1).extraParams.refinement_mask);
    assert.equal('prompt_mode' in requests.at(-1).extraParams, false);
    assert.equal('text_prompt' in requests.at(-1).extraParams, false);
});
```

Add these additional tests in the same file:

```javascript
test('blank text disables text-only but permits exemplar-only', () => {
    const { component } = create();
    component.state.interactorPromptMode = 'concept';
    component.state.interactorExtraParams.text_prompt = '   ';
    component.state.conceptUsesBox = false;
    assert.equal(button(component).props.disabled, true);
    component.state.conceptUsesBox = true;
    assert.equal(button(component).props.disabled, false);
});

test('concept mode never submits more than one exemplar box', async () => {
    const { component, requests } = create({ activated: true });
    component.state.interactorPromptMode = 'concept';
    component.state.conceptUsesBox = true;
    const rectangle = (points) => ({ shapeType: 'rectangle', type: 'positive', points });
    await component.interactionListener(event([
        rectangle([20, 30, 80, 90]), rectangle([100, 110, 160, 170]),
    ]));
    assert.equal(requests.length, 0);
});

test('switching interactors restores the single-object default', () => {
    const { component } = create();
    component.state.interactorPromptMode = 'concept';
    component.state.conceptUsesBox = true;
    component.props.interactors.push({
        ...component.props.interactors[0], id: 'other', name: 'Other', extraParamsSchema: [],
    });
    component.setActiveInteractor('other');
    assert.equal(component.state.interactorPromptMode, 'single_object');
    assert.equal(component.state.conceptUsesBox, false);
});

test('repeat restores the submitted concept text exemplar flag and ROI', async () => {
    const { component } = create();
    component.state.interactorPromptMode = 'concept';
    component.state.conceptUsesBox = true;
    component.state.interactorRegionOfInterest = [10, 20, 200, 220];
    button(component).props.onClick();
    await component.interactionListener(event([
        { shapeType: 'rectangle', type: 'positive', points: [20, 30, 80, 90] },
    ]));
    changeProps(component, { isActivated: false });
    component.state.interactorPromptMode = 'single_object';
    component.state.conceptUsesBox = false;
    component.state.interactorExtraParams.text_prompt = 'changed';
    changeProps(component, { isActivated: true });
    assert.equal(component.state.interactorPromptMode, 'concept');
    assert.equal(component.state.conceptUsesBox, true);
    assert.equal(component.state.interactorExtraParams.text_prompt.trim(), 'red circles');
    assert.deepEqual(component.state.interactorRegionOfInterest, [10, 20, 200, 220]);
});

test('starting a new concept run clears result-specific state', () => {
    const { component } = create();
    component.state.interactorPromptMode = 'concept';
    component.interaction.latestResponse = [{ rle: Int32Array.from([0, 1, 0, 0, 0, 0]) }];
    component.state.refiningMask = 0;
    component.maskAdjustments.set(0, { value: 2 });
    button(component).props.onClick();
    assert.deepEqual(component.interaction.latestResponse, []);
    assert.equal(component.state.refiningMask, null);
    assert.equal(component.maskAdjustments.size, 0);
});
```

Import `changeProps` from `interactor-harness.cjs` for the repeat test. Keep the existing ROI assertion in the text-only request test; CVAT's lambda-manager tests already cover ROI translation before Nuclio receives the box.

- [ ] **Step 2: Run the new controller test to verify it fails**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
node --test tests/unit/interactor-concept-prompts.cjs
```

Expected: FAIL because the state still uses `points|text`, `conceptUsesBox` is absent, and requests do not carry `prompt_mode`.

- [ ] **Step 3: Implement explicit frontend state and request snapshots**

Change the state contract to:

```typescript
interactorPromptMode: 'single_object' | 'concept';
conceptUsesBox: boolean;
```

Initialize and reset these as:

```typescript
interactorPromptMode: 'single_object',
conceptUsesBox: false,
```

Include `conceptUsesBox` in `lastInteractorSetup`. Define:

```typescript
private supportsConceptPrompting(): boolean {
    return !!this.state.activeInteractor?.extraParamsSchema?.some(
        (param: ModelExtraParamSchemaItem) => param.name === 'text_prompt' &&
            param.type === 'text' && param.supports_concept_box === true,
    );
}
```

Update `supportsMaskRefinement()` to require `interactorPromptMode === 'concept'` and the existing `supports_mask_refinement` flag.

In `onInteraction`, include text and the explicit mode only for a fresh concept request:

```typescript
if (!refinement && interactorPromptMode === 'concept') {
    filteredExtraParams.prompt_mode = 'concept';
    if (typeof interactorExtraParams.text_prompt === 'string' && interactorExtraParams.text_prompt.trim()) {
        filteredExtraParams.text_prompt = interactorExtraParams.text_prompt.trim();
    }
}
```

For single-object and refinement requests, omit both `prompt_mode` and `text_prompt`. Before enqueuing concept inference, reject point shapes and require at most one box. Snapshot the current text, box flag, mapping, and ROI into `InteractionRequest` exactly as the existing blocked-request path does.

- [ ] **Step 4: Implement mode-specific canvas activation**

For `concept`:

```typescript
const parameters = conceptUsesBox ? {
    command: 'draw_box' as const,
    settings: {
        crosshair: true,
        ...(this.state.interactorRegionOfInterest ? {
            regionOfInterest: this.state.interactorRegionOfInterest,
        } : {}),
    },
} : {
    command: 'put_shapes' as const,
    payload: { shapes: [] },
    settings: { crosshair: false },
};
```

Text-only concept activation immediately invokes `onInteraction` after the interaction session is reset. Exemplar mode waits for the canvas box event. Single-object activation retains the existing optional-box/points parameters.

At the start of every new concept run, call the existing invalidation and clearing operations:

```typescript
this.clearMaskAdjustments();
this.refinement = null;
this.refinementRevision++;
this.interaction.latestRequest = null;
this.interaction.latestPostponedRequest = null;
this.interaction.latestResponse = [];
```

Then set `interactorResponseReceived: false`, `showConfidenceControl: false`, and `refiningMask: null` before activating the canvas.

- [ ] **Step 5: Run controller and regression tests**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
node --test tests/unit/interactor-concept-prompts.cjs
node --test tests/unit/interactor-box-transition.cjs
node --test tests/unit/interactor-text-prompts.cjs
node --test tests/unit/interactor-text-refinement.cjs
node --test tests/unit/interactor-mask-morphology.cjs
```

Expected: all pass. Rename established text-mode test descriptions and state setup to concept mode without reducing their assertions.

### Task 6: Render the approved two-mode UI and label-name shortcut

**Files:**
- Modify: `tests/unit/interactor-concept-prompts.cjs`
- Modify: `cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx:1699-1925`

- [ ] **Step 1: Add failing rendered-control assertions**

Add these exact rendered-control tests:

```javascript
test('concept-capable SAM3 renders explicit task modes with single object selected', () => {
    const { component } = create({ promptMode: 'single_object' });
    const rendered = component.renderInteractorBlock();
    const modes = find(rendered, (element) => element.props?.['aria-label'] === 'SAM3 task mode');
    assert.equal(modes.props.value, 'single_object');
    assert.deepEqual(modes.props.options, [
        { label: 'Single object', value: 'single_object' },
        { label: 'Find similar objects', value: 'concept' },
    ]);
    assert.equal(button(component).props.children, 'Interact');
});

test('concept controls copy the active label into an editable text prompt', () => {
    const { component } = create({ promptMode: 'concept' });
    let rendered = component.renderInteractorBlock();
    const useLabel = find(rendered, (element) => element.props?.children === 'Use label name');
    const exemplar = find(rendered, (element) => (
        element.props?.['aria-label'] === 'Add positive exemplar box'
    ));
    assert.ok(useLabel);
    assert.ok(exemplar);
    useLabel.props.onClick();
    assert.equal(component.state.interactorExtraParams.text_prompt, 'defect');

    const Form = dependencies['components/common/model-extra-params-form'].default;
    const form = Form({
        schema: [textSchema], values: component.state.interactorExtraParams,
        onChange: (name, value) => {
            component.state.interactorExtraParams[name] = value;
        },
    });
    const input = find(form, (element) => element.type === dependencies['antd/lib/input']);
    input.props.onChange({ target: { value: 'edited label description' } });
    assert.equal(component.state.interactorExtraParams.text_prompt, 'edited label description');
    assert.equal(button(component).props.children, 'Find masks');
});

test('interactors without concept capability keep their existing controls', () => {
    const { component } = create({ schema: [], promptMode: 'single_object' });
    const modes = find(
        component.renderInteractorBlock(),
        (element) => element.props?.['aria-label'] === 'SAM3 task mode',
    );
    assert.equal(modes, undefined);
    assert.equal(button(component).props.children, 'Interact');
});
```

Import `dependencies` from `interactor-harness.cjs` for the editable-field test.

- [ ] **Step 2: Run the rendered-control test to verify it fails**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
node --test tests/unit/interactor-concept-prompts.cjs
```

Expected: FAIL against the old `Points / box` and `Text` controls.

- [ ] **Step 3: Replace the old prompt-mode controls**

When `supportsConceptPrompting()` is true, render a button-style `Radio.Group`:

```typescript
aria-label='SAM3 task mode'
options={[
    { label: 'Single object', value: 'single_object' },
    { label: 'Find similar objects', value: 'concept' },
]}
```

In concept mode, render the text form with title `Concept description`, a small `Use label name` button, and a switch labeled `Add positive exemplar box`. The shortcut handler is:

```typescript
const activeLabel = labels.find((label) => label.id === activeLabelID);
const useLabelName = (): void => {
    if (activeLabel) changeExtraParam('text_prompt', activeLabel.name);
};
```

Give the exemplar switch `aria-label='Add positive exemplar box'`. Disable the shortcut only when no active label exists. Keep ROI and mask conversion below this mode-specific area. Keep `data-primary-action='true'` on the main button so the existing Enter handler submits the focused form.

The main button is enabled in concept mode when:

```typescript
const validConceptPrompt = validTextPrompt || conceptUsesBox;
```

Use `Find masks` for concept and `Interact` for single-object mode.

- [ ] **Step 4: Run UI tests and static checks**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
node --test tests/unit/interactor-concept-prompts.cjs
node --test tests/unit/primary-action-enter.cjs
/data/cvat/node_modules/.bin/eslint \
    cvat-ui/src/components/common/model-extra-params-form.tsx \
    cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx \
    tests/unit/interactor-harness.cjs tests/unit/interactor-concept-prompts.cjs
/data/cvat/node_modules/.bin/tsc -p cvat-ui/tsconfig.json
```

Expected: all tests and static checks pass. Enter from the concept text input triggers `Find masks` once; Enter never submits while a select is open, during IME composition, with modifiers, while loading, or when disabled.

### Task 7: Verify the entire SAM3 function and UI candidate

**Files:**
- Test: all SAM3 Nuclio tests
- Test: all custom AI Tools unit tests
- Create: `data/deployments/sam3/concept-exemplar/candidate-receipt.json`

- [ ] **Step 1: Run the complete focused suites**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
python -m pytest serverless/pytorch/facebookresearch/sam3/nuclio -q
for test_file in tests/unit/*.cjs; do node --test "$test_file"; done
/data/cvat/node_modules/.bin/tsc -p cvat-ui/tsconfig.json
/data/cvat/node_modules/.bin/eslint \
    cvat-ui/src/components/common/model-extra-params-form.tsx \
    cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx
/data/cvat/node_modules/.bin/stylelint 'cvat-ui/src/**/*.scss'
(cd cvat-ui && /data/cvat/node_modules/.bin/webpack --config ./webpack.config.js)
```

Expected: all SAM3 and UI tests pass; TypeScript, ESLint, stylelint, and production build exit zero. Existing asset-size warnings are acceptable.

- [ ] **Step 2: Build immutable UI and SAM3 images without changing production**

Run:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
docker build -f Dockerfile.ui -t cvat/ui:sam3-concept-indoor-mapping-20260905 .
nuctl build pth-facebookresearch-sam3-interactor \
    --platform local --namespace nuclio --project-name cvat \
    --path serverless/pytorch/facebookresearch/sam3/nuclio \
    --file serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml \
    --image cvat.pth.facebookresearch.sam3.interactor:concept-exemplar-20260905 \
    --output-image-file /data/cvat/data/deployments/sam3/concept-exemplar/image-name.txt
```

Expected: both image IDs exist locally; `nuctl get functions --platform local --namespace nuclio --project-name cvat` still reports the live refinement-continuity image because `build` does not deploy.

- [ ] **Step 3: Run a packaged GPU smoke with no annotation writes**

Start a temporary container from the candidate SAM3 image on a spare GPU, mount `/data/cvat/data/models/sam3` read-only, and call `ModelHandler.handle_concept` for:

```text
text only: "concrete surface"
exemplar only: [[900, 250], [1800, 900]] on the read-only job 182 frame 0 image
combined: "concrete surface" plus the same exemplar
```

For each result, assert: inference succeeds; every shape has valid row-major RLE within the submitted image; every confidence parses to a finite value in `[0, 1]`; replaying the same request produces identical masks and scores. Record result count, timing, mask hashes, and whether combined prompting changes the text-only result set. This smoke proves plumbing and determinism; it does not impose a semantic quality threshold on one exemplar.

- [ ] **Step 4: Run browser coverage against the candidate UI**

Verify actual CVAT/AntD controls for:

```text
default Single object points
default Single object optional box then points
concept text only
concept exemplar only
concept text plus exemplar
concept request with ROI
confidence filtering
candidate selection and point refinement
selected-mask erosion/dilation
Use label name then edit
Enter submission
mode/interactor/frame/repeat transitions
420px viewport and normal desktop viewport
```

Expected: no duplicate calls, stale masks, clipped controls, browser console errors, or annotation writes.

- [ ] **Step 5: Write the candidate receipt and stop before deployment**

Record source hashes, inherited UI and SAM3 deployment receipts, exact test counts, build logs, immutable image IDs, packaged GPU outputs, browser outputs, checkpoint hash/path, and live preflight container IDs. Include:

```json
{
  "candidate_ready": true,
  "production_changed": false,
  "annotation_writes": 0,
  "project40_changed": false,
  "indoor_v3_changed": false
}
```

Expected: valid receipt with existing artifact paths. Do not deploy either image in this task.

- [ ] **Step 6: Stop at the commit boundary unless the user explicitly authorizes commits**

After authorization, use separate commits for the backend contract and UI behavior:

```bash
cd /data/cvat/.worktrees/sam3-concept-indoor-mapping
git add serverless/pytorch/facebookresearch/sam3/nuclio
git commit -m "feat(sam3): add concept exemplar prompting"
git add cvat-ui/src/components/common/model-extra-params-form.tsx \
    cvat-ui/src/components/annotation-page/standard-workspace/controls-side-bar/tools-control.tsx \
    tests/unit/interactor-harness.cjs tests/unit/interactor-concept-prompts.cjs
git commit -m "feat(ui): add SAM3 find-similar mode"
```

Expected: two reviewable commits. Without authorization, retain verified changes uncommitted.

### Task 8: Deploy UI and SAM3 after explicit deployment authorization

**Files:**
- Create: `data/deployments/sam3/concept-exemplar/function-candidate-runtime.yaml`
- Create: `data/deployments/sam3/concept-exemplar/function-rollback-runtime.yaml`
- Create: `data/deployments/sam3/concept-exemplar/deployment-receipt.json`

- [ ] **Step 1: Prepare concrete rollback artifacts and request deployment authorization**

Export the live Nuclio function, copy it to `function-rollback-runtime.yaml`, create `function-candidate-runtime.yaml` by changing only the image tag and the approved annotations, and tag the live UI as `cvat/ui:rollback-before-sam3-concept-indoor-mapping-20260905`. Present image IDs and exact changed targets:

```text
cvat_ui
nuclio-nuclio-pth-facebookresearch-sam3-interactor
```

Wait for explicit deployment authorization.

- [ ] **Step 2: Replace only the two authorized targets**

After authorization, deploy SAM3 without rebuilding:

```bash
cd /data/cvat
nuctl deploy pth-facebookresearch-sam3-interactor \
    --platform local --namespace nuclio --project-name cvat \
    --file data/deployments/sam3/concept-exemplar/function-candidate-runtime.yaml \
    --run-image cvat.pth.facebookresearch.sam3.interactor:concept-exemplar-20260905 \
    --no-pull
```

Then replace only `cvat_ui` using the same five Compose files recorded in the Indoor mapping plan:

```bash
docker tag cvat/ui:sam3-concept-indoor-mapping-20260905 cvat/ui:dev
docker compose --project-directory /data/cvat --env-file /data/cvat/.env \
    -f /data/cvat/docker-compose.yml \
    -f /data/cvat/docker-compose.no-traefik.yml \
    -f /data/cvat/docker-compose.override.yml \
    -f /data/cvat/components/serverless/docker-compose.serverless.yml \
    -f /data/cvat/.worktrees/cvat-postmark-relay/docker-compose.email-relay.yml \
    up -d --no-deps cvat_ui
```

Expected: SAM3 becomes `ready`; only SAM3 and `cvat_ui` container IDs change; Indoor v3 and every other service retain their IDs.

- [ ] **Step 3: Probe the live gateway and public UI**

Through CVAT's live LambdaFunction/gateway, submit text-only, exemplar-only, and combined requests against job 182 frame 0. Assert valid masks/confidences, deterministic replay, ROI coordinate translation, and HTTP 200. In the public browser, verify both modes, label shortcut, confidence filter, refinement, morphology, and Enter submission after a hard reload.

Expected: live outputs match packaged-candidate hashes for identical inputs; no annotations are created until `Done`; public and local bundles match the candidate SHA-256; API/about and favicon return HTTP 200.

- [ ] **Step 4: Write the deployment receipt**

Record authorization text, timestamps, old/new image and container IDs, unchanged services, runtime YAML hashes, live gateway output hashes, UI bundle hashes, browser results, and rollback commands. State whether Project 40 mutation was performed separately and confirm Indoor v3 was not redeployed.
