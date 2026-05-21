from dataclasses import dataclass

import numpy as np
from PIL import Image

PAD_COLOR = (147, 147, 149)


@dataclass(frozen=True)
class PreparedCrop:
    image: np.ndarray
    valid_region: np.ndarray
    scale: float
    pad_x: int
    pad_y: int
    crop_left: int
    crop_top: int
    crop_width: int
    crop_height: int
    image_width: int
    image_height: int


@dataclass(frozen=True)
class PredictedInstance:
    class_name: str
    score: float
    mask: np.ndarray


def mask_to_rle(mask: np.ndarray) -> list[int]:
    height, width = mask.shape
    pixels = (np.asarray(mask).reshape(-1) != 0).astype(np.uint8)
    if pixels.size == 0:
        return []

    changes = np.flatnonzero(pixels[1:] != pixels[:-1]) + 1
    rle = np.diff(np.concatenate(([0], changes, [pixels.size]))).tolist()
    if pixels[0] == 1:
        rle.insert(0, 0)

    rle.extend([0, 0, width - 1, height - 1])
    return rle


def prepare_crop(image: Image.Image, obj_bbox, target_size: int) -> PreparedCrop:
    left, top = map(int, obj_bbox[0])
    right, bottom = map(int, obj_bbox[1])
    
    # Clamp bbox to image boundaries to prevent out-of-bounds crashes
    left = max(0, min(left, image.width - 1))
    top = max(0, min(top, image.height - 1))
    right = max(0, min(right, image.width - 1))
    bottom = max(0, min(bottom, image.height - 1))
    
    crop = image.crop((left, top, right + 1, bottom + 1)).convert('RGB')
    crop_array = np.asarray(crop, dtype=np.uint8)
    crop_height, crop_width = crop_array.shape[:2]

    scale = min(target_size / crop_width, target_size / crop_height)
    resized_width = max(1, int(round(crop_width * scale)))
    resized_height = max(1, int(round(crop_height * scale)))
    pad_x = (target_size - resized_width) // 2
    pad_y = (target_size - resized_height) // 2

    resized = crop.resize((resized_width, resized_height), resample=Image.BILINEAR)
    canvas = np.full((target_size, target_size, 3), PAD_COLOR, dtype=np.uint8)
    valid_region = np.zeros((target_size, target_size), dtype=np.uint8)

    canvas[pad_y:pad_y + resized_height, pad_x:pad_x + resized_width] = np.asarray(
        resized,
        dtype=np.uint8,
    )
    valid_region[pad_y:pad_y + resized_height, pad_x:pad_x + resized_width] = 1

    return PreparedCrop(
        image=canvas,
        valid_region=valid_region,
        scale=scale,
        pad_x=pad_x,
        pad_y=pad_y,
        crop_left=left,
        crop_top=top,
        crop_width=crop_width,
        crop_height=crop_height,
        image_width=image.width,
        image_height=image.height,
    )


def clip_mask_to_valid_region(mask: np.ndarray, valid_region: np.ndarray) -> np.ndarray:
    return (mask.astype(np.uint8) & valid_region.astype(np.uint8)).astype(np.uint8)


def project_mask_to_image(mask: np.ndarray, prepared: PreparedCrop) -> np.ndarray:
    resized_width = max(1, int(round(prepared.crop_width * prepared.scale)))
    resized_height = max(1, int(round(prepared.crop_height * prepared.scale)))
    unpadded = mask[
        prepared.pad_y:prepared.pad_y + resized_height,
        prepared.pad_x:prepared.pad_x + resized_width,
    ]
    resized = Image.fromarray(unpadded.astype(np.uint8) * 255).resize(
        (prepared.crop_width, prepared.crop_height),
        resample=Image.NEAREST,
    )
    crop_mask = (np.asarray(resized, dtype=np.uint8) > 0).astype(np.uint8)

    full_mask = np.zeros((prepared.image_height, prepared.image_width), dtype=np.uint8)
    full_mask[
        prepared.crop_top:prepared.crop_top + prepared.crop_height,
        prepared.crop_left:prepared.crop_left + prepared.crop_width,
    ] = crop_mask
    return full_mask


def _ios(mask_a: np.ndarray, mask_b: np.ndarray) -> float:
    intersection = np.logical_and(mask_a, mask_b).sum()
    denominator = min(mask_a.sum(), mask_b.sum())
    if denominator == 0:
        return 0.0
    return float(intersection) / float(denominator)


def apply_class_aware_ios_nms(
    instances: list[PredictedInstance],
    threshold: float,
) -> list[PredictedInstance]:
    kept: list[PredictedInstance] = []

    for class_name in sorted({instance.class_name for instance in instances}):
        class_instances = sorted(
            [instance for instance in instances if instance.class_name == class_name],
            key=lambda instance: instance.score,
            reverse=True,
        )
        class_kept: list[PredictedInstance] = []

        for candidate in class_instances:
            if all(
                _ios(candidate.mask.astype(bool), accepted.mask.astype(bool)) <= threshold
                for accepted in class_kept
            ):
                class_kept.append(candidate)

        kept.extend(class_kept)

    return kept
