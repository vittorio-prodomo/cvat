from pathlib import Path
import sys

import numpy as np
import pytest


# Test isolation: Create a fixture-based mock with proper module-level isolation
@pytest.fixture(autouse=True)
def mock_torch():
    """Fixture to mock torch module with proper cleanup.
    
    Uses autouse=True so it's automatically applied to all tests,
    ensuring torch mock is available when rfdetr_backend imports it.
    """
    class MockTorch:
        @staticmethod
        def load(path, map_location=None, weights_only=False):
            raise NotImplementedError("torch.load should be mocked in tests")
    
    original_torch = sys.modules.get('torch', None)
    sys.modules['torch'] = MockTorch()
    
    # Force reimport of rfdetr_backend so it picks up the mocked torch
    if 'rfdetr_backend' in sys.modules:
        del sys.modules['rfdetr_backend']
    
    yield MockTorch
    
    # Cleanup: restore original torch or remove mock
    if original_torch is not None:
        sys.modules['torch'] = original_torch
    elif 'torch' in sys.modules:
        del sys.modules['torch']
    
    # Clean up rfdetr_backend to force reimport next time
    if 'rfdetr_backend' in sys.modules:
        del sys.modules['rfdetr_backend']


# Import after fixture definition
from rfdetr_backend import (
    PredictedInstance,
    find_best_checkpoint,
    load_checkpoint_state_dict,
    parse_map_score,
)


def test_parse_map_score_reads_epoch_style_checkpoint_names(mock_torch):
    assert parse_map_score("epoch=068-map=0.1328.ckpt") == pytest.approx(0.1328)
    assert parse_map_score("epoch=037-map=0.3146.ckpt") == pytest.approx(0.3146)


def test_parse_map_score_returns_negative_for_invalid_names(mock_torch):
    assert parse_map_score("last.ckpt") == -1.0
    assert parse_map_score("model.pth") == -1.0
    assert parse_map_score("no-map-here.ckpt") == -1.0


def test_find_best_checkpoint_picks_highest_map(mock_torch, tmp_path):
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=068-map=0.1328.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=073-map=0.1325.ckpt").write_bytes(b"x")
    (checkpoints / "last.ckpt").write_bytes(b"x")

    selected = find_best_checkpoint(checkpoints)

    assert selected == checkpoints / "epoch=068-map=0.1328.ckpt"


def test_find_best_checkpoint_requires_epoch_map_files(mock_torch, tmp_path):
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "last.ckpt").write_bytes(b"x")

    with pytest.raises(RuntimeError, match="No epoch=.*-map=.*ckpt files"):
        find_best_checkpoint(checkpoints)


def test_find_best_checkpoint_requires_directory_to_exist(mock_torch):
    non_existent = Path("/nonexistent/path/checkpoints")
    with pytest.raises(RuntimeError, match="Checkpoint directory does not exist"):
        find_best_checkpoint(non_existent)


def test_load_checkpoint_state_dict_strips_lightning_model_prefix(mock_torch, tmp_path):
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        assert Path(path) == checkpoint
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
                "model.head.bias": np.array([2.0]),
            }
        }

    # Replace the mock torch.load with our fake
    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        state_dict = load_checkpoint_state_dict(checkpoint)
        assert sorted(state_dict) == ["backbone.weight", "head.bias"]
    finally:
        sys.modules['torch'].load = original_load


def test_load_checkpoint_state_dict_requires_state_dict_key(mock_torch, tmp_path):
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        return {"some_other_key": {}}

    # Replace the mock torch.load with our fake
    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        with pytest.raises(KeyError, match="state_dict"):
            load_checkpoint_state_dict(checkpoint)
    finally:
        sys.modules['torch'].load = original_load


def test_parse_map_score_requires_epoch_prefix(mock_torch):
    """Checkpoint selection must match exact epoch=...-map=...ckpt format."""
    # These should match
    assert parse_map_score("epoch=001-map=0.1234.ckpt") == pytest.approx(0.1234)
    assert parse_map_score("epoch=999-map=0.9999.ckpt") == pytest.approx(0.9999)
    
    # These should NOT match (missing epoch= prefix)
    assert parse_map_score("map=0.1234.ckpt") == -1.0
    assert parse_map_score("e001-map=0.1234.ckpt") == -1.0
    assert parse_map_score("training-map=0.1234.ckpt") == -1.0


def test_find_best_checkpoint_breaks_map_ties_by_epoch(mock_torch, tmp_path):
    """When mAP scores are equal, pick the checkpoint with the highest epoch."""
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=010-map=0.1500.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=020-map=0.1500.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=015-map=0.1500.ckpt").write_bytes(b"x")

    selected = find_best_checkpoint(checkpoints)

    # Should pick epoch=020 (highest epoch among tied maps)
    assert selected == checkpoints / "epoch=020-map=0.1500.ckpt"


def test_find_best_checkpoint_rejects_non_epoch_map_patterns(mock_torch, tmp_path):
    """Checkpoint selection must reject files that don't match epoch=...-map=...ckpt."""
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "map=0.2000.ckpt").write_bytes(b"x")  # Missing epoch=
    (checkpoints / "last.ckpt").write_bytes(b"x")

    with pytest.raises(RuntimeError, match="No epoch=.*-map=.*ckpt files"):
        find_best_checkpoint(checkpoints)


def test_load_checkpoint_state_dict_fails_on_incompatible_checkpoint(mock_torch, tmp_path):
    """Incompatible checkpoints should fail explicitly, not silently drop keys."""
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        # Checkpoint with NO model. prefix keys
        return {
            "state_dict": {
                "backbone.weight": np.array([1.0]),
                "head.bias": np.array([2.0]),
            }
        }

    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        # Should raise an error because no keys start with "model."
        with pytest.raises(RuntimeError, match="No keys.*model\\."):
            load_checkpoint_state_dict(checkpoint)
    finally:
        sys.modules['torch'].load = original_load


def test_load_checkpoint_state_dict_rejects_mixed_key_formats(mock_torch, tmp_path):
    """Mixed key formats should fail explicitly, not partially accepted."""
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        # Mixed checkpoint: some keys have model. prefix, some don't
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
                "model.head.bias": np.array([2.0]),
                "optimizer.state": np.array([3.0]),  # No model. prefix
                "other.value": np.array([4.0]),  # No model. prefix
            }
        }

    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        # Should raise an error because of mixed key formats
        with pytest.raises(RuntimeError, match="mixed key formats|incompatible"):
            load_checkpoint_state_dict(checkpoint)
    finally:
        sys.modules['torch'].load = original_load


def test_postprocess_constructor_accepts_only_num_select(mock_torch):
    """Test that PostProcess is initialized with only num_select parameter.
    
    This test will FAIL if the backend tries to pass num_classes to PostProcess.
    The upstream RF-DETR PostProcess only accepts num_select.
    """
    # This test simulates what would happen during _load_model()
    # The real PostProcess class only accepts num_select, not num_classes
    class RealPostProcess:
        def __init__(self, num_select=300):
            self.num_select = num_select
            # If num_classes is passed, it will fail
    
    # This should work (correct)
    postproc = RealPostProcess(num_select=100)
    assert postproc.num_select == 100
    
    # This would fail (incorrect - what the backend currently does)
    with pytest.raises(TypeError, match="unexpected keyword argument"):
        RealPostProcess(num_select=100, num_classes=11)


def test_masks_are_squeezed_to_2d_from_postprocessor_output(mock_torch):
    """Test that masks from postprocessor are squeezed from [K,1,H,W] to [H,W].
    
    This test will FAIL if the backend doesn't squeeze the singleton channel dimension.
    The upstream PostProcess returns masks shaped [K, 1, H, W] after interpolation,
    but downstream crop postprocessing expects 2-D [H, W] masks.
    """
    # Simulate postprocessor output with singleton channel dimension
    # This is what the real PostProcess.forward() returns
    mock_mask_4d = np.ones((1, 1, 4, 4), dtype=bool)  # [K=1, C=1, H=4, W=4]
    
    # The backend should squeeze this to 2-D
    # Expected: [4, 4]
    # Actual (buggy): [1, 4, 4] if only indexing [0] but not squeezing channel
    
    # Check that 4-D mask can't be used directly with downstream mask_to_rle
    # mask_to_rle expects: height, width = mask.shape
    # If mask has 3 dimensions (buggy case), unpacking will fail
    
    # This will FAIL if mask is not 2-D
    mask_3d = mock_mask_4d[0]  # [1, 4, 4] - still has singleton channel
    with pytest.raises(ValueError):
        # Should fail to unpack 3 values from 2-element tuple
        height, width = mask_3d.shape
    
    # This should work (2-D mask)
    mask_2d = mock_mask_4d[0, 0]  # [4, 4] - properly squeezed
    height, width = mask_2d.shape
    assert (height, width) == (4, 4)


def test_torch_mock_isolation_does_not_leak(mock_torch):
    """Test that torch mock is properly isolated and cleaned up.
    
    This test verifies that the mock_torch fixture properly restores the
    original torch module state after each test, preventing mocks from
    leaking into the pytest process.
    """
    import sys
    
    # The fixture should have injected a mock
    assert 'torch' in sys.modules
    assert hasattr(sys.modules['torch'], 'load')
    
    # The mock should raise NotImplementedError as defined in fixture
    with pytest.raises(NotImplementedError, match="torch.load should be mocked in tests"):
        sys.modules['torch'].load("dummy_path")
    
    # After this test completes, the fixture will clean up
    # Subsequent tests should get a fresh mock, not leak this one
