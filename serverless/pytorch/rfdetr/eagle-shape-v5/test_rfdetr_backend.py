from pathlib import Path

import numpy as np
import pytest

# Mock torch before importing rfdetr_backend
class MockTorch:
    @staticmethod
    def load(path, map_location=None, weights_only=False):
        # This will be replaced by test fixtures
        raise NotImplementedError("torch.load should be mocked in tests")

import sys
sys.modules['torch'] = MockTorch()

from rfdetr_backend import (
    PredictedInstance,
    find_best_checkpoint,
    load_checkpoint_state_dict,
    parse_map_score,
)


def test_parse_map_score_reads_epoch_style_checkpoint_names():
    assert parse_map_score("epoch=068-map=0.1328.ckpt") == pytest.approx(0.1328)
    assert parse_map_score("epoch=037-map=0.3146.ckpt") == pytest.approx(0.3146)


def test_parse_map_score_returns_negative_for_invalid_names():
    assert parse_map_score("last.ckpt") == -1.0
    assert parse_map_score("model.pth") == -1.0
    assert parse_map_score("no-map-here.ckpt") == -1.0


def test_find_best_checkpoint_picks_highest_map(tmp_path):
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=068-map=0.1328.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=073-map=0.1325.ckpt").write_bytes(b"x")
    (checkpoints / "last.ckpt").write_bytes(b"x")

    selected = find_best_checkpoint(checkpoints)

    assert selected == checkpoints / "epoch=068-map=0.1328.ckpt"


def test_find_best_checkpoint_requires_epoch_map_files(tmp_path):
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "last.ckpt").write_bytes(b"x")

    with pytest.raises(RuntimeError, match="No epoch=.*-map=.*ckpt files"):
        find_best_checkpoint(checkpoints)


def test_find_best_checkpoint_requires_directory_to_exist():
    non_existent = Path("/nonexistent/path/checkpoints")
    with pytest.raises(RuntimeError, match="Checkpoint directory does not exist"):
        find_best_checkpoint(non_existent)


def test_load_checkpoint_state_dict_strips_lightning_model_prefix(tmp_path):
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


def test_load_checkpoint_state_dict_requires_state_dict_key(tmp_path):
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


def test_parse_map_score_requires_epoch_prefix():
    """Checkpoint selection must match exact epoch=...-map=...ckpt format."""
    # These should match
    assert parse_map_score("epoch=001-map=0.1234.ckpt") == pytest.approx(0.1234)
    assert parse_map_score("epoch=999-map=0.9999.ckpt") == pytest.approx(0.9999)
    
    # These should NOT match (missing epoch= prefix)
    assert parse_map_score("map=0.1234.ckpt") == -1.0
    assert parse_map_score("e001-map=0.1234.ckpt") == -1.0
    assert parse_map_score("training-map=0.1234.ckpt") == -1.0


def test_find_best_checkpoint_breaks_map_ties_by_epoch(tmp_path):
    """When mAP scores are equal, pick the checkpoint with the highest epoch."""
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=010-map=0.1500.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=020-map=0.1500.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=015-map=0.1500.ckpt").write_bytes(b"x")

    selected = find_best_checkpoint(checkpoints)

    # Should pick epoch=020 (highest epoch among tied maps)
    assert selected == checkpoints / "epoch=020-map=0.1500.ckpt"


def test_find_best_checkpoint_rejects_non_epoch_map_patterns(tmp_path):
    """Checkpoint selection must reject files that don't match epoch=...-map=...ckpt."""
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "map=0.2000.ckpt").write_bytes(b"x")  # Missing epoch=
    (checkpoints / "last.ckpt").write_bytes(b"x")

    with pytest.raises(RuntimeError, match="No epoch=.*-map=.*ckpt files"):
        find_best_checkpoint(checkpoints)


def test_load_checkpoint_state_dict_fails_on_incompatible_checkpoint(tmp_path):
    """Incompatible checkpoints should fail explicitly, not silently drop keys."""
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


def test_load_checkpoint_state_dict_rejects_mixed_key_formats(tmp_path):
    """Mixed key formats should fail explicitly, not partially accepted."""
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


def test_normalize_rfdetr_predictions_to_instances():
    """Test that RF-DETR backend normalizes predictions to class_name/score/mask instances."""
    # This test exercises the normalization logic by creating a helper function
    # and testing it directly, ensuring we test the actual normalization path.
    
    # First, let's refactor the backend to have a separate normalization helper
    # For now, we'll test the predict method's normalization using comprehensive mocks
    
    # We'll use a pytest approach: import backend, patch dependencies, call predict
    from unittest.mock import Mock, patch, MagicMock
    from rfdetr_backend import RFDETRShapeBackend
    
    # Create mock torch tensors that behave correctly
    class MockTensor:
        def __init__(self, data):
            self.data = np.array(data) if not isinstance(data, np.ndarray) else data
        
        def softmax(self, dim):
            # Apply softmax along specified dimension
            exp_data = np.exp(self.data - np.max(self.data, axis=dim, keepdims=True))
            softmax_data = exp_data / np.sum(exp_data, axis=dim, keepdims=True)
            return MockTensor(softmax_data)
        
        def max(self, dim):
            # Return max values and indices
            max_vals = np.max(self.data, axis=dim)
            max_indices = np.argmax(self.data, axis=dim)
            return MockTensor(max_vals), MockTensor(max_indices)
        
        def __getitem__(self, key):
            # Handle tensor slicing
            if isinstance(key, (tuple, slice, int)):
                return MockTensor(self.data[key])
            elif hasattr(key, 'data'):  # Another MockTensor (boolean mask)
                return MockTensor(self.data[key.data])
            return MockTensor(self.data[key])
        
        def __gt__(self, value):
            return MockTensor(self.data > value)
        
        def any(self):
            return np.any(self.data)
        
        def item(self):
            # Return int for integer dtypes, float otherwise
            val = self.data.item() if hasattr(self.data, 'item') else self.data
            if self.data.dtype in [np.int32, np.int64, np.int16, np.int8]:
                return int(val)
            return float(val) if np.isscalar(val) else val
        
        def cpu(self):
            return self
        
        def numpy(self):
            return self.data
    
    # Create mock outputs
    logits_data = np.zeros((1, 3, 12), dtype=np.float32)
    logits_data[0, 0, 0] = 5.0  # concrete_spalling
    logits_data[0, 1, 3] = 4.0  # steel_corrosion
    logits_data[0, 2, 11] = 6.0  # background
    
    masks_data = np.array([[
        [[0.9, 0.8, 0.1, 0.0],
         [0.7, 0.9, 0.2, 0.1],
         [0.1, 0.2, 0.0, 0.0],
         [0.0, 0.1, 0.0, 0.0]],
        
        [[0.0, 0.1, 0.8, 0.9],
         [0.1, 0.0, 0.7, 0.8],
         [0.0, 0.0, 0.1, 0.2],
         [0.0, 0.0, 0.0, 0.1]],
        
        [[0.1, 0.1, 0.1, 0.1],
         [0.1, 0.1, 0.1, 0.1],
         [0.1, 0.1, 0.1, 0.1],
         [0.1, 0.1, 0.1, 0.1]],
    ]], dtype=np.float32)
    
    mock_outputs = {
        "pred_logits": MockTensor(logits_data),
        "pred_masks": MockTensor(masks_data),
    }
    
    # Create mock model
    mock_model = Mock()
    mock_model.return_value = mock_outputs
    
    # Create a mock backend with the model already loaded
    with patch('rfdetr_backend.find_best_checkpoint') as mock_find_ckpt:
        # Set up checkpoint path
        import tempfile
        with tempfile.TemporaryDirectory() as tmp_dir:
            checkpoint_dir = Path(tmp_dir) / "checkpoints"
            checkpoint_dir.mkdir()
            ckpt_path = checkpoint_dir / "epoch=001-map=0.5000.ckpt"
            ckpt_path.write_bytes(b"x")
            mock_find_ckpt.return_value = ckpt_path
            
            # Create backend instance
            backend = RFDETRShapeBackend(
                checkpoint_dir=checkpoint_dir,
                conf_threshold=0.2,
                _skip_mount_check=True,
            )
            
            # Directly set the model to bypass loading
            backend._model = mock_model
            backend._class_names = [
                "concrete_spalling",
                "concrete_exposed_bars",
                "concrete_crack",
                "steel_corrosion",
                "steel_crack",
                "steel_fatigue_crack",
                "steel_bolt_corrosion",
                "steel_rivet_corrosion",
                "steel_fastener_corrosion",
                "concrete_efflorescence",
            ]
            
            # Create test image
            test_image = np.random.randint(0, 255, (8, 8, 3), dtype=np.uint8)
            
            # Mock torch operations for image preprocessing
            with patch('rfdetr_backend.torch') as mock_torch:
                # Set up mock torch tensor operations
                mock_torch.from_numpy = Mock(return_value=Mock(
                    permute=Mock(return_value=Mock(
                        float=Mock(return_value=Mock(
                            __truediv__=Mock(return_value=Mock(
                                __sub__=Mock(return_value=Mock(
                                    __truediv__=Mock(return_value=Mock(
                                        unsqueeze=Mock(return_value=Mock())
                                    ))
                                ))
                            ))
                        ))
                    ))
                ))
                mock_torch.tensor = Mock(side_effect=lambda x: Mock(view=Mock(return_value=Mock(data=np.array(x)))))
                mock_torch.no_grad = Mock(return_value=Mock(__enter__=Mock(), __exit__=Mock()))
                
                # Call predict - this exercises the actual normalization logic
                instances = backend.predict(test_image)
            
            # Validate results
            assert len(instances) == 2  # Two queries pass threshold (not background)
            
            # First instance should be concrete_spalling
            assert instances[0].class_name == "concrete_spalling"
            assert instances[0].score > 0.5
            assert instances[0].mask.shape == (4, 4)
            assert instances[0].mask.dtype == np.uint8
            assert instances[0].mask[0, 0] == 1  # Top-left should be 1 (0.9 > 0.5)
            assert instances[0].mask[0, 3] == 0  # Top-right should be 0 (0.0 < 0.5)
            
            # Second instance should be steel_corrosion
            assert instances[1].class_name == "steel_corrosion"
            assert instances[1].score > 0.5
            assert instances[1].mask.shape == (4, 4)
            assert instances[1].mask[0, 2] == 1  # Should have high mask values
            assert instances[1].mask[0, 0] == 0  # Should have low mask values
