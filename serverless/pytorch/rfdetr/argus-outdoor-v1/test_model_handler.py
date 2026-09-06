import hashlib
from types import SimpleNamespace

import numpy as np
from PIL import Image
import pytest


CLASSES = (
    "crack", "crack_map", "spall", "exposed_rebar", "efflorescence", "concrete_water_marks"
)


class ArrayBackend:
    def __init__(self, masks, labels, scores):
        self.prediction = {"masks": masks, "labels": labels, "scores": scores}
        self.calls = []

    def predict(self, image, threshold):
        self.calls.append((image, threshold))
        return self.prediction


def test_model_handler_maps_six_raw_classes_and_restores_dense_masks(load_argus):
    module = load_argus("model_handler")
    masks = np.zeros((6, 504, 504), dtype=bool)
    for index in range(6):
        masks[index, index, index] = True
    backend = ArrayBackend(masks, np.arange(6), np.full(6, 0.9))
    model = module.ModelHandler(backend=backend)
    shapes = model.handle(image=Image.new("RGB", (504, 503)), threshold=0.25)
    assert tuple(shape["label"] for shape in shapes) == CLASSES
    for index, shape in enumerate(shapes):
        assert shape == {
            "label": CLASSES[index], "type": "mask", "confidence": 0.9,
            "attributes": [], "mask": [1, index, index, index, index],
        }
    assert backend.calls[0][0].shape == (504, 504, 3)
    assert backend.calls[0][1] == 0.25


def test_empty_prediction_and_masks_wholly_in_padding_have_no_annotations(load_argus):
    module = load_argus("model_handler")
    backend = ArrayBackend(np.zeros((0, 504, 504), dtype=bool), np.array([], dtype=int), np.array([]))
    model = module.ModelHandler(backend=backend)
    assert model.handle(image=Image.new("RGB", (504, 503))) == []
    backend.prediction = {
        "masks": np.pad(np.ones((1, 1, 504), dtype=bool), ((0, 0), (503, 0), (0, 0))),
        "labels": np.array([0]), "scores": np.array([0.9]),
    }
    assert model.handle(image=Image.new("RGB", (504, 503))) == []


@pytest.mark.parametrize("label", [-1, 6, 0.5, np.nan, np.inf, True, "0"])
def test_model_handler_rejects_invalid_class_ids(load_argus, label):
    module = load_argus("model_handler")
    backend = ArrayBackend(np.ones((1, 504, 504), dtype=bool), np.array([label]), np.array([0.9]))
    with pytest.raises(ValueError, match="class"):
        module.ModelHandler(backend=backend).handle(image=Image.new("RGB", (17, 11)))


@pytest.mark.parametrize("score", [np.nan, np.inf, -np.inf, -0.1, 1.1])
def test_model_handler_rejects_invalid_model_scores(load_argus, score):
    module = load_argus("model_handler")
    backend = ArrayBackend(np.ones((1, 504, 504), dtype=bool), np.array([0]), np.array([score]))
    with pytest.raises(ValueError, match="score"):
        module.ModelHandler(backend=backend).handle(image=Image.new("RGB", (17, 11)))


@pytest.mark.parametrize("field,value", [
    ("masks", np.zeros((1, 252, 252), dtype=bool)),
    ("masks", np.zeros((0, 504, 504), dtype=bool)),
    ("scores", np.array([[0.9]])),
    ("labels", np.array([0, 1])),
])
def test_model_handler_rejects_inconsistent_prediction_dimensions(load_argus, field, value):
    module = load_argus("model_handler")
    backend = ArrayBackend(np.ones((1, 504, 504), dtype=bool), np.array([0]), np.array([0.9]))
    backend.prediction[field] = value
    with pytest.raises(ValueError):
        module.ModelHandler(backend=backend).handle(image=Image.new("RGB", (17, 11)))


def test_model_handler_rejects_undecoded_probability_masks(load_argus):
    module = load_argus("model_handler")
    backend = ArrayBackend(np.full((1, 504, 504), 0.9), np.array([0]), np.array([0.9]))
    with pytest.raises(ValueError, match="boolean"):
        module.ModelHandler(backend=backend).handle(image=Image.new("RGB", (17, 11)))


@pytest.mark.parametrize("value,expected", [(None, 0.2), (0, 0.0), (0.25, 0.25), (1, 1.0)])
def test_threshold_default_and_inclusive_request_range(load_argus, value, expected):
    module = load_argus("model_handler")
    assert module.validate_threshold(value) == expected


@pytest.mark.parametrize("value", [True, False, "0.2", [], {}, np.nan, np.inf, -np.inf, -0.01, 1.01])
def test_threshold_rejects_invalid_values(load_argus, value):
    module = load_argus("model_handler")
    with pytest.raises(ValueError, match="threshold"):
        module.validate_threshold(value)


def test_checkpoint_hash_is_checked_before_safe_loading_and_prefix_is_stripped(
    load_argus, tmp_path, monkeypatch
):
    module = load_argus("model_handler")
    path = tmp_path / "weights.ckpt"
    path.write_bytes(b"a pinned checkpoint")
    calls = []

    def fake_load(stream, *, map_location, weights_only):
        calls.append((stream.read(), map_location, weights_only))
        return {"state_dict": {"model.layer.weight": "tensor", "criterion.weight": "unused"}}

    monkeypatch.setattr(module, "CHECKPOINT_SHA256", hashlib.sha256(path.read_bytes()).hexdigest())
    assert module.load_checkpoint_state_dict(path, SimpleNamespace(load=fake_load)) == {"layer.weight": "tensor"}
    assert calls == [(b"a pinned checkpoint", "cpu", True)]
    path.write_bytes(b"changed checkpoint")
    with pytest.raises(ValueError, match="SHA256"):
        module.load_checkpoint_state_dict(path, SimpleNamespace(load=fake_load))
    assert len(calls) == 1


@pytest.mark.parametrize("checkpoint", [None, {}, {"state_dict": {}}, {"state_dict": []},
                                        {"state_dict": {"layer.weight": 1}}])
def test_checkpoint_missing_or_empty_model_state_fails(load_argus, tmp_path, monkeypatch, checkpoint):
    module = load_argus("model_handler")
    path = tmp_path / "weights.ckpt"
    path.write_bytes(b"pinned")
    monkeypatch.setattr(module, "CHECKPOINT_SHA256", hashlib.sha256(b"pinned").hexdigest())
    with pytest.raises(ValueError, match="state_dict|model"):
        module.load_checkpoint_state_dict(path, SimpleNamespace(load=lambda *args, **kwargs: checkpoint))
