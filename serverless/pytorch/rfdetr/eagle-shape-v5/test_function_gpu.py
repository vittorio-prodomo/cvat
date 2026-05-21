from pathlib import Path


def test_function_gpu_declares_box_only_interactor():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'type: interactor' in manifest
    assert 'startswith_box: true' in manifest
    assert 'startswith_box_optional' not in manifest
    assert 'MODEL_CONF_THRESHOLD' in manifest
    assert '0.2' in manifest


def test_function_gpu_references_shape_checkpoint_root():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'echo-combined-v5/shape_round1' in manifest


def test_function_gpu_uses_volume_mount_mode_for_host_path_weights():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    assert 'hostPath:' in manifest
    assert 'mountMode: volume' in manifest
    assert 'restartPolicy:' in manifest


def test_function_gpu_declares_rfdetr_interactor():
    manifest = Path(__file__).with_name('function-gpu.yaml').read_text(encoding='utf-8')

    # Verify it's an RF-DETR based interactor
    assert 'rfdetr' in manifest.lower() or 'detr' in manifest.lower()
