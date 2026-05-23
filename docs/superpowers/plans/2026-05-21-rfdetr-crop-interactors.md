# RF-DETR Crop Interactors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two self-contained RF-DETR crop-instance-segmentation Nuclio interactors (`eagle-shape-v5` and `eagle-stain-v5`) that show up separately in CVAT and load the approved best checkpoints from the bridge defect detection workspace.

**Architecture:** Mirror the existing Ultralytics crop interactor structure in each RF-DETR folder, but swap in an RF-DETR backend that mounts `/data/projects/bridge_defect_detection`, imports `training_toolkit` / `rfdetr`, selects the highest `val/map` Lightning checkpoint, and normalizes predictions into the existing crop-interactor postprocessing flow. Keep `main.py` and `postprocess.py` aligned with the current crop interactor so only manifest metadata, RF-DETR model loading, and label specs vary between the two folders.

**Tech Stack:** Nuclio YAML, Python 3.10, pytest, PIL, NumPy, PyTorch, `training_toolkit`, `rfdetr`

---

## File structure

- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml` — shape-family Nuclio manifest with RF-DETR metadata, mounts, labels, and env vars.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/main.py` — CVAT request/response entrypoint.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py` — crop orchestration layer.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/postprocess.py` — crop preprocessing, clipping, reprojection, and RLE helpers copied from the current crop interactor.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/rfdetr_backend.py` — RF-DETR checkpoint discovery, model loading, and prediction normalization.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py` — manifest assertions.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py` — handler/init tests.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py` — crop-handler tests.
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_rfdetr_backend.py` — checkpoint selection and RF-DETR backend tests.

- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml` — stain-family Nuclio manifest with stain labels and approved checkpoint root.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/main.py` — same entrypoint contract as shape.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/model_handler.py` — same crop orchestration contract as shape.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/postprocess.py` — same crop postprocessing helpers as shape.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/rfdetr_backend.py` — same RF-DETR backend contract as shape.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py` — manifest assertions for stain metadata.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py` — handler/init tests.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py` — crop-handler tests for stain mappings.
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/test_rfdetr_backend.py` — checkpoint-selection and normalization tests.

- Check: `serverless/pytorch/local/crop_instance_segmentation/nuclio/*` — source reference for `main.py`, `model_handler.py`, `postprocess.py`, and test style.
- Check: `/data/projects/bridge_defect_detection/training-toolkit/src/training_toolkit/models/rfdetr.py` — source reference for Lightning checkpoint loading and RF-DETR prediction postprocessing.
- Check: `/data/projects/bridge_defect_detection/runs/echo-combined-v5/shape_round1/checkpoints/epoch=068-map=0.1328.ckpt` — approved shape checkpoint.
- Check: `/data/projects/bridge_defect_detection/runs/echo-combined-v5/stain_round1/checkpoints/epoch=037-map=0.3146.ckpt` — approved stain checkpoint.

### Task 1: Implement the shape RF-DETR backend with test-first checkpoint loading

**Files:**
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/rfdetr_backend.py`
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_rfdetr_backend.py`
- Check: `/data/projects/bridge_defect_detection/training-toolkit/src/training_toolkit/models/rfdetr.py`

- [ ] **Step 1: Write the failing backend tests**

```python
from pathlib import Path

import numpy as np
import pytest

from rfdetr_backend import (
    PredictedInstance,
    find_best_checkpoint,
    load_checkpoint_state_dict,
    parse_map_score,
)


def test_parse_map_score_reads_epoch_style_checkpoint_names():
    assert parse_map_score("epoch=068-map=0.1328.ckpt") == pytest.approx(0.1328)
    assert parse_map_score("epoch=037-map=0.3146.ckpt") == pytest.approx(0.3146)


def test_find_best_checkpoint_picks_highest_map(tmp_path):
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=068-map=0.1328.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=073-map=0.1325.ckpt").write_bytes(b"x")
    (checkpoints / "last.ckpt").write_bytes(b"x")

    selected = find_best_checkpoint(checkpoints)

    assert selected == checkpoints / "epoch=068-map=0.1328.ckpt"


def test_load_checkpoint_state_dict_strips_lightning_model_prefix(tmp_path):
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        assert Path(path) == checkpoint
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
                "model.head.bias": np.array([2.0]),
                "other.value": np.array([3.0]),
            }
        }

    import rfdetr_backend
    rfdetr_backend.torch.load = fake_torch_load

    state_dict = load_checkpoint_state_dict(checkpoint)

    assert sorted(state_dict) == ["backbone.weight", "head.bias"]


def test_find_best_checkpoint_requires_epoch_map_files(tmp_path):
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "last.ckpt").write_bytes(b"x")

    with pytest.raises(RuntimeError, match="No epoch=.*-map=.*ckpt files"):
        find_best_checkpoint(checkpoints)
```

- [ ] **Step 2: Run the backend tests to verify they fail**

Run:

```bash
pytest serverless/pytorch/rfdetr/eagle-shape-v5/test_rfdetr_backend.py -v
```

Expected: FAIL because `rfdetr_backend.py` and its helper functions do not exist yet.

- [ ] **Step 3: Write the minimal RF-DETR backend implementation**

```python
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch
from PIL import Image


@dataclass(frozen=True)
class PredictedInstance:
    class_name: str
    score: float
    mask: np.ndarray


_MAP_RE = re.compile(r"epoch=\d+-map=(\d+\.\d+)\.ckpt$")


def parse_map_score(filename: str) -> float:
    match = _MAP_RE.match(filename)
    if match is None:
        raise ValueError(f"Unsupported checkpoint filename: {filename}")
    return float(match.group(1))


def find_best_checkpoint(checkpoints_dir: Path) -> Path:
    candidates = [path for path in checkpoints_dir.glob("epoch=*-map=*.ckpt") if path.is_file()]
    if not candidates:
        raise RuntimeError(f"No epoch=.*-map=.*ckpt files found in {checkpoints_dir}")
    return max(candidates, key=lambda path: parse_map_score(path.name))


def load_checkpoint_state_dict(checkpoint_path: Path) -> dict:
    checkpoint = torch.load(str(checkpoint_path), map_location="cpu", weights_only=False)
    if "state_dict" not in checkpoint:
        raise RuntimeError(f"Checkpoint {checkpoint_path} does not contain a Lightning state_dict")
    prefix = "model."
    return {
        key[len(prefix):]: value
        for key, value in checkpoint["state_dict"].items()
        if key.startswith(prefix)
    }


class RFDETRSegmentationBackend:
    def __init__(self, *, project_root: str, checkpoints_dir: str, config_path: str, conf_threshold: float):
        project_root_path = Path(project_root)
        if not project_root_path.exists():
            raise RuntimeError(f"Bridge defect detection project mount does not exist: {project_root}")
        if str(project_root_path / "training-toolkit" / "src") not in sys.path:
            sys.path.insert(0, str(project_root_path / "training-toolkit" / "src"))
        if str(project_root_path / "rf-detr" / "src") not in sys.path:
            sys.path.insert(0, str(project_root_path / "rf-detr" / "src"))
        self.checkpoint_path = find_best_checkpoint(Path(checkpoints_dir))
        self.state_dict = load_checkpoint_state_dict(self.checkpoint_path)
        self.config_path = Path(config_path)
        self.conf_threshold = conf_threshold

    def predict(self, image: np.ndarray) -> list[PredictedInstance]:
        raise NotImplementedError("Implement after the checkpoint-selection tests are green")
```

- [ ] **Step 4: Run the backend tests again to verify they pass**

Run:

```bash
pytest serverless/pytorch/rfdetr/eagle-shape-v5/test_rfdetr_backend.py -v
```

Expected: PASS for the helper-level checkpoint discovery and Lightning-prefix stripping tests.

- [ ] **Step 5: Commit the backend helper milestone**

```bash
git add \
  serverless/pytorch/rfdetr/eagle-shape-v5/rfdetr_backend.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_rfdetr_backend.py
git commit -m "feat: add RF-DETR shape backend helpers"
```

### Task 2: Build the shape Nuclio folder around the RF-DETR backend

**Files:**
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml`
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/main.py`
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/model_handler.py`
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/postprocess.py`
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py`
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py`
- Create: `serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py`
- Reference: `serverless/pytorch/local/crop_instance_segmentation/nuclio/*.py`

- [ ] **Step 1: Write the failing shape-folder tests**

```python
from pathlib import Path


def test_function_gpu_declares_box_only_rfdetr_interactor():
    manifest = Path(__file__).with_name("function-gpu.yaml").read_text(encoding="utf-8")

    assert "type: interactor" in manifest
    assert "startswith_box: true" in manifest
    assert "RF-DETR" in manifest
    assert "shape_round1/checkpoints" in manifest
```

```python
import base64
import io
import json
from types import SimpleNamespace

from PIL import Image

import main


class DummyContext:
    def __init__(self):
        self.user_data = SimpleNamespace()
        self.logger = SimpleNamespace(info=lambda *args, **kwargs: None)

    class Response:
        def __init__(self, *, body, headers, content_type, status_code):
            self.body = body
            self.headers = headers
            self.content_type = content_type
            self.status_code = status_code


class DummyModel:
    def handle(self, *, image, obj_bbox, mapping):
        assert image.size == (4, 4)
        assert obj_bbox == [[1, 1], [3, 3]]
        return [{"label": "(C7) ammaloram_cls", "type": "mask", "points": [0, 4, 4, 4, 0, 0, 3, 3], "attributes": []}]


def encode_image():
    buf = io.BytesIO()
    Image.new("RGB", (4, 4), "white").save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def test_handler_decodes_image_and_returns_shapes_json():
    context = DummyContext()
    context.user_data.model = DummyModel()
    event = SimpleNamespace(body={"image": encode_image(), "obj_bbox": [[1, 1], [3, 3]], "mapping": {}})

    response = main.handler(context, event)

    assert response.status_code == 200
    assert json.loads(response.body)["shapes"][0]["label"] == "(C7) ammaloram_cls"
```

```python
import numpy as np
import pytest
from PIL import Image

from model_handler import ModelHandler


class DummyBackend:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def predict(self, image):
        return []


def test_model_handler_requires_a_bounding_box(monkeypatch):
    monkeypatch.setattr("model_handler.RFDETRSegmentationBackend", DummyBackend)
    monkeypatch.setenv("BDD_PROJECT_ROOT", "/data/projects/bridge_defect_detection")
    monkeypatch.setenv("MODEL_CHECKPOINTS_DIR", "/tmp/checkpoints")
    monkeypatch.setenv("MODEL_CONFIG_PATH", "/tmp/config.yaml")

    handler = ModelHandler()

    with pytest.raises(ValueError, match="bounding box"):
        handler.handle(image=Image.fromarray(np.zeros((10, 10, 3), dtype=np.uint8)), obj_bbox=None, mapping={})
```

- [ ] **Step 2: Run the shape-folder tests to verify they fail**

Run:

```bash
pytest \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py -v
```

Expected: FAIL because the shape Nuclio files do not exist yet.

- [ ] **Step 3: Copy the stable crop entrypoint and postprocess helpers from the existing interactor**

```bash
cp serverless/pytorch/local/crop_instance_segmentation/nuclio/main.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/main.py
cp serverless/pytorch/local/crop_instance_segmentation/nuclio/postprocess.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/postprocess.py
```

- [ ] **Step 4: Implement the shape model handler and manifest**

```python
import os

from postprocess import (
    PredictedInstance,
    apply_class_aware_ios_nms,
    clip_mask_to_valid_region,
    mask_to_rle,
    prepare_crop,
    project_mask_to_image,
)
from rfdetr_backend import RFDETRSegmentationBackend


class ModelHandler:
    def __init__(self):
        self.input_size = int(os.environ.get("MODEL_INPUT_SIZE", "504"))
        self.backend = RFDETRSegmentationBackend(
            project_root=os.environ["BDD_PROJECT_ROOT"],
            checkpoints_dir=os.environ["MODEL_CHECKPOINTS_DIR"],
            config_path=os.environ["MODEL_CONFIG_PATH"],
            conf_threshold=float(os.environ.get("MODEL_CONF_THRESHOLD", "0.2")),
        )

    def handle(self, *, image, obj_bbox, mapping):
        if not obj_bbox:
            raise ValueError("Crop interactor requires a bounding box")

        prepared = prepare_crop(image=image, obj_bbox=obj_bbox, target_size=self.input_size)
        predicted = self.backend.predict(prepared.image)

        clipped: list[PredictedInstance] = []
        for instance in predicted:
            clipped_mask = clip_mask_to_valid_region(instance.mask, prepared.valid_region)
            if clipped_mask.any():
                clipped.append(PredictedInstance(instance.class_name, instance.score, clipped_mask))

        shapes = []
        for instance in apply_class_aware_ios_nms(clipped, threshold=0.8):
            if instance.class_name not in mapping:
                continue
            full_mask = project_mask_to_image(instance.mask, prepared)
            if not full_mask.any():
                continue
            shapes.append({
                "label": mapping[instance.class_name]["name"],
                "type": "mask",
                "points": mask_to_rle(full_mask),
                "attributes": [{"spec_id": 0, "value": f"{instance.score:.6f}"}],
            })
        return shapes
```

```yaml
metadata:
  name: pth-rfdetr-eagle-shape-v5
  namespace: cvat
  annotations:
    name: Eagle Shape RF-DETR v5
    version: 2
    type: interactor
    framework: pytorch
    spec: |
      [
        {"id": 0, "name": "(A13) danno_urto", "type": "mask"},
        {"id": 1, "name": "(C1) difetti_esecuzione", "type": "mask"},
        {"id": 2, "name": "(C7) ammaloram_cls", "type": "mask"},
        {"id": 3, "name": "(C8) venatura_ruggine_armature", "type": "mask"},
        {"id": 4, "name": "(C9) fessure_distacchi_corr_staffe", "type": "mask"},
        {"id": 5, "name": "(C10) fessure_distacchi_corr_arm_long", "type": "mask"},
        {"id": 6, "name": "(C13) esposiz_arm_precompress", "type": "mask"},
        {"id": 7, "name": "(C14) danno_urto", "type": "mask"},
        {"id": 8, "name": "(C16) fessure_verticali", "type": "mask"},
        {"id": 9, "name": "(C18) fessure_longitudinali", "type": "mask"},
        {"id": 10, "name": "(C19) fessure_trasversali", "type": "mask"}
      ]
    min_pos_points: 0
    min_neg_points: 0
    startswith_box: true
    help_message: Draw a crop box, run RF-DETR segmentation on that ROI, and create mapped masks in the full image.
spec:
  description: Box-only crop-driven RF-DETR instance segmentation for eagle-shape-v5
  runtime: "python:3.10"
  handler: main:handler
  eventTimeout: 60s
  env:
    - name: PYTHONPATH
      value: /opt/nuclio/rfdetr_shape:/opt/bdd/training-toolkit/src:/opt/bdd/rf-detr/src
    - name: BDD_PROJECT_ROOT
      value: /opt/bdd
    - name: MODEL_CHECKPOINTS_DIR
      value: /opt/bdd/runs/echo-combined-v5/shape_round1/checkpoints
    - name: MODEL_CONFIG_PATH
      value: /opt/bdd/runs/echo-combined-v5/shape_round1/config.yaml
    - name: MODEL_INPUT_SIZE
      value: "504"
    - name: MODEL_CONF_THRESHOLD
      value: "0.2"
```

- [ ] **Step 5: Run the shape-folder tests to verify they pass**

Run:

```bash
pytest \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_rfdetr_backend.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_main.py \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_model_handler.py -v
```

Expected: PASS for the shape backend, handler, and manifest tests.

- [ ] **Step 6: Commit the complete shape interactor**

```bash
git add serverless/pytorch/rfdetr/eagle-shape-v5
git commit -m "feat: add eagle shape RF-DETR crop interactor"
```

### Task 3: Clone the shape implementation into the stain folder and retune metadata

**Files:**
- Create: `serverless/pytorch/rfdetr/eagle-stain-v5/*`
- Reference: `serverless/pytorch/rfdetr/eagle-shape-v5/*`

- [ ] **Step 1: Write the failing stain-folder tests**

```python
from pathlib import Path


def test_function_gpu_declares_stain_checkpoint_root_and_labels():
    manifest = Path(__file__).with_name("function-gpu.yaml").read_text(encoding="utf-8")

    assert "Eagle Stain RF-DETR v5" in manifest
    assert "stain_round1/checkpoints" in manifest
    assert "(C2) effloresc_essudaz_pop-out" in manifest
    assert "(C6) superf_bagn_dilav_percolaz" in manifest
```

```python
import numpy as np
from PIL import Image

from model_handler import ModelHandler


class DummyBackend:
    def __init__(self, **kwargs):
        self.kwargs = kwargs

    def predict(self, image):
        from rfdetr_backend import PredictedInstance
        mask = np.ones((504, 504), dtype=np.uint8)
        return [PredictedInstance("(C5) infiltraz_cls", 0.81, mask)]


def test_handle_returns_mapped_stain_shape(monkeypatch):
    monkeypatch.setattr("model_handler.RFDETRSegmentationBackend", DummyBackend)
    monkeypatch.setenv("BDD_PROJECT_ROOT", "/data/projects/bridge_defect_detection")
    monkeypatch.setenv("MODEL_CHECKPOINTS_DIR", "/tmp/checkpoints")
    monkeypatch.setenv("MODEL_CONFIG_PATH", "/tmp/config.yaml")

    handler = ModelHandler()
    image = Image.fromarray(np.full((40, 40, 3), 255, dtype=np.uint8))
    shapes = handler.handle(
        image=image,
        obj_bbox=[[0, 0], [39, 39]],
        mapping={"(C5) infiltraz_cls": {"name": "(C5) infiltraz_cls", "attributes": {}}},
    )

    assert len(shapes) == 1
    assert shapes[0]["label"] == "(C5) infiltraz_cls"
```

- [ ] **Step 2: Run the stain-folder tests to verify they fail**

Run:

```bash
pytest \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py -v
```

Expected: FAIL because the stain files do not exist yet.

- [ ] **Step 3: Copy the shape folder and change only the stain-specific values**

```bash
cp -r serverless/pytorch/rfdetr/eagle-shape-v5/. \
  serverless/pytorch/rfdetr/eagle-stain-v5/
```

Edit the copied files so they use:

```text
pth-rfdetr-eagle-stain-v5
Eagle Stain RF-DETR v5
/opt/bdd/runs/echo-combined-v5/stain_round1/checkpoints
/opt/bdd/runs/echo-combined-v5/stain_round1/config.yaml
```

and the three stain labels:

```json
[
  {"id": 0, "name": "(C2) effloresc_essudaz_pop-out", "type": "mask"},
  {"id": 1, "name": "(C5) infiltraz_cls", "type": "mask"},
  {"id": 2, "name": "(C6) superf_bagn_dilav_percolaz", "type": "mask"}
]
```

- [ ] **Step 4: Run the stain-folder tests to verify they pass**

Run:

```bash
pytest \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_rfdetr_backend.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_main.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_model_handler.py -v
```

Expected: PASS for the stain backend, handler, and manifest tests.

- [ ] **Step 5: Commit the stain interactor**

```bash
git add serverless/pytorch/rfdetr/eagle-stain-v5
git commit -m "feat: add eagle stain RF-DETR crop interactor"
```

### Task 4: Final RF-DETR smoke validation

**Files:**
- Check: `serverless/pytorch/rfdetr/eagle-shape-v5/*`
- Check: `serverless/pytorch/rfdetr/eagle-stain-v5/*`

- [ ] **Step 1: Run the full RF-DETR folder test suite**

```bash
pytest \
  serverless/pytorch/rfdetr/eagle-shape-v5 \
  serverless/pytorch/rfdetr/eagle-stain-v5 -v
```

Expected: PASS for both folders.

- [ ] **Step 2: Smoke-test module initialization against the real mounted project paths**

Run:

```bash
BDD_PROJECT_ROOT=/data/projects/bridge_defect_detection \
MODEL_CHECKPOINTS_DIR=/data/projects/bridge_defect_detection/runs/echo-combined-v5/shape_round1/checkpoints \
MODEL_CONFIG_PATH=/data/projects/bridge_defect_detection/runs/echo-combined-v5/shape_round1/config.yaml \
PYTHONPATH=serverless/pytorch/rfdetr/eagle-shape-v5 \
python - <<'PY'
from model_handler import ModelHandler
handler = ModelHandler()
print(type(handler.backend).__name__)
print(handler.backend.checkpoint_path)
PY
```

Expected: prints `RFDETRSegmentationBackend` and the approved shape checkpoint path ending with `epoch=068-map=0.1328.ckpt`.

- [ ] **Step 3: Repeat the initialization smoke test for the stain folder**

```bash
BDD_PROJECT_ROOT=/data/projects/bridge_defect_detection \
MODEL_CHECKPOINTS_DIR=/data/projects/bridge_defect_detection/runs/echo-combined-v5/stain_round1/checkpoints \
MODEL_CONFIG_PATH=/data/projects/bridge_defect_detection/runs/echo-combined-v5/stain_round1/config.yaml \
PYTHONPATH=serverless/pytorch/rfdetr/eagle-stain-v5 \
python - <<'PY'
from model_handler import ModelHandler
handler = ModelHandler()
print(type(handler.backend).__name__)
print(handler.backend.checkpoint_path)
PY
```

Expected: prints `RFDETRSegmentationBackend` and the approved stain checkpoint path ending with `epoch=037-map=0.3146.ckpt`.

- [ ] **Step 4: Review the final diff**

```bash
git --no-pager diff -- \
  serverless/pytorch/rfdetr/eagle-shape-v5 \
  serverless/pytorch/rfdetr/eagle-stain-v5
```

Expected: only the two RF-DETR Nuclio folders are added.

- [ ] **Step 5: Create the final milestone commit**

```bash
git add serverless/pytorch/rfdetr/eagle-shape-v5 serverless/pytorch/rfdetr/eagle-stain-v5
git commit -m "feat: add RF-DETR crop interactors"
```
