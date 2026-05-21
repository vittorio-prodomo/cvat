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
