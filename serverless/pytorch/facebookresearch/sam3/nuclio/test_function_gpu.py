from pathlib import Path


def test_function_gpu_manifest_installs_modern_packaging_tools_and_runtime_deps():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'python -m pip install --upgrade pip setuptools wheel' in manifest
    assert 'python -m pip install --no-cache-dir pillow git+https://github.com/facebookresearch/sam3.git einops pycocotools psutil' in manifest


def test_function_gpu_manifest_does_not_embed_shell_placeholders_for_runtime_env():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert '${HF_TOKEN}' not in manifest
    assert '${SAM3_MODEL_VERSION' not in manifest
    assert '${SAM3_CHECKPOINT_PATH' not in manifest


def test_deploy_gpu_script_forwards_optional_sam3_runtime_env_vars():
    deploy_script = Path(__file__).resolve().parents[4] / 'deploy_gpu.sh'
    content = deploy_script.read_text(encoding='utf-8')

    assert '--env HF_TOKEN="$HF_TOKEN"' in content
    assert '--env SAM3_MODEL_VERSION="$SAM3_MODEL_VERSION"' in content
    assert '--env SAM3_CHECKPOINT_PATH="$SAM3_CHECKPOINT_PATH"' in content
