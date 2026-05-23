# RF-DETR Interactor Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent request-summary logging to the RF-DETR shape and stain interactors so empty-result requests can be traced through the request and filtering pipeline.

**Architecture:** Keep the logging additive and local to the two RF-DETR function folders. Add request-boundary summary logs in `main.py` and pipeline-stage summary logs in `model_handler.py`, with small test updates that verify the emitted log messages without changing inference behavior.

**Tech Stack:** Python, pytest, Nuclio `context.logger`, existing RF-DETR interactor handlers under `serverless/pytorch/rfdetr`.

---

## File Structure

### Files to modify

- `serverless/pytorch/rfdetr/eagle-shape-v5/main.py`
  - Add request-boundary summary logging for shape requests.
- `serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py`
  - Add pipeline-stage summary logging for shape requests.
- `serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py`
  - Verify request-boundary logs are emitted.
- `serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py`
  - Verify pipeline-stage summary logs are emitted.
- `serverless/pytorch/rfdetr/eagle-stain-v5/main.py`
  - Add request-boundary summary logging for stain requests.
- `serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py`
  - Add pipeline-stage summary logging for stain requests.
- `serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py`
  - Verify request-boundary logs are emitted.
- `serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py`
  - Verify pipeline-stage summary logs are emitted.

### File responsibilities

- `main.py` stays the Nuclio request entrypoint and should only log request/response summary information.
- `model_handler.py` stays the place that knows the interactor filtering pipeline and should log stage counts there rather than inside backend math.
- The two test files per function should only verify logging behavior at those same boundaries.

## Task 1: Add request-boundary logging in both `main.py` files

**Files:**
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/main.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py`

- [ ] **Step 1: Write the failing shape request-logging test**

Add this test to `serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py`:

```python
def test_handler_logs_request_summary():
    messages = []

    class LoggingContext(DummyContext):
        def __init__(self):
            super().__init__()
            self.logger = SimpleNamespace(info=lambda message: messages.append(message))

    context = LoggingContext()
    context.user_data.model = DummyModel()
    event = SimpleNamespace(body={
        'image': encode_image(),
        'obj_bbox': [[1, 1], [3, 3]],
        'mapping': {'(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}}},
    })

    main.handler(context, event)

    assert any('request summary' in message for message in messages)
    assert any('bbox=[[1, 1], [3, 3]]' in message for message in messages)
    assert any('mapping_keys=1' in message for message in messages)
    assert any('returned_shapes=1' in message for message in messages)
```

- [ ] **Step 2: Run the shape request-logging test and verify it fails**

Run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py::test_handler_logs_request_summary -q
```

Expected: FAIL because `main.handler()` does not yet emit the new request-summary log line.

- [ ] **Step 3: Implement shape request-boundary logging**

Update `serverless/pytorch/rfdetr/eagle-shape-v5/main.py` so `handler()` logs request and response summaries:

```python
def handler(context, event):
    data = event.body
    buf = io.BytesIO(base64.b64decode(data['image']))
    image = Image.open(buf).convert('RGB')
    obj_bbox = data.get('obj_bbox')
    mapping = data.get('mapping', {})

    context.logger.info(
        'RF-DETR shape request summary: '
        f'image_size={image.size} '
        f'bbox={obj_bbox} '
        f'mapping_keys={len(mapping)} '
        f'mapping_labels={sorted(mapping.keys())}'
    )

    shapes = context.user_data.model.handle(
        image=image,
        obj_bbox=obj_bbox,
        mapping=mapping,
    )

    context.logger.info(
        'RF-DETR shape response summary: '
        f'returned_shapes={len(shapes)}'
    )

    return context.Response(
        body=json.dumps({'shapes': shapes}),
        headers={},
        content_type='application/json',
        status_code=200,
    )
```

- [ ] **Step 4: Re-run the shape request-logging test and verify it passes**

Run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py::test_handler_logs_request_summary -q
```

Expected: PASS.

- [ ] **Step 5: Repeat the same red-green cycle for the stain request boundary**

Add this test to `serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py`:

```python
def test_handler_logs_request_summary():
    messages = []

    class LoggingContext(DummyContext):
        def __init__(self):
            super().__init__()
            self.logger = SimpleNamespace(info=lambda message: messages.append(message))

    context = LoggingContext()
    context.user_data.model = DummyModel()
    event = SimpleNamespace(body={
        'image': encode_image(),
        'obj_bbox': [[1, 1], [3, 3]],
        'mapping': {'(C5) infiltraz_cls': {'name': 'infiltraz_cls', 'attributes': {}}},
    })

    main.handler(context, event)

    assert any('request summary' in message for message in messages)
    assert any('bbox=[[1, 1], [3, 3]]' in message for message in messages)
    assert any('mapping_keys=1' in message for message in messages)
    assert any('returned_shapes=1' in message for message in messages)
```

Then run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py::test_handler_logs_request_summary -q
```

Expected: FAIL before implementation, PASS after updating `serverless/pytorch/rfdetr/eagle-stain-v5/main.py` with the analogous `RF-DETR stain request summary` and `RF-DETR stain response summary` log lines.

- [ ] **Step 6: Run both `test_main.py` files and verify they pass**

Run:

```bash
cd /data/cvat && pytest \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py \
  -q
```

Expected: PASS for all tests in both files.

- [ ] **Step 7: Commit the request-boundary logging changes**

```bash
cd /data/cvat && git add \
  serverless/pytorch/rfdetr/eagle-shape-v5/main.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/main.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py && \
  git commit -m "feat: log RF-DETR interactor request summaries"
```

## Task 2: Add pipeline-stage summary logging in both `model_handler.py` files

**Files:**
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py`

- [ ] **Step 1: Write the failing shape pipeline-summary test**

Add this test to `serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py`:

```python
def test_handle_logs_pipeline_summary(monkeypatch):
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', DummyBackend)

    messages = []
    monkeypatch.setattr('model_handler.LOGGER', SimpleNamespace(info=lambda message: messages.append(message)))

    handler = ModelHandler()
    image = Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8))

    handler.handle(
        image=image,
        obj_bbox=[[0, 0], [39, 29]],
        mapping={'(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}}},
    )

    assert any('pipeline summary' in message for message in messages)
    assert any('raw_predictions=2' in message for message in messages)
    assert any('clipped_predictions=2' in message for message in messages)
    assert any('kept_predictions=2' in message for message in messages)
    assert any('unmapped_predictions=1' in message for message in messages)
    assert any('empty_projected_masks=0' in message for message in messages)
    assert any('returned_shapes=1' in message for message in messages)
```

- [ ] **Step 2: Run the shape pipeline-summary test and verify it fails**

Run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py::test_handle_logs_pipeline_summary -q
```

Expected: FAIL because `LOGGER` and the summary log line do not yet exist.

- [ ] **Step 3: Implement shape pipeline-summary logging**

Update `serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py` to add a module logger and emit one summary line at the end of `handle()`:

```python
import logging
import os
from pathlib import Path

LOGGER = logging.getLogger(__name__)
```

and inside `handle()` compute and log the stage counts:

```python
        raw_predictions = len(predicted)
        clipped_predictions = len(clipped)
        kept_predictions = len(kept)
        unmapped_predictions = 0
        empty_projected_masks = 0

        shapes = []
        for instance in kept:
            if instance.class_name not in mapping:
                unmapped_predictions += 1
                continue

            full_mask = project_mask_to_image(instance.mask, prepared)
            if not full_mask.any():
                empty_projected_masks += 1
                continue

            shapes.append({
                'label': mapping[instance.class_name]['name'],
                'type': 'mask',
                'points': mask_to_rle(full_mask),
                'attributes': [{
                    'spec_id': 0,
                    'value': f'{instance.score:.6f}',
                }],
            })

        LOGGER.info(
            'RF-DETR shape pipeline summary: '
            f'raw_predictions={raw_predictions} '
            f'clipped_predictions={clipped_predictions} '
            f'kept_predictions={kept_predictions} '
            f'unmapped_predictions={unmapped_predictions} '
            f'empty_projected_masks={empty_projected_masks} '
            f'returned_shapes={len(shapes)}'
        )
```

- [ ] **Step 4: Re-run the shape pipeline-summary test and verify it passes**

Run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py::test_handle_logs_pipeline_summary -q
```

Expected: PASS.

- [ ] **Step 5: Repeat the same red-green cycle for the stain pipeline summary**

Add the analogous test to `serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py`:

```python
def test_handle_logs_pipeline_summary(monkeypatch):
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    monkeypatch.setattr('model_handler.RFDETRStainBackend', DummyBackend)

    messages = []
    monkeypatch.setattr('model_handler.LOGGER', SimpleNamespace(info=lambda message: messages.append(message)))

    handler = ModelHandler()
    image = Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8))

    handler.handle(
        image=image,
        obj_bbox=[[0, 0], [39, 29]],
        mapping={'(C5) infiltraz_cls': {'name': 'infiltraz_cls', 'attributes': {}}},
    )

    assert any('pipeline summary' in message for message in messages)
    assert any('raw_predictions=2' in message for message in messages)
    assert any('clipped_predictions=2' in message for message in messages)
    assert any('kept_predictions=2' in message for message in messages)
    assert any('unmapped_predictions=1' in message for message in messages)
    assert any('empty_projected_masks=0' in message for message in messages)
    assert any('returned_shapes=1' in message for message in messages)
```

Then run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py::test_handle_logs_pipeline_summary -q
```

Expected: FAIL before implementation, PASS after adding the analogous `RF-DETR stain pipeline summary` log line to `serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py`.

- [ ] **Step 6: Run both full RF-DETR test suites and verify they pass**

Run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-shape-v5 -q && \
pytest serverless/pytorch/rfdetr/eagle-stain-v5 -q
```

Expected: PASS for both suites.

- [ ] **Step 7: Commit the pipeline-summary logging changes**

```bash
cd /data/cvat && git add \
  serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py && \
  git commit -m "feat: log RF-DETR interactor pipeline summaries"
```

## Task 3: Redeploy and verify the new logs appear in runtime

**Files:**
- Verify: `serverless/pytorch/rfdetr/eagle-shape-v5`
- Verify: `serverless/pytorch/rfdetr/eagle-stain-v5`

- [ ] **Step 1: Redeploy the RF-DETR functions**

Run:

```bash
cd /data/cvat && ./serverless/deploy_gpu.sh serverless/pytorch/rfdetr
```

Expected: both RF-DETR functions redeploy successfully and appear in `nuctl get function --platform local`.

- [ ] **Step 2: Confirm both functions are ready**

Run:

```bash
nuctl get function --platform local
```

Expected output includes:

```text
pth-rfdetr-eagle-shape-v5   cvat   ready
pth-rfdetr-eagle-stain-v5   cvat   ready
```

- [ ] **Step 3: Trigger the stain interactor once from CVAT**

Use the CVAT UI to:

1. open a job where the stain interactor is available
2. select **RF-DETR Eagle Stain v5**
3. draw a bounding box on a patch that should clearly contain one of the stain classes
4. click **Interact**

Expected: the function receives one new request.

- [ ] **Step 4: Read the new stain logs**

Run:

```bash
docker logs --since 5m nuclio-nuclio-pth-rfdetr-eagle-stain-v5 2>&1 | tail -n 200
```

Expected: new lines similar to:

```text
RF-DETR stain request summary: image_size=(...), bbox=[[...]], mapping_keys=..., mapping_labels=[...]
RF-DETR stain pipeline summary: raw_predictions=..., clipped_predictions=..., kept_predictions=..., unmapped_predictions=..., empty_projected_masks=..., returned_shapes=...
RF-DETR stain response summary: returned_shapes=...
```

- [ ] **Step 5: If needed, repeat once for shape**

Run another interaction with **RF-DETR Eagle Shape v5**, then inspect:

```bash
docker logs --since 5m nuclio-nuclio-pth-rfdetr-eagle-shape-v5 2>&1 | tail -n 200
```

Expected: analogous shape request/pipeline/response summary logs.

## Self-Review

- **Spec coverage:** The plan covers the approved scope exactly: request-boundary logging in `main.py`, pipeline-stage summary logging in `model_handler.py`, additive-only behavior, and runtime verification through actual Nuclio logs.
- **Placeholder scan:** No `TBD`, `TODO`, or vague “add logging” instructions remain. Every task includes exact files, code snippets, commands, and expected outcomes.
- **Type consistency:** The plan uses existing `DummyContext`, `DummyBackend`, `ModelHandler`, and `Nuclio context.logger` patterns already present in the RF-DETR folders. The logging payload names are consistent across shape and stain.

