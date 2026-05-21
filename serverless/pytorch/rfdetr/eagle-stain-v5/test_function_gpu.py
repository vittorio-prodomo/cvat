from pathlib import Path


def test_function_gpu_declares_box_only_interactor():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'type: interactor' in manifest
    assert 'startswith_box: true' in manifest
    assert 'startswith_box_optional' not in manifest
    assert 'MODEL_CONF_THRESHOLD' in manifest
    assert '0.2' in manifest


def test_function_gpu_references_stain_checkpoint_root():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'echo-combined-v5/stain_round1' in manifest


def test_function_gpu_uses_volume_mount_mode_for_host_path_weights():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'hostPath:' in manifest
    assert 'mountMode: volume' in manifest
    assert 'restartPolicy:' in manifest


def test_function_gpu_declares_rfdetr_interactor():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    # Verify it's an RF-DETR based interactor
    assert 'rfdetr' in manifest.lower() or 'detr' in manifest.lower()


def test_function_gpu_declares_runtime_closure_for_rfdetr_imports():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    for dependency in [
        'libglib2.0-0',
        'libgl1',
        'libxcb1',
        'numpy<2',
        'torchvision==0.16.0',
        'transformers==4.41.2',
        'peft==0.10.0',
        'opencv-python-headless==4.10.0.84',
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
        assert dependency in manifest


def test_function_gpu_mount_paths_consistent_with_opt_bdd():
    """Manifest mount paths, PYTHONPATH, and env-configured paths must all align on /opt/bdd container root.
    
    This test verifies the fix for the deployment-path issue where:
    - CHECKPOINT_DIR and CONFIG_PATH correctly use /opt/bdd/runs/echo-combined-v5/stain_round1/...
    - PYTHONPATH must also use /opt/bdd/... (not /data/projects/...) to match the volume mount contract
    - The volume mount for BDD paths must mount at /opt/bdd
    
    Without this fix, PYTHONPATH expects /data/projects/bridge_defect_detection/training-toolkit/src
    but the mount only provides /data (not /data/projects/...), causing import failures at runtime.
    """
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')
    
    # All checkpoint/config env vars must use /opt/bdd prefix
    assert 'CHECKPOINT_DIR' in manifest
    assert '/opt/bdd/runs/echo-combined-v5/stain_round1/checkpoints' in manifest
    assert 'CONFIG_PATH' in manifest
    assert '/opt/bdd/runs/echo-combined-v5/stain_round1/config.yaml' in manifest
    
    # PYTHONPATH must also use /opt/bdd prefix, not /data/projects/...
    # The training-toolkit and rf-detr src dirs should be under /opt/bdd
    assert 'PYTHONPATH' in manifest
    assert '/opt/bdd/training-toolkit/src' in manifest
    assert '/opt/bdd/rf-detr/src' in manifest
    
    # Container mount path must be /opt/bdd, not /data
    assert 'mountPath: "/opt/bdd"' in manifest or 'mountPath: /opt/bdd' in manifest
    
    # PYTHONPATH should NOT reference /data as a container path
    lines = manifest.split('\n')
    pythonpath_line = next((line for line in lines if 'PYTHONPATH' in line), None)
    assert pythonpath_line is not None
    # Check the PYTHONPATH value line (next line after the name line)
    pythonpath_idx = lines.index(pythonpath_line)
    pythonpath_value = lines[pythonpath_idx + 1]
    assert '/data/' not in pythonpath_value or '/opt/bdd' in pythonpath_value
