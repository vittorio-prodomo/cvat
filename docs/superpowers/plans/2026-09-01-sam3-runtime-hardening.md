# SAM3 Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not dispatch subagents unless the user explicitly authorizes delegation.

**Goal:** Build and verify a reproducible CVAT SAM3 Nuclio candidate that uses a pinned Python/CUDA/PyTorch/SAM3 runtime and a checksum-verified local `sam3.pt`, without placing a Hugging Face token in the function image or runtime configuration.

**Architecture:** Keep the existing native CVAT point/box interactor and `SAM3InteractiveImagePredictor`. A host-only helper downloads the immutable `facebook/sam3` checkpoint revision, verifies its published size and SHA-256, and atomically installs it under CVAT's ignored runtime-data tree. Nuclio mounts that directory read-only and the model handler requires the mounted checkpoint; it never performs a network download.

**Tech Stack:** Python 3.12, pytest, PyYAML, Hugging Face Hub, Nuclio 1.16.3, Docker, NVIDIA Container Toolkit, CUDA 12.8, PyTorch 2.10.0, torchvision 0.25.0, native `facebookresearch/sam3` at an immutable Git revision.

**Design:** `docs/plans/2026-09-01-sam3-runtime-hardening-design.html`

**Execution boundaries:** Work only in `/data/cvat/.worktrees/sam3-runtime-hardening` on `fix/sam3-runtime-hardening`. Do not commit, push, merge, deploy a Nuclio function, alter the live CVAT Compose stack, or touch RF-DETR. Building a uniquely tagged candidate image and running isolated containers are allowed by this plan; live `nuctl deploy` is not.

---

## File map

- Create `serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py`: host-only authenticated download, integrity verification, and atomic installation.
- Create `serverless/pytorch/facebookresearch/sam3/test_prepare_checkpoint.py`: small-fixture tests for source pinning, integrity failures, atomic promotion, and existing-checkpoint reuse.
- Modify `serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py`: require a local checkpoint and remove runtime Hugging Face download/version selection.
- Modify `serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py`: specify the new local-checkpoint contract and preserve predictor behavior coverage.
- Modify `serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml`: Python 3.12/CUDA 12.8 runtime, exact package and SAM3 pins, and read-only model mount.
- Create `serverless/pytorch/facebookresearch/sam3/nuclio/sam3-runtime-constraints.txt`: complete reviewed Python distribution lock.
- Modify `serverless/pytorch/facebookresearch/sam3/nuclio/test_function_gpu.py`: parse and enforce manifest/runtime/mount pins and prohibit runtime token forwarding.
- Modify `serverless/deploy_gpu.sh`: stop forwarding the SAM3 Hugging Face/version/checkpoint variables into all GPU functions.
- Preserve `docs/plans/2026-09-01-sam3-runtime-hardening-design.html`: approved human-facing design.
- Create this file `docs/superpowers/plans/2026-09-01-sam3-runtime-hardening.md`: agent-executable checklist.

---

### Task 1: Add the host-only checkpoint preparation boundary

**Files:**
- Create: `serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py`
- Create: `serverless/pytorch/facebookresearch/sam3/test_prepare_checkpoint.py`

- [ ] **Step 1: Write the failing checkpoint-helper tests**

Create `serverless/pytorch/facebookresearch/sam3/test_prepare_checkpoint.py` with:

```python
import hashlib
import stat
from pathlib import Path

import pytest

import prepare_checkpoint


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def test_install_checkpoint_pins_source_and_atomically_promotes(tmp_path):
    payload = b'verified-sam3-checkpoint'
    destination = tmp_path / 'models' / 'sam3.pt'
    calls = []

    def downloader(**kwargs):
        calls.append(kwargs)
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    installed = prepare_checkpoint.install_checkpoint(
        destination,
        token='secret-not-for-output',
        downloader=downloader,
        expected_size=len(payload),
        expected_sha256=digest(payload),
    )

    assert installed == destination
    assert destination.read_bytes() == payload
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert len(calls) == 1
    assert calls[0]['repo_id'] == prepare_checkpoint.REPO_ID
    assert calls[0]['filename'] == prepare_checkpoint.FILENAME
    assert calls[0]['revision'] == prepare_checkpoint.REVISION
    assert calls[0]['token'] == 'secret-not-for-output'
    assert Path(calls[0]['local_dir']).parent == destination.parent
    assert not list(destination.parent.glob(f'.{destination.name}.*.staged'))


def test_install_checkpoint_rejects_bad_download_without_destination(tmp_path):
    payload = b'corrupt'
    destination = tmp_path / 'models' / 'sam3.pt'

    def downloader(**kwargs):
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    with pytest.raises(RuntimeError, match='SHA-256 mismatch'):
        prepare_checkpoint.install_checkpoint(
            destination,
            token='secret-not-for-output',
            downloader=downloader,
            expected_size=len(payload),
            expected_sha256=digest(b'expected'),
        )

    assert not destination.exists()
    assert not list(destination.parent.glob(f'.{destination.name}.*.staged'))


def test_install_checkpoint_reuses_verified_destination_without_downloading(tmp_path):
    payload = b'already-present'
    destination = tmp_path / 'sam3.pt'
    destination.write_bytes(payload)

    def downloader(**kwargs):
        raise AssertionError('downloader must not run for a verified destination')

    installed = prepare_checkpoint.install_checkpoint(
        destination,
        token='secret-not-for-output',
        downloader=downloader,
        expected_size=len(payload),
        expected_sha256=digest(payload),
    )

    assert installed == destination
    assert destination.read_bytes() == payload
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_install_checkpoint_does_not_log_token(tmp_path, capsys):
    payload = b'payload'
    destination = tmp_path / 'sam3.pt'

    def downloader(**kwargs):
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    prepare_checkpoint.install_checkpoint(
        destination,
        token='secret-not-for-output',
        downloader=downloader,
        expected_size=len(payload),
        expected_sha256=digest(payload),
    )

    captured = capsys.readouterr()
    assert 'secret-not-for-output' not in captured.out
    assert 'secret-not-for-output' not in captured.err
```

- [ ] **Step 2: Run the helper tests and verify RED**

Run:

```bash
python3 -m pytest serverless/pytorch/facebookresearch/sam3/test_prepare_checkpoint.py -q
```

Expected: collection fails with `ModuleNotFoundError: No module named 'prepare_checkpoint'`.

- [ ] **Step 3: Implement the checkpoint helper**

Create `serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py` with:

```python
#!/usr/bin/env python3
import argparse
import getpass
import hashlib
import os
import shutil
import tempfile
from pathlib import Path


REPO_ID = 'facebook/sam3'
REVISION = '3c879f39826c281e95690f02c7821c4de09afae7'
FILENAME = 'sam3.pt'
EXPECTED_SIZE = 3_450_062_241
EXPECTED_SHA256 = '9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e'
DEFAULT_DESTINATION = Path('/data/cvat/data/models/sam3/sam3.pt')


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def verify_checkpoint(
    path: Path,
    *,
    expected_size: int = EXPECTED_SIZE,
    expected_sha256: str = EXPECTED_SHA256,
) -> None:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f'SAM3 checkpoint is not a regular file: {path}')

    actual_size = path.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(
            f'SAM3 checkpoint size mismatch: expected {expected_size} bytes, '
            f'got {actual_size} bytes at {path}'
        )

    actual_sha256 = sha256_file(path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f'SAM3 checkpoint SHA-256 mismatch: expected {expected_sha256}, '
            f'got {actual_sha256} at {path}'
        )


def install_checkpoint(
    destination: Path,
    *,
    token: str,
    downloader=None,
    expected_size: int = EXPECTED_SIZE,
    expected_sha256: str = EXPECTED_SHA256,
) -> Path:
    destination = Path(destination)
    if destination.exists():
        verify_checkpoint(
            destination,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
        )
        os.chmod(destination.parent, 0o700)
        os.chmod(destination, 0o600)
        return destination

    if not token:
        raise RuntimeError('A Hugging Face token is required to download SAM3')

    if downloader is None:
        from huggingface_hub import hf_hub_download

        downloader = hf_hub_download

    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(destination.parent, 0o700)

    staged_path = None
    try:
        with tempfile.TemporaryDirectory(
            prefix='.sam3-download-',
            dir=destination.parent,
        ) as download_dir:
            downloaded = Path(downloader(
                repo_id=REPO_ID,
                filename=FILENAME,
                revision=REVISION,
                token=token,
                local_dir=download_dir,
            ))
            verify_checkpoint(
                downloaded,
                expected_size=expected_size,
                expected_sha256=expected_sha256,
            )

            with tempfile.NamedTemporaryFile(
                mode='wb',
                prefix=f'.{destination.name}.',
                suffix='.staged',
                dir=destination.parent,
                delete=False,
            ) as staged, downloaded.open('rb') as source:
                staged_path = Path(staged.name)
                shutil.copyfileobj(source, staged, length=8 * 1024 * 1024)

            os.chmod(staged_path, 0o600)
            verify_checkpoint(
                staged_path,
                expected_size=expected_size,
                expected_sha256=expected_sha256,
            )
            os.replace(staged_path, destination)
            staged_path = None
    finally:
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)

    return destination


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Download and verify the pinned native SAM3 checkpoint.',
    )
    parser.add_argument(
        '--destination',
        type=Path,
        default=DEFAULT_DESTINATION,
    )
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()

    if args.verify_only or args.destination.exists():
        verify_checkpoint(args.destination)
        print(f'SAM3 checkpoint verified: {args.destination}')
        return 0

    token = getpass.getpass('Hugging Face token: ')
    installed = install_checkpoint(args.destination, token=token)
    print(f'SAM3 checkpoint installed and verified: {installed}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
```

- [ ] **Step 4: Run the helper tests and verify GREEN**

Run:

```bash
python3 -m pytest serverless/pytorch/facebookresearch/sam3/test_prepare_checkpoint.py -q
```

Expected: `5 passed` and no token text in output. The fifth regression test, added during diff review, rejects whitespace-only credentials before invoking the downloader.

- [ ] **Step 5: Run static checks for the helper**

Run:

```bash
python3 -m py_compile serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py
rg -n "hf_[A-Za-z0-9]{20,}|secret-not-for-output" \
  serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py
```

Expected: compile succeeds and `rg` returns no matches.

---

### Task 2: Require the mounted checkpoint in the SAM3 model handler

**Files:**
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py`
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py`

- [ ] **Step 1: Replace download/version tests with failing local-checkpoint tests**

In `test_model_handler.py`, add an autouse checkpoint fixture immediately after `make_handler`:

```python
@pytest.fixture(autouse=True)
def local_checkpoint(monkeypatch, tmp_path):
    checkpoint = tmp_path / 'sam3.pt'
    checkpoint.write_bytes(b'checkpoint')
    monkeypatch.setenv('SAM3_CHECKPOINT_PATH', str(checkpoint))
    return checkpoint
```

Delete `test_init_rejects_sam3_1_for_interactive_masks` and `test_init_defaults_to_sam3_checkpoint_for_interactive_masks`. Add:

```python
def test_init_requires_local_checkpoint_path(monkeypatch):
    monkeypatch.delenv('SAM3_CHECKPOINT_PATH')

    with pytest.raises(RuntimeError, match='SAM3_CHECKPOINT_PATH is required'):
        ModelHandler()


def test_init_rejects_missing_local_checkpoint(monkeypatch, tmp_path):
    missing = tmp_path / 'missing.pt'
    monkeypatch.setenv('SAM3_CHECKPOINT_PATH', str(missing))

    with pytest.raises(RuntimeError, match='checkpoint file does not exist'):
        ModelHandler()


def test_init_passes_local_checkpoint_to_native_builder(monkeypatch, local_checkpoint):
    calls = []
    fake_predictor_model = SimpleNamespace(backbone='shared-backbone')
    fake_predictor = SimpleNamespace(model=fake_predictor_model)
    fake_model = SimpleNamespace(
        backbone='shared-backbone',
        inst_interactive_predictor=fake_predictor,
    )

    fake_builder_module = ModuleType('sam3.model_builder')
    fake_builder_module.build_sam3_image_model = (
        lambda **kwargs: calls.append(kwargs) or fake_model
    )
    fake_sam3_package = ModuleType('sam3')
    fake_sam3_package.model_builder = fake_builder_module
    fake_torch_module = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))

    monkeypatch.setitem(sys.modules, 'sam3', fake_sam3_package)
    monkeypatch.setitem(sys.modules, 'sam3.model_builder', fake_builder_module)
    monkeypatch.setitem(sys.modules, 'torch', fake_torch_module)

    ModelHandler()

    assert calls == [{
        'device': 'cuda',
        'checkpoint_path': str(local_checkpoint),
        'load_from_HF': False,
        'enable_inst_interactivity': True,
    }]
```

In `test_init_reuses_image_backbone_for_interactive_predictor_when_missing`, remove the unused `download_ckpt_from_hf` fake. The autouse fixture supplies the required path.

- [ ] **Step 2: Run the three new tests and verify RED**

Run:

```bash
python3 -m pytest \
  serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py::test_init_requires_local_checkpoint_path \
  serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py::test_init_rejects_missing_local_checkpoint \
  serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py::test_init_passes_local_checkpoint_to_native_builder \
  -q
```

Expected: failures because the current handler downloads from Hugging Face when the path is absent and does not validate a missing path.

- [ ] **Step 3: Implement the local-checkpoint model initialization**

Replace the imports and `ModelHandler.__init__` preamble in `model_handler.py` so the complete beginning of the file is:

```python
import os
from pathlib import Path

import numpy as np


def checkpoint_from_environment() -> str:
    configured = os.environ.get('SAM3_CHECKPOINT_PATH')
    if not configured:
        raise RuntimeError(
            'SAM3_CHECKPOINT_PATH is required; mount the verified sam3.pt read-only'
        )

    checkpoint = Path(configured)
    if not checkpoint.is_file():
        raise RuntimeError(f'SAM3 checkpoint file does not exist: {checkpoint}')

    return str(checkpoint)


class ModelHandler:
    def __init__(self):
        checkpoint_path = checkpoint_from_environment()

        import torch
        from sam3.model_builder import build_sam3_image_model

        if not torch.cuda.is_available():
            raise RuntimeError('SAM3 interactor requires an NVIDIA GPU with CUDA support')

        model = build_sam3_image_model(
            device='cuda',
            checkpoint_path=checkpoint_path,
            load_from_HF=False,
            enable_inst_interactivity=True,
        )
        predictor = model.inst_interactive_predictor
        if predictor is None:
            raise RuntimeError('SAM3 image model did not expose an interactive predictor')

        if getattr(predictor.model, 'backbone', None) is None:
            predictor.model.backbone = model.backbone

        self.predictor = predictor
```

Leave `ModelHandler.handle` unchanged.

- [ ] **Step 4: Run the model-handler tests and verify GREEN**

Run:

```bash
python3 -m pytest serverless/pytorch/facebookresearch/sam3/nuclio/test_model_handler.py -q
```

Expected: all model-handler tests pass.

---

### Task 3: Pin the Nuclio runtime and mount the checkpoint read-only

**Files:**
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml`
- Modify: `serverless/pytorch/facebookresearch/sam3/nuclio/test_function_gpu.py`

- [ ] **Step 1: Replace manifest string checks with failing structural checks**

Replace `test_function_gpu.py` with:

```python
from pathlib import Path

import yaml


MANIFEST_PATH = Path(__file__).with_name('function-gpu.yaml')
SAM3_REVISION = '660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7'
HOST_MODEL_DIR = '/data/cvat/data/models/sam3'
CONTAINER_MODEL_DIR = '/opt/nuclio/models/sam3'


def load_manifest():
    return yaml.safe_load(MANIFEST_PATH.read_text(encoding='utf-8'))


def run_directives(manifest):
    return [
        directive['value']
        for directive in manifest['spec']['build']['directives']['preCopy']
        if directive['kind'] == 'RUN'
    ]


def manifest_directive_values(manifest):
    return [
        directive['value']
        for directive in manifest['spec']['build']['directives']['preCopy']
    ]


def test_manifest_pins_supported_python_cuda_torch_and_sam3_revision():
    manifest = load_manifest()
    run_commands = run_directives(manifest)
    directives = '\n'.join(run_commands)
    packaging_command = next(
        command for command in run_commands if 'pip==26.2.1' in command
    )

    assert manifest['spec']['runtime'] == 'python:3.12'
    assert manifest['spec']['build']['baseImage'] == (
        'nvidia/cuda:12.8.0-cudnn-runtime-ubuntu24.04'
    )
    assert 'PIP_BREAK_SYSTEM_PACKAGES=1' in manifest_directive_values(manifest)
    assert '--ignore-installed' in packaging_command
    assert 'pip==26.2.1' in directives
    assert 'setuptools==80.10.2' in directives
    assert 'wheel==0.48.0' in directives
    assert 'torch==2.10.0' in directives
    assert 'torchvision==0.25.0' in directives
    assert f'git+https://github.com/facebookresearch/sam3.git@{SAM3_REVISION}' in directives
    assert 'numpy==1.26.4' in directives
    assert 'timm==1.0.29' in directives
    assert 'tqdm==4.70.0' in directives
    assert 'ftfy==6.1.1' in directives
    assert 'regex==2026.9.3' in directives
    assert 'iopath==0.1.10' in directives
    assert 'typing-extensions==4.16.0' in directives
    assert 'pillow==12.3.0' in directives
    assert 'einops==0.8.2' in directives
    assert 'pycocotools==2.0.11' in directives
    assert 'psutil==7.2.2' in directives
    assert 'huggingface-hub==1.29.0' in directives


def test_manifest_mounts_verified_checkpoint_directory_read_only():
    manifest = load_manifest()
    env = {item['name']: item['value'] for item in manifest['spec']['env']}
    volume = manifest['spec']['volumes'][0]

    assert env['SAM3_CHECKPOINT_PATH'] == f'{CONTAINER_MODEL_DIR}/sam3.pt'
    assert volume['volume']['name'] == 'sam3-checkpoint'
    assert volume['volume']['hostPath']['path'] == HOST_MODEL_DIR
    assert volume['volumeMount']['name'] == 'sam3-checkpoint'
    assert volume['volumeMount']['mountPath'] == CONTAINER_MODEL_DIR
    assert volume['volumeMount']['readOnly'] is True


def test_manifest_does_not_embed_or_require_a_hugging_face_token():
    content = MANIFEST_PATH.read_text(encoding='utf-8')

    assert 'HF_TOKEN' not in content
    assert 'download_ckpt_from_hf' not in content


def test_deploy_gpu_script_does_not_forward_sam3_secrets_or_overrides():
    deploy_script = Path(__file__).resolve().parents[4] / 'deploy_gpu.sh'
    content = deploy_script.read_text(encoding='utf-8')

    assert 'HF_TOKEN' not in content
    assert 'SAM3_MODEL_VERSION' not in content
    assert 'SAM3_CHECKPOINT_PATH' not in content
```

- [ ] **Step 2: Run the manifest tests and verify RED**

Run:

```bash
python3 -m pytest serverless/pytorch/facebookresearch/sam3/nuclio/test_function_gpu.py -q
```

Expected: failures report Python 3.10, Ubuntu 22.04, unpinned dependencies, missing volume/env configuration, and SAM3 variable forwarding.

- [ ] **Step 3: Implement the pinned manifest**

In `function-gpu.yaml`:

1. Change runtime and base image to:

```yaml
  runtime: 'python:3.12'
  # ...
    baseImage: nvidia/cuda:12.8.0-cudnn-runtime-ubuntu24.04
```

2. Add the checkpoint path to `spec.env`:

```yaml
    - name: SAM3_CHECKPOINT_PATH
      value: /opt/nuclio/models/sam3/sam3.pt
```

Add this build directive alongside the existing container environment directives so Ubuntu 24.04 permits the intentionally container-scoped system installation:

```yaml
        - kind: ENV
          value: PIP_BREAK_SYSTEM_PACKAGES=1
```

3. Replace the three package-install `RUN` directives with:

```yaml
        - kind: RUN
          value: >-
            python -m pip install --no-cache-dir --ignore-installed
            pip==26.2.1 setuptools==80.10.2 wheel==0.48.0
        - kind: RUN
          value: >-
            python -m pip install --no-cache-dir
            torch==2.10.0 torchvision==0.25.0
            --index-url https://download.pytorch.org/whl/cu128
        - kind: RUN
          value: >-
            python -m pip install --no-cache-dir
            numpy==1.26.4 timm==1.0.29 tqdm==4.70.0 ftfy==6.1.1
            regex==2026.9.3 iopath==0.1.10 typing-extensions==4.16.0
            pillow==12.3.0 einops==0.8.2 pycocotools==2.0.11
            psutil==7.2.2 huggingface-hub==1.29.0
            git+https://github.com/facebookresearch/sam3.git@660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7
```

Keep the apt directive, but add `--no-install-recommends` and rely on Ubuntu 24.04's `python3` (Python 3.12):

```yaml
        - kind: RUN
          value: >-
            apt-get update &&
            apt-get -y install --no-install-recommends
            git python3 python3-pip python-is-python3 ffmpeg libsm6 libxext6 &&
            rm -rf /var/lib/apt/lists/*
```

4. Add the volume before `triggers`:

```yaml
  volumes:
    - volume:
        name: sam3-checkpoint
        hostPath:
          path: "/data/cvat/data/models/sam3"
      volumeMount:
        name: sam3-checkpoint
        mountPath: "/opt/nuclio/models/sam3"
        readOnly: true
```

- [ ] **Step 4: Remove SAM3 credential/override forwarding from the deploy script**

In `serverless/deploy_gpu.sh`, reduce `env_args` construction to:

```bash
    env_args=(
        --env CVAT_FUNCTIONS_REDIS_HOST=cvat_redis_ondisk
        --env CVAT_FUNCTIONS_REDIS_PORT=6666
    )
```

Delete the three conditional blocks for `HF_TOKEN`, `SAM3_MODEL_VERSION`, and `SAM3_CHECKPOINT_PATH`. Do not alter the `nuctl deploy` command or Redis arguments.

- [ ] **Step 5: Run the manifest and deploy-script tests and verify GREEN**

Run:

```bash
python3 -m pytest serverless/pytorch/facebookresearch/sam3/nuclio/test_function_gpu.py -q
bash -n serverless/deploy_gpu.sh
python3 - <<'PY'
from pathlib import Path
import yaml

path = Path('serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml')
yaml.safe_load(path.read_text(encoding='utf-8'))
print('SAM3_YAML_OK')
PY
```

Expected: pytest passes, `bash -n` exits 0, and the parser prints `SAM3_YAML_OK`.

---

### Task 4: Run the complete local contract suite and review the patch

**Files:**
- All files from Tasks 1–3

- [ ] **Step 1: Run the SAM3 tests as an isolated suite**

Run:

```bash
python3 -m pytest serverless/pytorch/facebookresearch/sam3 -q
```

Expected: all helper and Nuclio tests pass. Do not combine this path with crop or RF-DETR test paths.

- [ ] **Step 2: Run Python, shell, YAML, and whitespace checks**

Run:

```bash
python3 -m py_compile \
  serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py \
  serverless/pytorch/facebookresearch/sam3/nuclio/main.py \
  serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py
bash -n serverless/deploy_gpu.sh
git diff --check
```

Expected: every command exits 0 with no diagnostics.

- [ ] **Step 3: Scan the patch for secret and drift regressions**

Run:

```bash
rg -n "HF_TOKEN|SAM3_MODEL_VERSION|download_ckpt_from_hf|facebookresearch/sam3.git([^@]|$)" \
  serverless/pytorch/facebookresearch/sam3 serverless/deploy_gpu.sh
```

Expected: no production-code matches. Test assertions that prohibit these strings are acceptable and must be reviewed manually.

- [ ] **Step 4: Review exact scope**

Run:

```bash
git status --short
git diff --stat
git diff -- \
  serverless/pytorch/facebookresearch/sam3 \
  serverless/deploy_gpu.sh \
  docs/plans/2026-09-01-sam3-runtime-hardening-design.html \
  docs/superpowers/plans/2026-09-01-sam3-runtime-hardening.md
```

Expected: only the approved SAM3 hardening files, design, plan, and the generic removal of SAM3-only forwarding from `deploy_gpu.sh` appear.

---

### Task 5: Operator checkpoint — download and verify the real model artifact

**Files outside Git:**
- Create: `/data/cvat/data/models/sam3/sam3.pt` (ignored runtime data, 3,450,062,241 bytes)

- [ ] **Step 1: Confirm capacity and absence/presence before writing**

Run:

```bash
df -h /data/cvat/data
if [ -e /data/cvat/data/models/sam3/sam3.pt ]; then
  ls -lh /data/cvat/data/models/sam3/sam3.pt
else
  echo SAM3_CHECKPOINT_ABSENT
fi
```

Expected: at least 8 GB free (download plus same-filesystem staging copy) and either a known existing file or `SAM3_CHECKPOINT_ABSENT`.

- [ ] **Step 2: Have the user run the interactive download locally**

The token must never be pasted into chat or supplied through a command argument. Ask the user to run this in a local terminal:

```bash
cd /data/cvat/.worktrees/sam3-runtime-hardening
uv run --no-project --with huggingface-hub==1.29.0 \
  python serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py
```

Expected: the terminal prompts privately for the token, then prints:

```text
SAM3 checkpoint installed and verified: /data/cvat/data/models/sam3/sam3.pt
```

If the file already exists and verifies, no token prompt occurs.

- [ ] **Step 3: Independently verify the installed artifact without credentials**

Run:

```bash
uv run --no-project --with huggingface-hub==1.29.0 \
  python serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py --verify-only
stat -c '%a %U:%G %s %n' /data/cvat/data/models/sam3/sam3.pt
sha256sum /data/cvat/data/models/sam3/sam3.pt
```

Expected:

```text
SAM3 checkpoint verified: /data/cvat/data/models/sam3/sam3.pt
600 <owner>:<group> 3450062241 /data/cvat/data/models/sam3/sam3.pt
9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e  /data/cvat/data/models/sam3/sam3.pt
```

Do not continue to a candidate build if any value differs.

---

### Task 6: Build the isolated Nuclio candidate without deploying it

**Runtime artifacts:**
- Create: `/tmp/nuctl-1.16.3` (temporary matching client)
- Create image tag: `cvat.pth.facebookresearch.sam3.interactor:hardening-20260901`

- [ ] **Step 1: Obtain a temporary matching Nuclio client**

Run with network approval:

```bash
curl -fL \
  https://github.com/nuclio/nuclio/releases/download/1.16.3/nuctl-1.16.3-linux-amd64 \
  -o /tmp/nuctl-1.16.3
chmod 0755 /tmp/nuctl-1.16.3
/tmp/nuctl-1.16.3 version
```

Expected: client label `1.16.3`. Do not replace `/home/vittorio/.local/bin/nuctl` in this slice.

- [ ] **Step 2: Record pre-build Docker and Nuclio state**

Run with Docker access:

```bash
docker image inspect cvat.pth.facebookresearch.sam3.interactor:hardening-20260901 \
  --format '{{.Id}}' 2>/dev/null || echo SAM3_CANDIDATE_TAG_ABSENT
/tmp/nuctl-1.16.3 get functions --platform local
```

Expected: the candidate tag is absent and the live function inventory remains empty. If the tag already exists, stop and inspect it rather than overwriting it.

- [ ] **Step 3: Build with `nuctl build`, not `nuctl deploy`**

Run with Docker and network access:

```bash
/tmp/nuctl-1.16.3 build pth-facebookresearch-sam3-interactor-hardening \
  --project-name cvat \
  --path serverless/pytorch/facebookresearch/sam3/nuclio \
  --file serverless/pytorch/facebookresearch/sam3/nuclio/function-gpu.yaml \
  --image cvat.pth.facebookresearch.sam3.interactor:hardening-20260901 \
  --platform local
```

Expected: build completes successfully and creates only the unique candidate image tag. It must not create a Nuclio function.

- [ ] **Step 4: Verify the image's pinned runtime and absence of credentials**

Run:

```bash
docker run --rm \
  --entrypoint python \
  cvat.pth.facebookresearch.sam3.interactor:hardening-20260901 \
  -c "import importlib.metadata as m, torch, torchvision; print(m.version('sam3')); print(torch.__version__); print(torchvision.__version__)"
docker inspect cvat.pth.facebookresearch.sam3.interactor:hardening-20260901 \
  --format '{{json .Config.Env}}'
docker history --no-trunc cvat.pth.facebookresearch.sam3.interactor:hardening-20260901
```

Expected: SAM3 imports, PyTorch reports `2.10.0+cu128`, torchvision reports `0.25.0+cu128`, and neither inspect nor history contains `HF_TOKEN`, an `hf_` token, or an unpinned SAM3 Git URL.

- [ ] **Step 5: Recheck that no function was deployed**

Run:

```bash
/tmp/nuctl-1.16.3 get functions --platform local
```

Expected: the inventory is unchanged and still empty.

---

### Task 7: Initialize the real interactive predictor on GPU in isolation

**Runtime only:**
- Use authoritative candidate image `cvat.pth.facebookresearch.sam3.interactor:hardening-20260901-r4`
- Mount `/data/cvat/data/models/sam3` read-only

- [ ] **Step 1: Confirm GPU visibility at the container boundary**

Run with Docker/GPU access:

```bash
docker run --rm --gpus device=0 \
  --entrypoint python \
  cvat.pth.facebookresearch.sam3.interactor:hardening-20260901-r4 \
  -c "import torch; print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
```

Expected: `True` and `NVIDIA RTX 6000 Ada Generation`.

- [ ] **Step 2: Initialize the real model with the read-only checkpoint**

Run:

```bash
docker run --rm --gpus device=0 \
  --mount type=bind,src=/data/cvat/data/models/sam3,dst=/opt/nuclio/models/sam3,readonly \
  --env SAM3_CHECKPOINT_PATH=/opt/nuclio/models/sam3/sam3.pt \
  --workdir /opt/nuclio \
  --entrypoint python \
  cvat.pth.facebookresearch.sam3.interactor:hardening-20260901-r4 \
  -c "from model_handler import ModelHandler; handler = ModelHandler(); print(type(handler.predictor).__name__); print('SAM3_GPU_INIT_OK')"
```

Expected: predictor type prints and final line is `SAM3_GPU_INIT_OK`. No Hugging Face network request or token is required.

- [ ] **Step 3: Verify the checkpoint mount was not modified**

Run:

```bash
uv run --no-project --with huggingface-hub==1.29.0 \
  python serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py --verify-only
```

Expected: `SAM3 checkpoint verified`.

---

### Review hardening addendum: authoritative final candidate

Independent whole-boundary review found no critical issues and required three important amendments before handoff:

- revalidate the checkpoint's approved size and SHA-256 inside `ModelHandler` before any model import;
- assert the approved source and artifact literals, reject bad size/symlinks, and fsync both the staged checkpoint and its containing directory;
- pin the CUDA base by digest, use Canonical's `20260901T000000Z` Ubuntu snapshot, and constrain the complete 58-package Python graph.

Real prompt smoke testing also exposed SAM3's optional post-processing fallback when no compiler was present. A disposable probe established the minimal working set as `gcc`, `libc6-dev`, and `python3-dev`; these packages are now included so Triton's connected-components post-processing remains active.

The authoritative candidate superseding the earlier build-only tags is:

```text
cvat.pth.facebookresearch.sam3.interactor:hardening-20260901-r4
sha256:2ff25e5cbeeb4f9317155910ee6211b1316cbe41cacbab49ac58b593f3739053
```

It completed exact runtime-lock and isolated-build-lock verification, `pip check`, source-commit and secret-history inspection, and real point-only plus box-only GPU inference. No Nuclio function was created.

---

### Task 8: Final verification and handoff at the deployment gate

**Files:**
- All changed files in the worktree

- [ ] **Step 1: Invoke verification-before-completion and rerun the complete evidence set**

Run:

```bash
python3 -m pytest serverless/pytorch/facebookresearch/sam3 -q
python3 -m py_compile \
  serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py \
  serverless/pytorch/facebookresearch/sam3/nuclio/main.py \
  serverless/pytorch/facebookresearch/sam3/nuclio/model_handler.py
bash -n serverless/deploy_gpu.sh
git diff --check
uv run --no-project --with huggingface-hub==1.29.0 \
  python serverless/pytorch/facebookresearch/sam3/prepare_checkpoint.py --verify-only
/tmp/nuctl-1.16.3 get functions --platform local
```

Expected: all tests/checks pass, checkpoint verifies, and the live Nuclio inventory is still empty.

- [ ] **Step 2: Invoke requesting-code-review for the whole hardening boundary**

Review against:

- the approved HTML design;
- secret handling and token absence;
- exact runtime/model revision pins;
- checkpoint integrity and atomicity;
- read-only volume configuration;
- preservation of the current point/box behavior;
- no deployment, RF-DETR, frontend, or unrelated CVAT changes.

Fix any findings using a new failing test before changing production code, then rerun Step 1.

- [ ] **Step 3: Present the uncommitted implementation evidence**

Run:

```bash
git status --short --branch
git diff --stat
git diff --check
docker image inspect cvat.pth.facebookresearch.sam3.interactor:hardening-20260901-r4 \
  --format '{{.Id}} {{.Created}}'
```

Report:

- branch/worktree and changed files;
- test counts and exact verification commands;
- checkpoint revision, size, and SHA-256;
- candidate image ID;
- real GPU initialization result;
- unchanged Nuclio function inventory;
- explicit statement that nothing was committed, pushed, merged, or deployed.

- [ ] **Step 4: Stop and request separate boundaries**

Ask separately for:

1. commit authorization for the reviewed worktree changes;
2. replacement of the host `nuctl` 1.15.10 binary with 1.16.3, if desired;
3. live SAM3-only Nuclio deployment authorization;
4. authenticated browser smoke testing after deployment.

Do not infer one authorization from another.
