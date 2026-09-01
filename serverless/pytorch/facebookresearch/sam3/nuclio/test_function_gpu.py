from pathlib import Path

import yaml


MANIFEST_PATH = Path(__file__).with_name('function-gpu.yaml')
CONSTRAINTS_PATH = Path(__file__).with_name('sam3-runtime-constraints.txt')
SAM3_REVISION = '660a5e9e1b8b4c02c0ad97229b88a09a6e4ff5b7'
HOST_MODEL_DIR = '/data/cvat/data/models/sam3'
CONTAINER_MODEL_DIR = '/opt/nuclio/models/sam3'
CONTAINER_CONSTRAINTS_PATH = '/opt/nuclio/sam3-runtime-constraints.txt'
CUDA_BASE_IMAGE = (
    'nvidia/cuda:12.8.0-cudnn-runtime-ubuntu24.04'
    '@sha256:c40d1065da90274969f9faa7fe1a7fcd1c374d5783482eec09ee5b516746088f'
)
UBUNTU_SNAPSHOT = '20260901T000000Z'

EXPECTED_RUNTIME_CONSTRAINTS = {
    'anyio==4.14.2',
    'certifi==2026.7.22',
    'click==8.5.0',
    'cuda-bindings==12.9.4',
    'cuda-pathfinder==1.6.0',
    'einops==0.8.2',
    'filelock==3.32.3',
    'fsspec==2026.7.0',
    'ftfy==6.1.1',
    'h11==0.16.0',
    'hf-xet==1.6.0',
    'httpcore==1.0.9',
    'httpx==0.28.1',
    'huggingface-hub==1.29.0',
    'idna==3.19',
    'iopath==0.1.10',
    'jinja2==3.1.6',
    'markupsafe==3.0.3',
    'mpmath==1.3.0',
    'msgpack==1.1.0',
    'networkx==3.6.1',
    'nuclio-sdk==0.6.3',
    'numpy==1.26.4',
    'nvidia-cublas-cu12==12.8.4.1',
    'nvidia-cuda-cupti-cu12==12.8.90',
    'nvidia-cuda-nvrtc-cu12==12.8.93',
    'nvidia-cuda-runtime-cu12==12.8.90',
    'nvidia-cudnn-cu12==9.10.2.21',
    'nvidia-cufft-cu12==11.3.3.83',
    'nvidia-cufile-cu12==1.13.1.3',
    'nvidia-curand-cu12==10.3.9.90',
    'nvidia-cusolver-cu12==11.7.3.90',
    'nvidia-cusparse-cu12==12.5.8.93',
    'nvidia-cusparselt-cu12==0.7.1',
    'nvidia-nccl-cu12==2.27.5',
    'nvidia-nvjitlink-cu12==12.8.93',
    'nvidia-nvshmem-cu12==3.4.5',
    'nvidia-nvtx-cu12==12.8.90',
    'packaging==26.3',
    'pillow==12.3.0',
    'pip==26.2.1',
    'portalocker==4.3.0',
    'psutil==7.2.2',
    'pycocotools==2.0.11',
    'pyyaml==6.0.3',
    'regex==2026.9.3',
    'safetensors==0.8.0',
    'sam3==0.1.0',
    'setuptools==80.10.2',
    'sympy==1.14.0',
    'timm==1.0.29',
    'torch==2.10.0+cu128',
    'torchvision==0.25.0+cu128',
    'tqdm==4.70.0',
    'triton==3.6.0',
    'typing-extensions==4.16.0',
    'wcwidth==0.8.3',
    'wheel==0.48.0',
}


def load_manifest():
    return yaml.safe_load(MANIFEST_PATH.read_text(encoding='utf-8'))


def run_directives(manifest):
    return [
        directive['value']
        for phase in ('preCopy', 'postCopy')
        for directive in manifest['spec']['build']['directives'].get(phase, [])
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
    assert manifest['spec']['build']['baseImage'] == CUDA_BASE_IMAGE
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


def test_manifest_locks_os_snapshot_and_complete_python_resolution():
    manifest = load_manifest()
    pre_copy_commands = run_directives(manifest)
    apt_command = next(
        command for command in pre_copy_commands if 'apt-get update' in command
    )
    packaging_command = next(
        command for command in pre_copy_commands if 'pip==26.2.1' in command
    )
    post_copy_commands = [
        directive['value']
        for directive in manifest['spec']['build']['directives']['postCopy']
        if directive['kind'] == 'RUN'
    ]
    constrained_commands = [
        command
        for command in post_copy_commands
        if f'--constraint {CONTAINER_CONSTRAINTS_PATH}' in command
    ]
    constraints = {
        line.strip().lower()
        for line in CONSTRAINTS_PATH.read_text(encoding='utf-8').splitlines()
        if line.strip() and not line.startswith('#')
    }

    assert f'apt-get update --snapshot {UBUNTU_SNAPSHOT}' in apt_command
    assert f'apt-get -y install --snapshot {UBUNTU_SNAPSHOT}' in apt_command
    assert 'gcc' in apt_command
    assert 'libc6-dev' in apt_command
    assert 'python3-dev' in apt_command
    assert 'packaging==26.3' in packaging_command
    assert len(constrained_commands) == 2
    assert constraints == EXPECTED_RUNTIME_CONSTRAINTS


def test_manifest_constrains_sam3_isolated_build_environment():
    manifest = load_manifest()
    sam3_install_command = next(
        command
        for command in run_directives(manifest)
        if 'git+https://github.com/facebookresearch/sam3.git@' in command
    )

    assert f'--build-constraint {CONTAINER_CONSTRAINTS_PATH}' in sam3_install_command


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
