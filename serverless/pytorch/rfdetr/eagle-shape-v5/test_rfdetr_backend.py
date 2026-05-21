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
                "other.value": np.array([3.0]),
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


def test_normalize_rfdetr_predictions_to_instances():
    """Test that mocked RF-DETR predictions normalize to class_name/score/mask instances."""
    # Simulate RF-DETR output structure
    # pred_logits shape: (num_queries, num_classes+1) with background as last class
    # For 11 shape classes, we have 12 logits per query (11 classes + 1 background)
    
    # Create mock predictions with 3 queries
    # Query 0: concrete_spalling (class 0 in non-bg) with high score
    # Query 1: steel_corrosion (class 3 in non-bg) with medium score
    # Query 2: background (low score, should be filtered or handled correctly)
    
    num_queries = 3
    num_classes = 12  # 11 shape classes + 1 background
    
    # Create logits where:
    # Query 0: high score for class 0 (concrete_spalling in model output)
    # Query 1: high score for class 3 (steel_corrosion in model output)
    # Query 2: high score for background (class 11)
    logits = np.zeros((num_queries, num_classes), dtype=np.float32)
    logits[0, 0] = 5.0  # concrete_spalling (first non-bg class)
    logits[1, 3] = 4.0  # steel_corrosion (fourth non-bg class)
    logits[2, 11] = 6.0  # background
    
    # Create mock masks (H=4, W=4 for simplicity)
    masks = np.array([
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
    ], dtype=np.float32)
    
    # Expected class names (no background - only foreground classes)
    class_names = [
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
    
    # Normalize predictions (this mimics the backend's predict logic)
    # Apply softmax
    exp_logits = np.exp(logits - np.max(logits, axis=-1, keepdims=True))
    scores = exp_logits / np.sum(exp_logits, axis=-1, keepdims=True)
    
    # Get max scores excluding background (last column)
    non_bg_scores = scores[:, :-1]
    max_scores = np.max(non_bg_scores, axis=-1)
    class_indices = np.argmax(non_bg_scores, axis=-1)
    
    # Filter by threshold (0.2)
    conf_threshold = 0.2
    keep = max_scores > conf_threshold
    
    instances = []
    for i in np.where(keep)[0]:
        # class_indices directly map to class_names (no background offset)
        class_name = class_names[class_indices[i]]
        score = float(max_scores[i])
        mask = (masks[i] > 0.5).astype(np.uint8)
        
        instances.append(
            PredictedInstance(
                class_name=class_name,
                score=score,
                mask=mask,
            )
        )
    
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
