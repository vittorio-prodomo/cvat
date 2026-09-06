"""Pinned Argus Outdoor v1 inference and native CVAT detector annotations."""

from collections.abc import Mapping
import hashlib
import math
import os
from pathlib import Path
import threading

import numpy as np

from geometry import INPUT_SIZE, encode_dense_mask, letterbox, restore_mask


CLASS_NAMES = (
    "crack", "crack_map", "spall", "exposed_rebar", "efflorescence", "concrete_water_marks"
)
DEFAULT_THRESHOLD = 0.2
CHECKPOINT_SHA256 = "bb57ce7417e8bab675910d5278057ba456389a3683764248f77c5533fb1cbb8d"
DEFAULT_CHECKPOINT_PATH = "/opt/models/epoch=074-map=0.1016.ckpt"


def validate_threshold(value) -> float:
    """Native CVAT batch calls can send null for the default threshold."""
    if value is None:
        return DEFAULT_THRESHOLD
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("threshold must be a finite number between 0 and 1")
    if not 0 <= value <= 1 or not math.isfinite(value):
        raise ValueError("threshold must be a finite number between 0 and 1")
    return float(value)


def load_checkpoint_state_dict(checkpoint_path: Path, torch_module) -> dict:
    """Hash the pinned artifact before restricted deserialization of the same file."""
    with Path(checkpoint_path).open("rb") as stream:
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
        if digest.hexdigest() != CHECKPOINT_SHA256:
            raise ValueError("Argus checkpoint SHA256 does not match the pinned artifact")
        stream.seek(0)
        checkpoint = torch_module.load(stream, map_location="cpu", weights_only=True)
    if not isinstance(checkpoint, Mapping) or not isinstance(checkpoint.get("state_dict"), Mapping):
        raise ValueError("Argus checkpoint must contain a Lightning state_dict")
    state = {
        key.removeprefix("model."): value
        for key, value in checkpoint["state_dict"].items()
        if isinstance(key, str) and key.startswith("model.")
    }
    if not state:
        raise ValueError("Argus checkpoint contains no model.* state_dict entries")
    return state


class ArgusBackend:
    """Run one RF-DETR pass using the pinned training-toolkit adapter."""

    def __init__(self, checkpoint_path=None, device="cuda", logger=None):
        import torch
        from training_toolkit.configs import ModelConfig
        from training_toolkit.models.rfdetr import RFDETRAdapter

        self._torch = torch
        self._device = device
        self._lock = threading.Lock()
        self.checkpoint_path = Path(
            checkpoint_path or os.environ.get("CHECKPOINT_PATH", DEFAULT_CHECKPOINT_PATH)
        )
        state = load_checkpoint_state_dict(self.checkpoint_path, torch)
        self._adapter = RFDETRAdapter()
        self._model = self._adapter.create_model(ModelConfig(
            name="rf-detr-seg-large",
            pretrained="none",
            num_classes=len(CLASS_NAMES),
            extra={
                "mask_downsample_ratio": 2,
                # Annotation policy: decode at full 504, not native low-res eval.
                "val_mask_downsample": 1,
                "val_conf_thres": DEFAULT_THRESHOLD,
                "val_nms_iou": 0.7,
                "val_max_det": 100,
            },
        ))
        self._model.load_state_dict(state, strict=True)
        self._model = self._model.to(device, dtype=torch.float32).eval()
        if logger is not None:
            logger.info(f"Argus Outdoor v1 ready: checkpoint_sha256={CHECKPOINT_SHA256}")

    def predict(self, image: np.ndarray, threshold: float) -> dict:
        threshold = validate_threshold(threshold)
        torch = self._torch
        # The adapter stores its confidence threshold and mask decoding policy.
        # Keep mutation, inference, and CPU transfer within one serialized call.
        with self._lock, torch.inference_mode():
            previous_threshold = self._adapter._val_conf_thres
            self._adapter._val_conf_thres = threshold
            try:
                images = torch.from_numpy(image.transpose(2, 0, 1).copy())
                images = images.to(self._device, dtype=torch.float32).unsqueeze(0) / 255.0
                # format_batch owns ImageNet normalization and the all-false
                # NestedTensor padding mask, including the black border.
                formatted = self._adapter.format_batch({"images": images, "targets": []})
                outputs = self._model(**formatted["inputs"])
                for key in ("pred_logits", "pred_masks"):
                    if not torch.isfinite(outputs[key]).all().item():
                        raise ValueError(f"Argus returned nonfinite {key}")
                predictions = self._adapter.postprocess_for_inference(
                    outputs, image_sizes=(INPUT_SIZE, INPUT_SIZE)
                )
                if len(predictions) != 1:
                    raise ValueError("Expected one Argus prediction batch")
                return {
                    key: predictions[0][key].detach().cpu().numpy()
                    for key in ("masks", "labels", "scores")
                }
            finally:
                self._adapter._val_conf_thres = previous_threshold


class ModelHandler:
    def __init__(self, logger=None, backend=None):
        self.backend = backend if backend is not None else ArgusBackend(logger=logger)

    def handle(self, *, image, threshold=None) -> list[dict]:
        threshold = validate_threshold(threshold)
        padded, frame = letterbox(np.asarray(image.convert("RGB")))
        prediction = self.backend.predict(padded, threshold)
        masks, labels, scores = (np.asarray(prediction[key]) for key in ("masks", "labels", "scores"))
        if scores.ndim != 1 or labels.shape != scores.shape:
            raise ValueError("Inconsistent Argus prediction dimensions")
        if masks.shape != (len(scores), INPUT_SIZE, INPUT_SIZE):
            raise ValueError(f"Expected Argus masks with shape (N, {INPUT_SIZE}, {INPUT_SIZE})")
        if masks.dtype != np.bool_:
            raise ValueError("Expected decoded boolean Argus masks")
        if not np.issubdtype(labels.dtype, np.integer) or np.any((labels < 0) | (labels >= len(CLASS_NAMES))):
            raise ValueError("Argus returned an invalid class ID")
        if not np.issubdtype(scores.dtype, np.number) or not np.all(np.isfinite(scores)) or np.any((scores < 0) | (scores > 1)):
            raise ValueError("Argus returned an invalid confidence score")
        annotations = []
        for mask, label, score in zip(masks, labels, scores):
            encoded = encode_dense_mask(restore_mask(mask, frame))
            if encoded is not None:
                annotations.append({
                    "label": CLASS_NAMES[int(label)],
                    "type": "mask",
                    "confidence": float(score),
                    "attributes": [],
                    "mask": encoded,
                })
        return annotations
