import numpy as np
import pytest
from PIL import Image
from types import SimpleNamespace

from model_handler import ModelHandler


class DummyBackend:
    """Mock RF-DETR backend that returns predicted instances."""
    
    def __init__(self, conf_threshold=0.2, **kwargs):
        self.conf_threshold = conf_threshold
    
    def predict(self, image):
        """Return mock predictions matching PredictedInstance format."""
        from rfdetr_backend import PredictedInstance
        
        # Return two mock predictions: one mapped, one unmapped
        h, w = image.shape[:2]
        mask1 = np.ones((h, w), dtype=np.uint8)
        mask2 = np.ones((h, w), dtype=np.uint8)
        
        return [
            PredictedInstance(
                class_name='(A13) danno_urto',
                score=0.9,
                mask=mask1,
            ),
            PredictedInstance(
                class_name='(C1) difetti_esecuzione',
                score=0.7,
                mask=mask2,
            ),
        ]


def test_model_handler_requires_a_bounding_box(monkeypatch):
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', DummyBackend)
    
    handler = ModelHandler()
    image = Image.new('RGB', (40, 30), 'white')

    with pytest.raises(ValueError, match='bounding box'):
        handler.handle(image=image, obj_bbox=None, mapping={})


def test_handle_returns_mapped_shapes_and_skips_unmapped_labels(monkeypatch):
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', DummyBackend)
    
    handler = ModelHandler()
    image = Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8))
    shapes = handler.handle(
        image=image,
        obj_bbox=[[0, 0], [39, 29]],
        mapping={
            '(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}},
        },
    )

    # Should only return the mapped class
    assert len(shapes) == 1
    assert shapes[0]['label'] == 'danno_urto_a13'
    assert shapes[0]['type'] == 'mask'
    assert shapes[0]['points'][-4:] == [0, 0, 39, 29]
    assert shapes[0]['attributes'] == [{'spec_id': 0, 'value': '0.900000'}]


def test_handle_logs_pipeline_summary(monkeypatch):
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', DummyBackend)

    messages = []
    monkeypatch.setattr('model_handler.LOGGER', SimpleNamespace(info=lambda message: messages.append(message)))

    handler = ModelHandler()
    image = Image.fromarray(np.full((30, 40, 3), 255, dtype=np.uint8))

    handler.handle(
        image=image,
        obj_bbox=[[0, 0], [39, 29]],
        mapping={'(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}}},
    )

    assert any('pipeline summary' in message for message in messages)
    assert any('raw_predictions=2' in message for message in messages)
    assert any('clipped_predictions=2' in message for message in messages)
    assert any('kept_predictions=2' in message for message in messages)
    assert any('unmapped_predictions=1' in message for message in messages)
    assert any('empty_projected_masks=0' in message for message in messages)
    assert any('returned_shapes=1' in message for message in messages)


def test_handle_uses_crop_preprocessing_flow(monkeypatch):
    """Verify crop preprocessing is applied before backend prediction."""
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    
    # Track what image size the backend receives
    received_shape = []
    
    class InspectorBackend:
        def __init__(self, conf_threshold=0.2, **kwargs):
            pass
        
        def predict(self, image):
            received_shape.append(image.shape)
            return []
    
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', InspectorBackend)
    
    handler = ModelHandler()
    image = Image.fromarray(np.full((100, 200, 3), 255, dtype=np.uint8))
    handler.handle(
        image=image,
        obj_bbox=[[10, 10], [110, 60]],
        mapping={},
    )
    
    # Should have received a 504x504 preprocessed crop
    assert received_shape[0] == (504, 504, 3)


def test_model_handler_passes_manifest_configured_checkpoint_paths_to_backend(monkeypatch):
    """ModelHandler must pass CHECKPOINT_DIR and CONFIG_PATH env vars into RFDETRShapeBackend.
    
    This test verifies the spec-compliance gap fix: function-gpu.yaml advertises
    CHECKPOINT_DIR and CONFIG_PATH pointing to /opt/bdd/..., but model_handler.py
    was not wiring them through to the backend constructor.
    """
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.3')
    monkeypatch.setenv('CHECKPOINT_DIR', '/opt/bdd/runs/echo-combined-v5/shape_round1/checkpoints')
    monkeypatch.setenv('CONFIG_PATH', '/opt/bdd/runs/echo-combined-v5/shape_round1/config.yaml')
    
    received_kwargs = {}
    
    class InspectorBackend:
        def __init__(self, **kwargs):
            received_kwargs.update(kwargs)
        
        def predict(self, image):
            return []
    
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', InspectorBackend)
    
    handler = ModelHandler()
    
    # Verify the backend received the manifest-configured paths from env
    from pathlib import Path
    assert received_kwargs['checkpoint_dir'] == Path('/opt/bdd/runs/echo-combined-v5/shape_round1/checkpoints')
    assert received_kwargs['config_path'] == Path('/opt/bdd/runs/echo-combined-v5/shape_round1/config.yaml')
    assert received_kwargs['conf_threshold'] == 0.3


def test_handle_clips_out_of_bounds_bbox_instead_of_crashing(monkeypatch):
    """Regression test: partially out-of-frame bbox should be clipped, not crash.
    
    Reviewer evidence: with a 10x10 image and obj_bbox=[[-2,-2],[5,5]], 
    ModelHandler.handle() crashes in project_mask_to_image() with a broadcasting 
    ValueError. This test verifies that out-of-bounds bbox is clipped to image 
    boundaries and produces valid shapes without crashing.
    
    STRENGTHENED: Now validates that the projected mask geometry is correct,
    not just the RLE trailer.
    """
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    
    # Backend returns a full mask over the crop region
    class FullMaskBackend:
        def __init__(self, conf_threshold=0.2, **kwargs):
            pass
        
        def predict(self, image):
            from rfdetr_backend import PredictedInstance
            h, w = image.shape[:2]
            mask = np.ones((h, w), dtype=np.uint8)
            return [
                PredictedInstance(
                    class_name='(A13) danno_urto',
                    score=0.9,
                    mask=mask,
                ),
            ]
    
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', FullMaskBackend)
    
    handler = ModelHandler()
    # 10x10 image with bbox partially out of frame
    image = Image.fromarray(np.full((10, 10, 3), 255, dtype=np.uint8))
    
    # This should not crash - bbox should be clipped to [0,0] to [5,5]
    shapes = handler.handle(
        image=image,
        obj_bbox=[[-2, -2], [5, 5]],
        mapping={
            '(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}},
        },
    )
    
    # Should produce valid shapes after clipping
    assert len(shapes) == 1
    assert shapes[0]['label'] == 'danno_urto_a13'
    assert shapes[0]['type'] == 'mask'
    
    # Verify the projected mask covers the clipped crop region [0,0] to [5,5]
    # The RLE encodes a mask - decode it to verify coverage
    points = shapes[0]['points']
    rle = points[:-4]  # Exclude trailer
    width, height = points[-2] + 1, points[-1] + 1
    assert (width, height) == (10, 10)
    
    # Decode RLE to verify mask covers the clipped region
    decoded = np.zeros(width * height, dtype=np.uint8)
    pos = 0
    for i, count in enumerate(rle):
        if i % 2 == 1:  # Odd indices are 1s
            decoded[pos:pos + count] = 1
        pos += count
    decoded = decoded.reshape((height, width))
    
    # The mask should cover the clipped crop [0,0] to [5,5]
    assert decoded[0:6, 0:6].sum() > 0, "Mask should cover clipped crop region"
    # And nothing outside the crop should be covered
    assert decoded[6:10, :].sum() == 0, "Mask should not extend beyond clipped crop"
    assert decoded[:, 6:10].sum() == 0, "Mask should not extend beyond clipped crop"


def test_handle_normalizes_inverted_bbox_instead_of_crashing(monkeypatch):
    """Regression test: inverted bbox corners should be normalized, not crash.
    
    Issue: prepare_crop() clamps bbox coordinates but never normalizes corner order.
    Example failure: prepare_crop(img, [[8, 8], [3, 3]], 504) crashes because
    PIL receives an inverted crop box (left > right, top > bottom).
    
    This test verifies that inverted bbox corners are normalized to 
    [min_x, min_y], [max_x, max_y] before cropping.
    """
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    
    # Backend returns a full mask
    class FullMaskBackend:
        def __init__(self, conf_threshold=0.2, **kwargs):
            pass
        
        def predict(self, image):
            from rfdetr_backend import PredictedInstance
            h, w = image.shape[:2]
            mask = np.ones((h, w), dtype=np.uint8)
            return [
                PredictedInstance(
                    class_name='(A13) danno_urto',
                    score=0.9,
                    mask=mask,
                ),
            ]
    
    monkeypatch.setattr('model_handler.RFDETRShapeBackend', FullMaskBackend)
    
    handler = ModelHandler()
    # 20x20 image with inverted bbox: top-left at [8,8], bottom-right at [3,3]
    image = Image.fromarray(np.full((20, 20, 3), 255, dtype=np.uint8))
    
    # This should not crash - bbox should be normalized to [[3,3], [8,8]]
    shapes = handler.handle(
        image=image,
        obj_bbox=[[8, 8], [3, 3]],  # Inverted!
        mapping={
            '(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}},
        },
    )
    
    # Should produce valid shapes after normalization
    assert len(shapes) == 1
    assert shapes[0]['label'] == 'danno_urto_a13'
    assert shapes[0]['type'] == 'mask'
    
    # Verify the mask covers the normalized region [3,3] to [8,8]
    points = shapes[0]['points']
    rle = points[:-4]
    width, height = points[-2] + 1, points[-1] + 1
    assert (width, height) == (20, 20)
    
    # Decode RLE
    decoded = np.zeros(width * height, dtype=np.uint8)
    pos = 0
    for i, count in enumerate(rle):
        if i % 2 == 1:
            decoded[pos:pos + count] = 1
        pos += count
    decoded = decoded.reshape((height, width))
    
    # Mask should cover the normalized crop [3,3] to [8,8]
    assert decoded[3:9, 3:9].sum() > 0, "Mask should cover normalized crop region"
