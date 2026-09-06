import cv2
import numpy as np
import pytest


@pytest.mark.parametrize("shape,resized,pad", [
    ((11, 17), (326, 504), (89, 0)),
    ((17, 11), (504, 326), (0, 89)),
    ((10, 17), (296, 504), (104, 0)),
    ((7, 16), (220, 504), (142, 0)),
    ((13, 16), (410, 504), (47, 0)),
    ((1, 2000), (1, 504), (251, 0)),
    ((2000, 1), (504, 1), (0, 251)),
    ((504, 504), (504, 504), (0, 0)),
])
def test_letterbox_uses_validation_resize_black_padding_and_rounding(
    load_indoor, shape, resized, pad
):
    geometry = load_indoor("geometry")
    rng = np.random.default_rng(17)
    image = rng.integers(1, 256, (*shape, 3), dtype=np.uint8)
    result, frame = geometry.letterbox(image)
    height, width = resized
    top, left = pad
    expected = np.zeros((504, 504, 3), dtype=np.uint8)
    expected[top : top + height, left : left + width] = cv2.resize(
        image, (width, height), interpolation=cv2.INTER_LINEAR
    )
    np.testing.assert_array_equal(result, expected)
    assert (frame.original_height, frame.original_width) == shape
    assert (frame.resized_height, frame.resized_width) == resized
    assert (frame.top, frame.left) == pad


@pytest.mark.parametrize("shape", [(503, 504), (504, 503), (51, 83), (83, 51)])
def test_mask_restoration_removes_odd_padding_and_keeps_received_frame_edges(load_indoor, shape):
    geometry = load_indoor("geometry")
    _, frame = geometry.letterbox(np.zeros((*shape, 3), dtype=np.uint8))
    mask = np.zeros((504, 504), dtype=bool)
    mask[frame.top : frame.top + frame.resized_height,
         frame.left : frame.left + frame.resized_width] = True
    restored = geometry.restore_mask(mask, frame)
    assert restored.shape == shape
    assert restored.dtype == np.bool_
    assert restored.all()
    # Pixels exclusively in padding must never become received-image pixels.
    np.testing.assert_array_equal(geometry.restore_mask(~mask, frame), False)


def test_dense_mask_keeps_holes_disconnected_components_and_inclusive_bounds(load_indoor):
    geometry = load_indoor("geometry")
    mask = np.zeros((9, 13), dtype=bool)
    mask[2:7, 3:8] = True
    mask[3:6, 4:7] = False
    mask[8, 12] = True
    encoded = geometry.encode_dense_mask(mask)
    assert encoded[-4:] == [3, 2, 12, 8]
    left, top, right, bottom = encoded[-4:]
    assert len(encoded) == (right - left + 1) * (bottom - top + 1) + 4
    decoded = np.zeros_like(mask)
    decoded[top : bottom + 1, left : right + 1] = np.asarray(
        encoded[:-4], dtype=bool
    ).reshape(bottom - top + 1, right - left + 1)
    np.testing.assert_array_equal(decoded, mask)
    assert set(encoded[:-4]) == {0, 1}


def test_single_edge_pixel_is_valid_dense_mask_and_empty_mask_has_no_shape(load_indoor):
    geometry = load_indoor("geometry")
    mask = np.zeros((5, 7), dtype=bool)
    assert geometry.encode_dense_mask(mask) is None
    mask[4, 6] = True
    assert geometry.encode_dense_mask(mask) == [1, 6, 4, 6, 4]


def test_mask_restoration_preserves_topology_at_native_size(load_indoor):
    geometry = load_indoor("geometry")
    _, frame = geometry.letterbox(np.zeros((503, 504, 3), dtype=np.uint8))
    source = np.zeros((503, 504), dtype=bool)
    source[20:100, 30:200] = True
    source[40:80, 50:150] = False
    source[-1, -1] = True
    padded = np.pad(source, ((0, 1), (0, 0)))
    np.testing.assert_array_equal(geometry.restore_mask(padded, frame), source)


@pytest.mark.parametrize("shape", [(252, 252), (1, 504, 504), (504, 503)])
def test_restoration_rejects_wrong_model_mask_resolution(load_indoor, shape):
    geometry = load_indoor("geometry")
    _, frame = geometry.letterbox(np.zeros((7, 11, 3), dtype=np.uint8))
    with pytest.raises(ValueError, match="504"):
        geometry.restore_mask(np.zeros(shape, dtype=bool), frame)


def test_preprocessing_matches_real_albumentations_validation_transforms(load_indoor, monkeypatch):
    monkeypatch.setenv("NO_ALBUMENTATIONS_UPDATE", "1")
    albumentations = pytest.importorskip("albumentations")
    geometry = load_indoor("geometry")
    transform = albumentations.Compose([
        albumentations.LongestMaxSize(max_size=504),
        albumentations.PadIfNeeded(min_height=504, min_width=504, border_mode=0, fill=0, fill_mask=0),
    ])
    rng = np.random.default_rng(42)
    for shape in ((11, 17), (17, 11), (503, 504), (504, 503), (1, 2000), (2000, 1), (701, 1033)):
        image = rng.integers(0, 256, (*shape, 3), dtype=np.uint8)
        actual, _ = geometry.letterbox(image)
        expected = transform(image=image)["image"]
        np.testing.assert_array_equal(actual, expected)
