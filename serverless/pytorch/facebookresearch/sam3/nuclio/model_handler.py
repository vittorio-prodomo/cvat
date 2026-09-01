import hashlib
import os
from pathlib import Path

import numpy as np


EXPECTED_CHECKPOINT_SIZE = 3_450_062_241
EXPECTED_CHECKPOINT_SHA256 = (
    '9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e'
)


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def verify_checkpoint(path: Path) -> None:
    if path.is_symlink():
        raise RuntimeError(f'SAM3 checkpoint is not a regular file: {path}')
    if not path.exists():
        raise RuntimeError(f'SAM3 checkpoint file does not exist: {path}')
    if not path.is_file():
        raise RuntimeError(f'SAM3 checkpoint is not a regular file: {path}')

    actual_size = path.stat().st_size
    if actual_size != EXPECTED_CHECKPOINT_SIZE:
        raise RuntimeError(
            f'SAM3 checkpoint size mismatch: expected {EXPECTED_CHECKPOINT_SIZE} bytes, '
            f'got {actual_size} bytes at {path}'
        )

    actual_sha256 = sha256_file(path)
    if actual_sha256 != EXPECTED_CHECKPOINT_SHA256:
        raise RuntimeError(
            f'SAM3 checkpoint SHA-256 mismatch: expected {EXPECTED_CHECKPOINT_SHA256}, '
            f'got {actual_sha256} at {path}'
        )


def checkpoint_from_environment() -> str:
    configured = os.environ.get('SAM3_CHECKPOINT_PATH')
    if not configured:
        raise RuntimeError(
            'SAM3_CHECKPOINT_PATH is required; mount the verified sam3.pt read-only'
        )

    checkpoint = Path(configured)
    verify_checkpoint(checkpoint)

    return str(checkpoint)


class ModelHandler:
    def __init__(self):
        checkpoint_path = checkpoint_from_environment()

        import torch
        from sam3.model_builder import build_sam3_image_model

        if not torch.cuda.is_available():
            raise RuntimeError('SAM3 interactor requires an NVIDIA GPU with CUDA support')

        model = build_sam3_image_model(
            device='cuda',
            checkpoint_path=checkpoint_path,
            load_from_HF=False,
            enable_inst_interactivity=True,
        )
        predictor = model.inst_interactive_predictor
        if predictor is None:
            raise RuntimeError('SAM3 image model did not expose an interactive predictor')

        if getattr(predictor.model, 'backbone', None) is None:
            predictor.model.backbone = model.backbone

        self.predictor = predictor

    def handle(self, image, *, pos_points, neg_points, obj_bbox):
        if not pos_points and not neg_points and not obj_bbox:
            raise ValueError('SAM3 interactor requires at least one point or a bounding box')

        self.predictor.set_image(np.array(image))

        point_coords = None
        point_labels = None
        if pos_points or neg_points:
            point_coords = np.array([*pos_points, *neg_points], dtype=np.float32)
            point_labels = np.array(
                [1] * len(pos_points) + [0] * len(neg_points),
                dtype=np.int32,
            )

        box = None
        if obj_bbox:
            box = np.array(
                [obj_bbox[0][0], obj_bbox[0][1], obj_bbox[1][0], obj_bbox[1][1]],
                dtype=np.float32,
            )

        masks, scores, _ = self.predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            multimask_output=True,
            return_logits=False,
        )

        best_index = int(np.argmax(scores))
        return masks[best_index].astype(np.uint8).tolist()
