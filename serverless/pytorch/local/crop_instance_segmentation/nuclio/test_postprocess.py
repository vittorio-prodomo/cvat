import numpy as np
from PIL import Image

from postprocess import (
    PAD_COLOR,
    PredictedInstance,
    apply_class_aware_ios_nms,
    clip_mask_to_valid_region,
    mask_to_rle,
    prepare_crop,
    project_mask_to_image,
)


def test_prepare_crop_letterboxes_with_fixed_pad_color():
    image = Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8))

    prepared = prepare_crop(
        image=image,
        obj_bbox=[[5, 5], [35, 25]],
        target_size=64,
    )

    assert prepared.image.shape == (64, 64, 3)
    assert tuple(prepared.image[0, 0].tolist()) == PAD_COLOR
    assert prepared.valid_region.shape == (64, 64)
    assert prepared.valid_region.any()


def test_clip_mask_to_valid_region_drops_padding_only_prediction():
    image = Image.fromarray(np.full((20, 40, 3), 255, dtype=np.uint8))
    prepared = prepare_crop(image=image, obj_bbox=[[0, 0], [39, 19]], target_size=64)

    padding_only = np.zeros((64, 64), dtype=np.uint8)
    padding_only[:8, :] = 1

    clipped = clip_mask_to_valid_region(padding_only, prepared.valid_region)
    assert not clipped.any()


def test_clip_mask_to_valid_region_keeps_non_padding_pixels():
    image = Image.fromarray(np.full((20, 40, 3), 255, dtype=np.uint8))
    prepared = prepare_crop(image=image, obj_bbox=[[0, 0], [39, 19]], target_size=64)

    crossing = np.zeros((64, 64), dtype=np.uint8)
    crossing[6:18, 10:30] = 1

    clipped = clip_mask_to_valid_region(crossing, prepared.valid_region)
    assert clipped.any()
    assert clipped.sum() < crossing.sum()


def test_apply_class_aware_ios_nms_keeps_different_classes():
    instances = [
        PredictedInstance(
            class_name='mild_crack',
            score=0.9,
            mask=np.array([[1, 1], [0, 0]], dtype=np.uint8),
        ),
        PredictedInstance(
            class_name='mild_crack',
            score=0.8,
            mask=np.array([[1, 1], [0, 0]], dtype=np.uint8),
        ),
        PredictedInstance(
            class_name='spall',
            score=0.7,
            mask=np.array([[1, 1], [0, 0]], dtype=np.uint8),
        ),
    ]

    kept = apply_class_aware_ios_nms(instances, threshold=0.8)
    assert [instance.class_name for instance in kept] == ['mild_crack', 'spall']


def test_apply_class_aware_ios_nms_keeps_disjoint_masks_at_zero_threshold():
    instances = [
        PredictedInstance(
            class_name='mild_crack',
            score=0.9,
            mask=np.array([[1, 0], [0, 0]], dtype=np.uint8),
        ),
        PredictedInstance(
            class_name='mild_crack',
            score=0.8,
            mask=np.array([[0, 0], [0, 1]], dtype=np.uint8),
        ),
    ]

    kept = apply_class_aware_ios_nms(instances, threshold=0.0)
    assert len(kept) == 2


def test_project_mask_to_image_restores_crop_position_in_full_image():
    image = Image.fromarray(np.full((20, 40, 3), 255, dtype=np.uint8))
    prepared = prepare_crop(image=image, obj_bbox=[[10, 5], [29, 14]], target_size=20)

    mask = np.zeros((20, 20), dtype=np.uint8)
    mask[prepared.pad_y:prepared.pad_y + 10, prepared.pad_x:prepared.pad_x + 20] = 1

    projected = project_mask_to_image(mask, prepared)

    assert projected.shape == (20, 40)
    assert projected[5:15, 10:30].all()
    assert projected.sum() == 200


def test_mask_to_rle_uses_cvat_mask_encoding():
    mask = np.array([[0, 1], [1, 0]], dtype=np.uint8)
    rle = mask_to_rle(mask)
    assert rle[-4:] == [0, 0, 1, 1]
