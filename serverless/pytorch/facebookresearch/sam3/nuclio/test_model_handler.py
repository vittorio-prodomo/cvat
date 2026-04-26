import os
import numpy as np
import pytest
from PIL import Image
from types import ModuleType, SimpleNamespace
import sys

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


def test_init_reuses_image_backbone_for_interactive_predictor_when_missing(monkeypatch):
    fake_predictor_model = SimpleNamespace(backbone=None)
    fake_predictor = SimpleNamespace(model=fake_predictor_model)
    fake_model = SimpleNamespace(
        backbone='shared-backbone',
        inst_interactive_predictor=fake_predictor,
    )

    fake_builder_module = ModuleType('sam3.model_builder')
    fake_builder_module.build_sam3_image_model = lambda **kwargs: fake_model
    fake_builder_module.download_ckpt_from_hf = lambda version: '/tmp/sam3.pt'

    fake_sam3_package = ModuleType('sam3')
    fake_sam3_package.model_builder = fake_builder_module

    fake_torch_module = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))

    monkeypatch.setitem(sys.modules, 'sam3', fake_sam3_package)
    monkeypatch.setitem(sys.modules, 'sam3.model_builder', fake_builder_module)
    monkeypatch.setitem(sys.modules, 'torch', fake_torch_module)

    handler = ModelHandler()

    assert handler.predictor is fake_predictor
    assert fake_predictor.model.backbone == 'shared-backbone'


def test_init_rejects_sam3_1_for_interactive_masks(monkeypatch):
    fake_builder_module = ModuleType('sam3.model_builder')
    fake_builder_module.build_sam3_image_model = lambda **kwargs: None
    fake_builder_module.download_ckpt_from_hf = lambda version: '/tmp/sam3.pt'

    fake_sam3_package = ModuleType('sam3')
    fake_sam3_package.model_builder = fake_builder_module

    fake_torch_module = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))

    monkeypatch.setitem(sys.modules, 'sam3', fake_sam3_package)
    monkeypatch.setitem(sys.modules, 'sam3.model_builder', fake_builder_module)
    monkeypatch.setitem(sys.modules, 'torch', fake_torch_module)
    monkeypatch.setenv('SAM3_MODEL_VERSION', 'sam3.1')

    with pytest.raises(RuntimeError, match='sam3.1 .* not supported .* interactive'):
        ModelHandler()


def test_init_defaults_to_sam3_checkpoint_for_interactive_masks(monkeypatch):
    calls = []
    fake_predictor_model = SimpleNamespace(backbone='shared-backbone')
    fake_predictor = SimpleNamespace(model=fake_predictor_model)
    fake_model = SimpleNamespace(
        backbone='shared-backbone',
        inst_interactive_predictor=fake_predictor,
    )

    fake_builder_module = ModuleType('sam3.model_builder')
    fake_builder_module.build_sam3_image_model = lambda **kwargs: fake_model
    fake_builder_module.download_ckpt_from_hf = lambda version: calls.append(version) or '/tmp/sam3.pt'

    fake_sam3_package = ModuleType('sam3')
    fake_sam3_package.model_builder = fake_builder_module

    fake_torch_module = SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: True))

    monkeypatch.setitem(sys.modules, 'sam3', fake_sam3_package)
    monkeypatch.setitem(sys.modules, 'sam3.model_builder', fake_builder_module)
    monkeypatch.setitem(sys.modules, 'torch', fake_torch_module)
    monkeypatch.delenv('SAM3_MODEL_VERSION', raising=False)
    monkeypatch.delenv('SAM3_CHECKPOINT_PATH', raising=False)

    ModelHandler()

    assert calls == ['sam3']
