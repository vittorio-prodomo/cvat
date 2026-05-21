import numpy as np
import pytest
from PIL import Image

from model_handler import ModelHandler


class DummyBackend:
    """Mock RF-DETR backend that returns predicted instances."""
    
    def __init__(self, conf_threshold=0.2):
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


def test_handle_uses_crop_preprocessing_flow(monkeypatch):
    """Verify crop preprocessing is applied before backend prediction."""
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')
    
    # Track what image size the backend receives
    received_shape = []
    
    class InspectorBackend:
        def __init__(self, conf_threshold=0.2):
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
