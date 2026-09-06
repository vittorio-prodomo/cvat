from concurrent.futures import ThreadPoolExecutor
import sys
import threading
from types import SimpleNamespace

import numpy as np
import pytest


@pytest.fixture
def backend_runtime(load_indoor, monkeypatch):
    module = load_indoor("model_handler")
    torch = pytest.importorskip("torch")
    captured = {"outputs": {"pred_logits": torch.zeros((1, 1, 11)),
                            "pred_masks": torch.zeros((1, 1, 504, 504))}}

    class Model:
        def load_state_dict(self, state, *, strict):
            captured["state"] = state
            captured["strict"] = strict

        def to(self, device, *, dtype):
            captured["device"] = device
            captured["dtype"] = dtype
            return self

        def eval(self):
            captured["eval"] = True
            return self

        def __call__(self, *, samples):
            assert torch.is_inference_mode_enabled()
            captured["samples"] = samples
            return captured["outputs"]

    class Adapter:
        def create_model(self, config):
            captured["config"] = config
            self._val_conf_thres = config.extra["val_conf_thres"]
            return Model()

        def format_batch(self, batch):
            captured["batch"] = batch
            return {"inputs": {"samples": batch["images"]}}

        def postprocess_for_inference(self, outputs, image_sizes):
            assert outputs is captured["outputs"]
            captured["image_sizes"] = image_sizes
            captured.setdefault("thresholds", []).append(self._val_conf_thres)
            return [{
                "masks": torch.ones((1, 1008, 1008), dtype=torch.bool),
                "labels": torch.tensor([2]), "scores": torch.tensor([0.8]),
            }]

    monkeypatch.setitem(sys.modules, "training_toolkit.configs", SimpleNamespace(ModelConfig=SimpleNamespace))
    monkeypatch.setitem(sys.modules, "training_toolkit.models.rfdetr", SimpleNamespace(RFDETRAdapter=Adapter))
    monkeypatch.setattr(module, "load_checkpoint_state_dict", lambda path, torch_module: {"layer.weight": 7})
    return module, torch, captured


def test_backend_constructs_pinned_architecture_and_loads_all_weights_strictly(backend_runtime):
    module, torch, captured = backend_runtime
    module.IndoorBackend(device="cpu")
    config = captured["config"]
    assert config.name == "rf-detr-seg-large"
    assert config.pretrained == "none"
    assert config.num_classes == 11
    assert config.extra == {
        "mask_downsample_ratio": 2, "val_mask_downsample": 1,
        "val_conf_thres": 0.2, "val_nms_iou": 0.7, "val_max_det": 100,
    }
    assert captured["state"] == {"layer.weight": 7}
    assert captured["strict"] is True
    assert captured["device"] == "cpu"
    assert captured["dtype"] == torch.float32
    assert captured["eval"] is True


def test_backend_supplies_rgb_float32_batch_and_uses_adapter_full_mask_postprocess(backend_runtime):
    module, torch, captured = backend_runtime
    backend = module.IndoorBackend(device="cpu")
    image = np.empty((1008, 1008, 3), dtype=np.uint8)
    image[:] = [255, 128, 0]
    result = backend.predict(image, 0.65)
    tensor = captured["batch"]["images"]
    assert tensor.shape == (1, 3, 1008, 1008)
    assert tensor.dtype == torch.float32
    torch.testing.assert_close(tensor[0, :, 0, 0], torch.tensor([1.0, 128 / 255, 0.0]))
    assert captured["batch"]["targets"] == []
    assert captured["image_sizes"] == (1008, 1008)
    assert captured["thresholds"] == [0.65]
    assert backend._adapter._val_conf_thres == 0.2
    assert result["masks"].dtype == np.bool_
    assert result["labels"].tolist() == [2]
    np.testing.assert_allclose(result["scores"], [0.8])


def test_inference_failure_is_propagated_and_restores_threshold(backend_runtime, monkeypatch):
    module, _, _ = backend_runtime
    backend = module.IndoorBackend(device="cpu")

    def fail(*args, **kwargs):
        raise RuntimeError("broken CUDA inference")

    monkeypatch.setattr(backend._adapter, "postprocess_for_inference", fail)
    with pytest.raises(RuntimeError, match="broken CUDA"):
        backend.predict(np.zeros((1008, 1008, 3), dtype=np.uint8), 0.7)
    assert backend._adapter._val_conf_thres == 0.2


def test_concurrent_calls_keep_their_thresholds_isolated(backend_runtime, monkeypatch):
    module, _, captured = backend_runtime
    backend = module.IndoorBackend(device="cpu")
    first_inside = threading.Event()
    release_first = threading.Event()
    original = backend._adapter.postprocess_for_inference

    def blocked_postprocess(*args, **kwargs):
        if not first_inside.is_set():
            first_inside.set()
            assert release_first.wait(timeout=5)
        return original(*args, **kwargs)

    monkeypatch.setattr(backend._adapter, "postprocess_for_inference", blocked_postprocess)
    image = np.zeros((1008, 1008, 3), dtype=np.uint8)
    with ThreadPoolExecutor(max_workers=2) as pool:
        first = pool.submit(backend.predict, image, 0.25)
        assert first_inside.wait(timeout=5)
        second = pool.submit(backend.predict, image, 0.75)
        release_first.set()
        first.result(timeout=5)
        second.result(timeout=5)
    assert captured["thresholds"] == [0.25, 0.75]
    assert backend._adapter._val_conf_thres == 0.2


def test_backend_honors_checkpoint_environment(backend_runtime, monkeypatch):
    module, _, _ = backend_runtime
    received = []
    monkeypatch.setenv("CHECKPOINT_PATH", "/opt/models/custom-location.ckpt")
    monkeypatch.setattr(module, "load_checkpoint_state_dict", lambda path, torch_module: received.append(str(path)) or {})
    module.IndoorBackend(device="cpu")
    assert received == ["/opt/models/custom-location.ckpt"]


@pytest.mark.parametrize("key,value", [("pred_logits", float("nan")), ("pred_masks", float("inf"))])
def test_nonfinite_raw_model_output_fails_before_confidence_filter_can_hide_it(backend_runtime, key, value):
    module, _, captured = backend_runtime
    backend = module.IndoorBackend(device="cpu")
    captured["outputs"][key].flatten()[0] = value
    with pytest.raises(ValueError, match="nonfinite|finite"):
        backend.predict(np.zeros((1008, 1008, 3), dtype=np.uint8), 0.2)
    assert "thresholds" not in captured
    assert backend._adapter._val_conf_thres == 0.2


def test_direct_backend_call_also_rejects_nonfinite_threshold(backend_runtime):
    module, _, captured = backend_runtime
    backend = module.IndoorBackend(device="cpu")
    with pytest.raises(ValueError, match="threshold"):
        backend.predict(np.zeros((1008, 1008, 3), dtype=np.uint8), float("nan"))
    assert "batch" not in captured
