import numpy as np
import pytest
from PIL import Image

from model_handler import ModelHandler


class DummyBoxes:
    def __init__(self):
        self.cls = np.array([0, 1], dtype=np.float32)
        self.conf = np.array([0.9, 0.7], dtype=np.float32)


class DummyMasks:
    def __init__(self):
        first = np.ones((64, 64), dtype=np.uint8)
        second = np.ones((64, 64), dtype=np.uint8)
        self.data = np.stack([first, second], axis=0)


class DummyResult:
    names = {0: 'mild_crack', 1: 'spall'}

    def __init__(self):
        self.boxes = DummyBoxes()
        self.masks = DummyMasks()


class DummyYOLO:
    def __init__(self, weights_path):
        self.weights_path = weights_path

    def predict(self, source, imgsz, conf, verbose):
        assert source.shape == (64, 64, 3)
        assert imgsz == 64
        assert conf == 0.2
        assert verbose is False
        return [DummyResult()]


class TensorLike:
    def __init__(self, array):
        self.array = np.array(array)

    def cpu(self):
        return self

    def numpy(self):
        return self.array

    def __array__(self, dtype=None):
        raise TypeError('must call cpu().numpy() first')


class GpuStyleBoxes:
    def __init__(self):
        self.cls = TensorLike([0, 1])
        self.conf = TensorLike([0.9, 0.7])


class GpuStyleMasks:
    def __init__(self):
        first = np.ones((64, 64), dtype=np.uint8)
        second = np.ones((64, 64), dtype=np.uint8)
        self.data = TensorLike(np.stack([first, second], axis=0))


class GpuStyleResult:
    names = {0: 'mild_crack', 1: 'spall'}

    def __init__(self):
        self.boxes = GpuStyleBoxes()
        self.masks = GpuStyleMasks()


class GpuStyleYOLO:
    def __init__(self, weights_path):
        self.weights_path = weights_path

    def predict(self, source, imgsz, conf, verbose):
        assert source.shape == (64, 64, 3)
        assert imgsz == 64
        assert conf == 0.2
        assert verbose is False
        return [GpuStyleResult()]


def test_model_handler_requires_existing_local_weights(tmp_path, monkeypatch):
    monkeypatch.setenv('MODEL_WEIGHTS_PATH', str(tmp_path / 'missing.pt'))
    monkeypatch.setenv('MODEL_INPUT_SIZE', '64')

    with pytest.raises(RuntimeError, match='MODEL_WEIGHTS_PATH'):
        ModelHandler()


def test_handle_returns_mapped_shapes_and_skips_unmapped_labels(tmp_path, monkeypatch):
    weights = tmp_path / 'model.pt'
    weights.write_bytes(b'weights')
    monkeypatch.setenv('MODEL_WEIGHTS_PATH', str(weights))
    monkeypatch.setenv('MODEL_INPUT_SIZE', '64')
    monkeypatch.setattr('backends.ultralytics.YOLO', DummyYOLO)

    handler = ModelHandler()
    image = Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8))
    shapes = handler.handle(
        image=image,
        obj_bbox=[[0, 0], [39, 29]],
        mapping={
            'mild_crack': {'name': 'mild_crack', 'attributes': {}},
        },
    )

    assert len(shapes) == 1
    assert shapes[0]['label'] == 'mild_crack'
    assert shapes[0]['type'] == 'mask'
    assert shapes[0]['points'][-4:] == [0, 0, 39, 29]
    assert shapes[0]['attributes'] == [{'spec_id': 0, 'value': '0.900000'}]


def test_handle_requires_a_bounding_box(tmp_path, monkeypatch):
    weights = tmp_path / 'model.pt'
    weights.write_bytes(b'weights')
    monkeypatch.setenv('MODEL_WEIGHTS_PATH', str(weights))
    monkeypatch.setenv('MODEL_INPUT_SIZE', '64')
    monkeypatch.setattr('backends.ultralytics.YOLO', DummyYOLO)

    handler = ModelHandler()
    image = Image.new('RGB', (40, 30), 'white')

    with pytest.raises(ValueError, match='bounding box'):
        handler.handle(image=image, obj_bbox=None, mapping={})


def test_handle_converts_tensor_like_yolo_outputs_before_numpy_use(tmp_path, monkeypatch):
    weights = tmp_path / 'model.pt'
    weights.write_bytes(b'weights')
    monkeypatch.setenv('MODEL_WEIGHTS_PATH', str(weights))
    monkeypatch.setenv('MODEL_INPUT_SIZE', '64')
    monkeypatch.setattr('backends.ultralytics.YOLO', GpuStyleYOLO)

    handler = ModelHandler()
    image = Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8))
    shapes = handler.handle(
        image=image,
        obj_bbox=[[0, 0], [39, 29]],
        mapping={
            'mild_crack': {'name': 'mild_crack', 'attributes': {}},
        },
    )

    assert len(shapes) == 1
    assert shapes[0]['label'] == 'mild_crack'
