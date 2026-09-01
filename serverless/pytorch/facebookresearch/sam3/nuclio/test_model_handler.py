import hashlib
import numpy as np
import pytest
from PIL import Image
from types import ModuleType, SimpleNamespace
import sys

import model_handler
from model_handler import ModelHandler


class DummyPredictor:
    def __init__(self):
        self.received_image = None
        self.received_kwargs = None

    def set_image(self, image):
        self.received_image = image

    def predict(self, **kwargs):
        self.received_kwargs = kwargs
        masks = np.array(
            [
                [[0, 1], [0, 1]],
                [[1, 1], [0, 0]],
            ],
            dtype=np.uint8,
        )
        scores = np.array([0.1, 0.9], dtype=np.float32)
        low_res_masks = np.zeros((2, 256, 256), dtype=np.float32)
        return masks, scores, low_res_masks


def make_handler():
    handler = ModelHandler.__new__(ModelHandler)
    handler.predictor = DummyPredictor()
    return handler


@pytest.fixture
def local_checkpoint(monkeypatch, tmp_path):
    payload = b'checkpoint'
    checkpoint = tmp_path / 'sam3.pt'
    checkpoint.write_bytes(payload)
    monkeypatch.setenv('SAM3_CHECKPOINT_PATH', str(checkpoint))
    monkeypatch.setattr(model_handler, 'EXPECTED_CHECKPOINT_SIZE', len(payload))
    monkeypatch.setattr(
        model_handler,
        'EXPECTED_CHECKPOINT_SHA256',
        hashlib.sha256(payload).hexdigest(),
    )
    return checkpoint


def test_checkpoint_contract_uses_approved_artifact_literals():
    assert model_handler.EXPECTED_CHECKPOINT_SIZE == 3_450_062_241
    assert model_handler.EXPECTED_CHECKPOINT_SHA256 == (
        '9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e'
    )


def test_handle_selects_highest_scoring_mask_and_normalizes_prompts():
    handler = make_handler()
    image = Image.new('RGB', (2, 2), 'black')

    mask = handler.handle(
        image,
        pos_points=[[10.0, 20.0]],
        neg_points=[[30.0, 40.0]],
        obj_bbox=[[1.0, 2.0], [3.0, 4.0]],
    )

    assert mask == [[1, 1], [0, 0]]
    assert handler.predictor.received_image.tolist() == [
        [[0, 0, 0], [0, 0, 0]],
        [[0, 0, 0], [0, 0, 0]],
    ]
    assert handler.predictor.received_kwargs['point_coords'].tolist() == [[10.0, 20.0], [30.0, 40.0]]
    assert handler.predictor.received_kwargs['point_labels'].tolist() == [1, 0]
    assert handler.predictor.received_kwargs['box'].tolist() == [1.0, 2.0, 3.0, 4.0]
    assert handler.predictor.received_kwargs['multimask_output'] is True
    assert handler.predictor.received_kwargs['return_logits'] is False


def test_handle_requires_at_least_one_prompt():
    handler = make_handler()
    image = Image.new('RGB', (2, 2), 'black')

    with pytest.raises(ValueError, match='at least one point or a bounding box'):
        handler.handle(image, pos_points=[], neg_points=[], obj_bbox=None)


def test_init_reuses_image_backbone_for_interactive_predictor_when_missing(
    monkeypatch,
    local_checkpoint,
):
    fake_predictor_model = SimpleNamespace(backbone=None)
    fake_predictor = SimpleNamespace(model=fake_predictor_model)
    fake_model = SimpleNamespace(
        backbone='shared-backbone',
        inst_interactive_predictor=fake_predictor,
    )

    fake_builder_module = ModuleType('sam3.model_builder')
    fake_builder_module.build_sam3_image_model = lambda **kwargs: fake_model

    fake_sam3_package = ModuleType('sam3')
    fake_sam3_package.model_builder = fake_builder_module

    fake_torch_module = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))

    monkeypatch.setitem(sys.modules, 'sam3', fake_sam3_package)
    monkeypatch.setitem(sys.modules, 'sam3.model_builder', fake_builder_module)
    monkeypatch.setitem(sys.modules, 'torch', fake_torch_module)

    handler = ModelHandler()

    assert handler.predictor is fake_predictor
    assert fake_predictor.model.backbone == 'shared-backbone'


def test_init_requires_local_checkpoint_path(monkeypatch):
    monkeypatch.delenv('SAM3_CHECKPOINT_PATH', raising=False)

    with pytest.raises(RuntimeError, match='SAM3_CHECKPOINT_PATH is required'):
        ModelHandler()


def test_init_rejects_missing_local_checkpoint(monkeypatch, tmp_path):
    missing = tmp_path / 'missing.pt'
    monkeypatch.setenv('SAM3_CHECKPOINT_PATH', str(missing))

    with pytest.raises(RuntimeError, match='checkpoint file does not exist'):
        ModelHandler()


def test_init_rejects_checkpoint_size_mismatch(local_checkpoint):
    local_checkpoint.write_bytes(b'too-small')

    with pytest.raises(RuntimeError, match='size mismatch'):
        ModelHandler()


def test_init_rejects_same_size_checkpoint_hash_mismatch(local_checkpoint):
    local_checkpoint.write_bytes(b'checkpoinx')

    with pytest.raises(RuntimeError, match='SHA-256 mismatch'):
        ModelHandler()


def test_init_rejects_checkpoint_symlink(local_checkpoint):
    target = local_checkpoint.with_name('target.pt')
    target.write_bytes(local_checkpoint.read_bytes())
    local_checkpoint.unlink()
    local_checkpoint.symlink_to(target)

    with pytest.raises(RuntimeError, match='not a regular file'):
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
