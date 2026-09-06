"""Validation letterboxing and CVAT detector dense-mask geometry."""

from dataclasses import dataclass

import cv2
import numpy as np


INPUT_SIZE = 504


@dataclass(frozen=True)
class LetterboxFrame:
    original_height: int
    original_width: int
    resized_height: int
    resized_width: int
    top: int
    left: int


def letterbox(image: np.ndarray) -> tuple[np.ndarray, LetterboxFrame]:
    """Match LongestMaxSize(504) + centered PadIfNeeded(fill=0) exactly."""
    height, width = image.shape[:2]
    scale = INPUT_SIZE / max(height, width)
    resized_height = max(1, round(height * scale))
    resized_width = max(1, round(width * scale))
    top = (INPUT_SIZE - resized_height) // 2
    left = (INPUT_SIZE - resized_width) // 2
    resized = cv2.resize(
        image, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR
    )
    padded = np.zeros((INPUT_SIZE, INPUT_SIZE, 3), dtype=np.uint8)
    padded[top : top + resized_height, left : left + resized_width] = resized
    return padded, LetterboxFrame(
        height, width, resized_height, resized_width, top, left
    )


def restore_mask(mask: np.ndarray, frame: LetterboxFrame) -> np.ndarray:
    """Remove padding, then restore a decoded boolean mask to the received image."""
    if mask.shape != (INPUT_SIZE, INPUT_SIZE):
        raise ValueError(f"Expected decoded mask shape ({INPUT_SIZE}, {INPUT_SIZE})")
    content = mask[
        frame.top : frame.top + frame.resized_height,
        frame.left : frame.left + frame.resized_width,
    ]
    return cv2.resize(
        content.astype(np.uint8),
        (frame.original_width, frame.original_height),
        interpolation=cv2.INTER_NEAREST,
    ).astype(bool)


def encode_dense_mask(mask: np.ndarray) -> list[int] | None:
    """Return row-major binary pixels followed by the tight inclusive bbox.

    CVAT's detector converter performs RLE encoding itself. Keeping the dense
    crop preserves holes and disconnected components in a single instance.
    """
    ys, xs = np.nonzero(mask)
    if not len(xs):
        return None
    left, right = int(xs.min()), int(xs.max())
    top, bottom = int(ys.min()), int(ys.max())
    pixels = mask[top : bottom + 1, left : right + 1].astype(np.uint8).ravel().tolist()
    return pixels + [left, top, right, bottom]
