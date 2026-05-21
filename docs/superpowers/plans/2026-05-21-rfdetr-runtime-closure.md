# RF-DETR Runtime Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `eagle-shape-v5` and `eagle-stain-v5` Nuclio manifests install a self-contained dependency closure that can import the mounted RF-DETR sources and initialize real checkpoints.

**Architecture:** Keep the `/opt/bdd` source mount, existing backend Python files, and current CVAT interactor flow unchanged. Only extend the two `function-gpu.yaml` build directives and the manifest tests, then verify the result with the existing pytest suites plus a real-checkpoint container smoke run that mirrors the manifest dependency set.

**Tech Stack:** Nuclio YAML manifests, pytest, Docker, PyTorch base image `pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime`, mounted bridge-defect-detection RF-DETR sources.

---

## File Structure

### Files to modify

- `serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml`
  - Expand the build directives so the shape function image installs the Linux libraries and pinned Python packages required to import mounted RF-DETR code.
- `serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py`
  - Add assertions that guard the runtime-closure package list and system-library provisioning for the shape manifest.
- `serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml`
  - Mirror the same runtime-closure changes for the stain function image.
- `serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py`
  - Add the same manifest assertions for the stain manifest.

### Files to verify without code changes

- `serverless/pytorch/rfdetr/eagle-shape-v5/rfdetr_backend.py`
  - Must continue to initialize against `/opt/bdd/runs/echo-combined-v5/shape_round1`.
- `serverless/pytorch/rfdetr/eagle-stain-v5/rfdetr_backend.py`
  - Must continue to initialize against `/opt/bdd/runs/echo-combined-v5/stain_round1`.

## Task 1: Add manifest guards and provision the runtime closure

**Files:**
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py`
- Modify: `serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml`
- Modify: `serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml`

- [ ] **Step 1: Write the failing manifest test for the shape function**

Add this test to `serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py`:

```python
def test_function_gpu_declares_runtime_closure_for_rfdetr_imports():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'libglib2.0-0' in manifest
    assert 'libgl1' in manifest
    assert 'libxcb1' in manifest
    assert 'numpy<2' in manifest
    assert 'torchvision==0.16.0' in manifest
    assert 'transformers==4.42.0' in manifest
    assert 'peft==0.10.0' in manifest
    assert 'opencv-python-headless==4.10.0.84' in manifest

    for package in [
        'requests',
        'pycocotools',
        'scipy',
        'tqdm',
        'rf100vl',
        'pydantic<3',
        'supervision',
        'matplotlib',
        'roboflow',
    ]:
        assert package in manifest
```

- [ ] **Step 2: Write the failing manifest test for the stain function**

Add the same test body to `serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py`:

```python
def test_function_gpu_declares_runtime_closure_for_rfdetr_imports():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'libglib2.0-0' in manifest
    assert 'libgl1' in manifest
    assert 'libxcb1' in manifest
    assert 'numpy<2' in manifest
    assert 'torchvision==0.16.0' in manifest
    assert 'transformers==4.42.0' in manifest
    assert 'peft==0.10.0' in manifest
    assert 'opencv-python-headless==4.10.0.84' in manifest

    for package in [
        'requests',
        'pycocotools',
        'scipy',
        'tqdm',
        'rf100vl',
        'pydantic<3',
        'supervision',
        'matplotlib',
        'roboflow',
    ]:
        assert package in manifest
```

- [ ] **Step 3: Run the two new tests and verify they fail**

Run:

```bash
cd /data/cvat && pytest \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py::test_function_gpu_declares_runtime_closure_for_rfdetr_imports \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py::test_function_gpu_declares_runtime_closure_for_rfdetr_imports \
  -q
```

Expected: both tests fail because the current manifests only install `pillow`, `pytorch-lightning`, and unpinned `torchvision`.

- [ ] **Step 4: Update the shape manifest build directives**

Replace the current `preCopy` install block in `serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml` with:

```yaml
    directives:
      preCopy:
        - kind: WORKDIR
          value: /opt/nuclio/rfdetr_interactor
        - kind: RUN
          value: >-
            apt-get update &&
            apt-get -y install --no-install-recommends
            python3
            python3-pip
            libglib2.0-0
            libgl1
            libxcb1 &&
            rm -rf /var/lib/apt/lists/*
        - kind: RUN
          value: >-
            python -m pip install --upgrade pip setuptools wheel &&
            python -m pip install
            pillow
            pytorch-lightning
            "numpy<2"
            "torchvision==0.16.0"
            requests
            pycocotools
            scipy
            tqdm
            "transformers==4.42.0"
            "peft==0.10.0"
            rf100vl
            "pydantic<3"
            supervision
            matplotlib
            roboflow
            "opencv-python-headless==4.10.0.84"
```

- [ ] **Step 5: Update the stain manifest build directives**

Apply the same build-directive block to `serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml`:

```yaml
    directives:
      preCopy:
        - kind: WORKDIR
          value: /opt/nuclio/rfdetr_interactor
        - kind: RUN
          value: >-
            apt-get update &&
            apt-get -y install --no-install-recommends
            python3
            python3-pip
            libglib2.0-0
            libgl1
            libxcb1 &&
            rm -rf /var/lib/apt/lists/*
        - kind: RUN
          value: >-
            python -m pip install --upgrade pip setuptools wheel &&
            python -m pip install
            pillow
            pytorch-lightning
            "numpy<2"
            "torchvision==0.16.0"
            requests
            pycocotools
            scipy
            tqdm
            "transformers==4.42.0"
            "peft==0.10.0"
            rf100vl
            "pydantic<3"
            supervision
            matplotlib
            roboflow
            "opencv-python-headless==4.10.0.84"
```

- [ ] **Step 6: Run the manifest test files and verify they pass**

Run:

```bash
cd /data/cvat && pytest \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py \
  -q
```

Expected: `12 passed`.

- [ ] **Step 7: Commit the manifest/runtime-closure changes**

```bash
cd /data/cvat && git add \
  serverless/pytorch/rfdetr/eagle-shape-v5/function-gpu.yaml \
  serverless/pytorch/rfdetr/eagle-shape-v5/test_function_gpu.py \
  serverless/pytorch/rfdetr/eagle-stain-v5/function-gpu.yaml \
  serverless/pytorch/rfdetr/eagle-stain-v5/test_function_gpu.py && \
  git commit -m "build: add RF-DETR runtime closure to Nuclio manifests"
```

## Task 2: Verify the full RF-DETR runtime path with real checkpoints

**Files:**
- Verify: `serverless/pytorch/rfdetr/eagle-shape-v5`
- Verify: `serverless/pytorch/rfdetr/eagle-stain-v5`

- [ ] **Step 1: Re-run the full shape and stain test suites**

Run:

```bash
cd /data/cvat && pytest serverless/pytorch/rfdetr/eagle-shape-v5 -q && \
pytest serverless/pytorch/rfdetr/eagle-stain-v5 -q
```

Expected: `33 passed` for shape and `33 passed` for stain.

- [ ] **Step 2: Run the real-checkpoint container smoke command**

Run:

```bash
cd /data/cvat && docker run --rm \
  -v /data/cvat:/data/cvat \
  -v /data/projects/bridge_defect_detection:/opt/bdd:ro \
  -w /data/cvat \
  pytorch/pytorch:2.1.0-cuda11.8-cudnn8-runtime \
  bash -lc '
    apt-get update >/dev/null &&
    apt-get install -y --no-install-recommends python3 python3-pip libglib2.0-0 libgl1 libxcb1 >/dev/null &&
    python -m pip install --quiet --upgrade pip setuptools wheel &&
    python -m pip install --quiet \
      pillow \
      pytorch-lightning \
      "numpy<2" \
      "torchvision==0.16.0" \
      requests \
      pycocotools \
      scipy \
      tqdm \
      "transformers==4.42.0" \
      "peft==0.10.0" \
      rf100vl \
      "pydantic<3" \
      supervision \
      matplotlib \
      roboflow \
      "opencv-python-headless==4.10.0.84" &&
    python - <<'"'"'PY'"'"'
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

RFDETR_ROOT = Path("/data/cvat/serverless/pytorch/rfdetr")


def load_module(name: str, file_path: Path):
    module_dir = str(file_path.parent)
    sys.path.insert(0, module_dir)
    try:
        spec = importlib.util.spec_from_file_location(name, file_path)
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.remove(module_dir)


def smoke(folder: str, class_name: str) -> None:
    for stale in ["postprocess", "rfdetr_backend", "main", "model_handler"]:
        sys.modules.pop(stale, None)

    module = load_module(f"{folder}_backend", RFDETR_ROOT / folder / "rfdetr_backend.py")
    backend_cls = getattr(module, class_name)
    backend = backend_cls()

    import rfdetr.main as rfdetr_main

    original_populate_args = rfdetr_main.populate_args

    def cpu_populate_args(**kwargs):
        kwargs["device"] = "cpu"
        return original_populate_args(**kwargs)

    rfdetr_main.populate_args = cpu_populate_args
    try:
        backend._load_model()
    finally:
        rfdetr_main.populate_args = original_populate_args

    print(f"{folder}: selected checkpoint {backend.checkpoint_path.name}; classes={len(backend._class_names)}; device={backend._device}")


smoke("eagle-shape-v5", "RFDETRShapeBackend")
smoke("eagle-stain-v5", "RFDETRStainBackend")
PY
  '
```

Expected output contains two success lines, one per folder, for example:

```text
eagle-shape-v5: selected checkpoint epoch=...ckpt; classes=11; device=cpu
eagle-stain-v5: selected checkpoint epoch=...ckpt; classes=3; device=cpu
```

- [ ] **Step 3: If Step 2 passes, stop changing code and record the exact verified dependency set**

Record in the task notes or session handoff that the following manifest pins were proven sufficient with the current base image:

```text
numpy<2
torchvision==0.16.0
transformers==4.42.0
peft==0.10.0
opencv-python-headless==4.10.0.84
libglib2.0-0
libgl1
libxcb1
```

- [ ] **Step 4: Do not broaden scope if verification succeeds**

Do **not** upgrade the base image, rewrite the RF-DETR backend, or vendor the bridge sources once the smoke command passes. The goal of this plan is the smallest working runtime closure.

## Self-Review

- **Spec coverage:** The plan covers the approved design’s three requirements: keep the `/opt/bdd` mount contract, fix only image provisioning, and verify real checkpoint initialization for both shape and stain.
- **Placeholder scan:** No `TBD`, `TODO`, or vague “handle appropriately” steps remain. All file paths, commands, package pins, and expected outputs are explicit.
- **Type consistency:** The plan references the existing `RFDETRShapeBackend` and `RFDETRStainBackend` class names, current manifest file paths, and the exact test files already present in the repository.
