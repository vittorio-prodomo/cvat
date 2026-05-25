from pathlib import Path
import sys
import os

import numpy as np
import pytest


MODULE_DIR = Path(__file__).parent
LOCAL_MODULE_NAMES = ('postprocess', 'shape_backend', 'stain_backend', 'model_handler')


@pytest.fixture(autouse=True)
def local_modules():
    saved_modules = {
        module_name: sys.modules.get(module_name)
        for module_name in LOCAL_MODULE_NAMES
    }
    sys.path.insert(0, str(MODULE_DIR))
    for module_name in LOCAL_MODULE_NAMES:
        sys.modules.pop(module_name, None)
    try:
        yield
    finally:
        sys.path.pop(0)
        for module_name, saved_module in saved_modules.items():
            if saved_module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = saved_module


@pytest.fixture(autouse=True)
def mock_env(monkeypatch):
    """Set required environment variables for ModelHandler."""
    monkeypatch.setenv('SHAPE_CHECKPOINT_DIR', '/fake/shape/checkpoints')
    monkeypatch.setenv('SHAPE_CONFIG_PATH', '/fake/shape/config.yaml')
    monkeypatch.setenv('STAIN_CHECKPOINT_DIR', '/fake/stain/checkpoints')
    monkeypatch.setenv('STAIN_CONFIG_PATH', '/fake/stain/config.yaml')
    monkeypatch.setenv('MODEL_INPUT_SIZE', '504')
    monkeypatch.setenv('MODEL_CONF_THRESHOLD', '0.2')


@pytest.fixture
def mock_image():
    """Create a simple RGB image for testing."""
    return np.zeros((100, 100, 3), dtype=np.uint8)


@pytest.fixture
def mock_bbox():
    """Create a valid bounding box."""
    return [[10, 10], [50, 50]]


@pytest.fixture
def mock_mapping():
    """Create a mapping that maps both shape and stain classes to same label."""
    return {
        "(A13) danno_urto": {"name": "bridge_issue"},
        "(C5) infiltraz_cls": {"name": "bridge_issue"},
        "(C1) difetti_esecuzione": {"name": "execution_defect"},
    }


class ShapeBackend:
    """Test double for RFDETRShapeBackend."""
    
    def __init__(self, checkpoint_dir, config_path, conf_threshold):
        self.checkpoint_dir = checkpoint_dir
        self.config_path = config_path
        self.conf_threshold = conf_threshold
        self._predictions = []
    
    def set_predictions(self, predictions):
        """Set predictions to be returned by predict()."""
        self._predictions = predictions
    
    def predict(self, image, conf_threshold=None):
        """Return pre-configured predictions."""
        return self._predictions


class StainBackend:
    """Test double for RFDETRStainBackend."""
    
    def __init__(self, checkpoint_dir, config_path, conf_threshold):
        self.checkpoint_dir = checkpoint_dir
        self.config_path = config_path
        self.conf_threshold = conf_threshold
        self._predictions = []
    
    def set_predictions(self, predictions):
        """Set predictions to be returned by predict()."""
        self._predictions = predictions
    
    def predict(self, image, conf_threshold=None):
        """Return pre-configured predictions."""
        return self._predictions


class FailingBackend:
    """Test double that raises an exception during predict."""
    
    def __init__(self, checkpoint_dir, config_path, conf_threshold):
        pass
    
    def predict(self, image, conf_threshold=None):
        raise RuntimeError("Backend prediction failed")


@pytest.fixture(autouse=True)
def mock_backends(monkeypatch):
    """Replace real backends with test doubles."""
    import importlib
    
    # Import shape_backend and stain_backend modules
    shape_backend = importlib.import_module('shape_backend')
    stain_backend = importlib.import_module('stain_backend')
    
    # Store original classes
    original_shape = shape_backend.RFDETRShapeBackend
    original_stain = stain_backend.RFDETRStainBackend
    
    # Replace with test doubles
    monkeypatch.setattr(shape_backend, 'RFDETRShapeBackend', ShapeBackend)
    monkeypatch.setattr(stain_backend, 'RFDETRStainBackend', StainBackend)
    
    yield
    
    # Restore originals (cleanup handled by monkeypatch)


def test_model_handler_requires_bbox(mock_image):
    """Test that ModelHandler raises error when bounding box is None or empty."""
    import importlib
    from PIL import Image
    
    model_handler = importlib.import_module('model_handler')
    
    handler = model_handler.ModelHandler()
    pil_image = Image.fromarray(mock_image)
    
    # Test None bbox
    with pytest.raises(ValueError, match="Crop interactor requires a bounding box"):
        handler.handle(pil_image, None, {})
    
    # Test empty bbox
    with pytest.raises(ValueError, match="Crop interactor requires a bounding box"):
        handler.handle(pil_image, [], {})


def test_handle_merges_overlap_after_mapping(mock_image, mock_bbox, mock_mapping):
    """Test that overlapping masks with same mapped label are merged after mapping resolution."""
    import importlib
    from PIL import Image
    
    postprocess = importlib.import_module('postprocess')
    model_handler = importlib.import_module('model_handler')
    
    PredictedInstance = postprocess.PredictedInstance
    
    # Create overlapping masks in prepared crop space (504x504)
    # Place them in the center where the valid region will be
    shape_mask = np.zeros((504, 504), dtype=np.uint8)
    shape_mask[200:300, 200:300] = 1  # 100x100 centered square
    
    stain_mask = np.zeros((504, 504), dtype=np.uint8)
    stain_mask[220:300, 220:300] = 1  # 80x80 overlapping square
    
    # Shape backend returns one mask for class (A13) danno_urto
    shape_predictions = [
        PredictedInstance(
            class_name="(A13) danno_urto",
            score=0.80,
            mask=shape_mask,
        )
    ]
    
    # Stain backend returns one overlapping mask for class (C5) infiltraz_cls
    stain_predictions = [
        PredictedInstance(
            class_name="(C5) infiltraz_cls",
            score=0.95,
            mask=stain_mask,
        )
    ]
    
    handler = model_handler.ModelHandler()
    
    # Inject predictions into backends
    handler.shape_backend.set_predictions(shape_predictions)
    handler.stain_backend.set_predictions(stain_predictions)
    
    pil_image = Image.fromarray(mock_image)
    shapes = handler.handle(pil_image, mock_bbox, mock_mapping)
    
    # Expect one returned shape with bridge_issue label
    assert len(shapes) == 1
    assert shapes[0]['label'] == 'bridge_issue'
    assert shapes[0]['type'] == 'mask'
    
    # Expect score to be the maximum (0.95)
    assert len(shapes[0]['attributes']) == 1
    assert shapes[0]['attributes'][0]['spec_id'] == 0
    assert shapes[0]['attributes'][0]['value'] == '0.950000'


def test_handle_keeps_overlap_separate_for_different_labels(mock_image, mock_bbox):
    """Test that overlapping masks with different mapped labels are kept separate."""
    import importlib
    from PIL import Image
    
    postprocess = importlib.import_module('postprocess')
    model_handler = importlib.import_module('model_handler')
    
    PredictedInstance = postprocess.PredictedInstance
    
    # Create overlapping masks in prepared crop space (504x504)
    shape_mask = np.zeros((504, 504), dtype=np.uint8)
    shape_mask[200:300, 200:300] = 1
    
    stain_mask = np.zeros((504, 504), dtype=np.uint8)
    stain_mask[220:300, 220:300] = 1
    
    # Mapping that resolves to different labels
    mapping = {
        "(A13) danno_urto": {"name": "shape_damage"},
        "(C5) infiltraz_cls": {"name": "stain_infiltration"},
    }
    
    shape_predictions = [
        PredictedInstance(
            class_name="(A13) danno_urto",
            score=0.80,
            mask=shape_mask,
        )
    ]
    
    stain_predictions = [
        PredictedInstance(
            class_name="(C5) infiltraz_cls",
            score=0.95,
            mask=stain_mask,
        )
    ]
    
    handler = model_handler.ModelHandler()
    handler.shape_backend.set_predictions(shape_predictions)
    handler.stain_backend.set_predictions(stain_predictions)
    
    pil_image = Image.fromarray(mock_image)
    shapes = handler.handle(pil_image, mock_bbox, mapping)
    
    # Expect two separate shapes with different labels
    assert len(shapes) == 2
    labels = {shape['label'] for shape in shapes}
    assert labels == {'shape_damage', 'stain_infiltration'}


def test_handle_fails_when_backend_errors(mock_image, mock_bbox, mock_mapping, monkeypatch):
    """Test that ModelHandler fails when one backend raises an error."""
    import importlib
    from PIL import Image
    
    shape_backend = importlib.import_module('shape_backend')
    model_handler = importlib.import_module('model_handler')
    
    # Replace shape backend with failing backend
    monkeypatch.setattr(shape_backend, 'RFDETRShapeBackend', FailingBackend)
    
    # Need to reimport model_handler after patching the backend
    # to ensure it picks up the patched backend class
    importlib.reload(model_handler)
    
    handler = model_handler.ModelHandler()
    pil_image = Image.fromarray(mock_image)
    
    with pytest.raises(RuntimeError, match="Backend prediction failed"):
        handler.handle(pil_image, mock_bbox, mock_mapping)


def test_merge_by_task_label_transitive_overlap():
    """Test that transitive overlap grouping works correctly.
    
    If A overlaps B, B overlaps C, and A does not overlap C directly,
    all three should merge into one connected component.
    """
    import importlib
    from PIL import Image
    
    postprocess = importlib.import_module('postprocess')
    model_handler = importlib.import_module('model_handler')
    
    PredictedInstance = postprocess.PredictedInstance
    
    # Create three masks where A overlaps B, B overlaps C, but A and C don't overlap
    # Mask A: left region (100x100 at x=100-200)
    mask_a = np.zeros((504, 504), dtype=np.uint8)
    mask_a[200:300, 100:200] = 1
    
    # Mask B: center region (100x100 at x=180-280) - overlaps both A and C
    mask_b = np.zeros((504, 504), dtype=np.uint8)
    mask_b[200:300, 180:280] = 1
    
    # Mask C: right region (100x100 at x=260-360) - does not overlap A directly
    mask_c = np.zeros((504, 504), dtype=np.uint8)
    mask_c[200:300, 260:360] = 1
    
    # All predictions have the same mapped label
    shape_predictions = [
        PredictedInstance(
            class_name="(A13) danno_urto",
            score=0.85,
            mask=mask_a,
        ),
        PredictedInstance(
            class_name="(A13) danno_urto",
            score=0.90,
            mask=mask_b,
        ),
        PredictedInstance(
            class_name="(A13) danno_urto",
            score=0.75,
            mask=mask_c,
        )
    ]
    
    mapping = {"(A13) danno_urto": {"name": "bridge_issue"}}
    
    handler = model_handler.ModelHandler()
    handler.shape_backend.set_predictions(shape_predictions)
    handler.stain_backend.set_predictions([])
    
    mock_image = np.zeros((100, 100, 3), dtype=np.uint8)
    mock_bbox = [[10, 10], [50, 50]]
    pil_image = Image.fromarray(mock_image)
    
    shapes = handler.handle(pil_image, mock_bbox, mapping)
    
    # Expect one returned shape with all three masks merged
    assert len(shapes) == 1, f"Expected 1 shape (transitively merged), got {len(shapes)}"
    assert shapes[0]['label'] == 'bridge_issue'
    assert shapes[0]['type'] == 'mask'
    
    # Expect score to be the maximum (0.90)
    assert len(shapes[0]['attributes']) == 1
    assert shapes[0]['attributes'][0]['spec_id'] == 0
    assert shapes[0]['attributes'][0]['value'] == '0.900000'


def test_handle_passes_request_threshold_to_both_backends(mock_image, mock_bbox, mock_mapping):
    """Test that request-level threshold is passed to both shape and stain backends."""
    import importlib
    from PIL import Image
    
    model_handler = importlib.import_module('model_handler')
    
    received_thresholds = {'shape': [], 'stain': []}
    
    class ThresholdCapturingShapeBackend:
        def __init__(self, checkpoint_dir, config_path, conf_threshold):
            self.checkpoint_dir = checkpoint_dir
            self.config_path = config_path
            self.conf_threshold = conf_threshold
        
        def predict(self, image, conf_threshold=None):
            received_thresholds['shape'].append(conf_threshold)
            return []
    
    class ThresholdCapturingStainBackend:
        def __init__(self, checkpoint_dir, config_path, conf_threshold):
            self.checkpoint_dir = checkpoint_dir
            self.config_path = config_path
            self.conf_threshold = conf_threshold
        
        def predict(self, image, conf_threshold=None):
            received_thresholds['stain'].append(conf_threshold)
            return []
    
    # Replace backends with capturing versions
    import importlib
    shape_backend = importlib.import_module('shape_backend')
    stain_backend = importlib.import_module('stain_backend')
    original_shape = shape_backend.RFDETRShapeBackend
    original_stain = stain_backend.RFDETRStainBackend
    
    shape_backend.RFDETRShapeBackend = ThresholdCapturingShapeBackend
    stain_backend.RFDETRStainBackend = ThresholdCapturingStainBackend
    
    try:
        # Reload model_handler to pick up new backends
        importlib.reload(model_handler)
        
        handler = model_handler.ModelHandler()
        pil_image = Image.fromarray(mock_image)
        
        # Call with request threshold override
        shapes = handler.handle(pil_image, mock_bbox, mock_mapping, confidence_threshold=0.35)
        
        # Verify both backends received the same threshold
        assert received_thresholds['shape'] == [0.35]
        assert received_thresholds['stain'] == [0.35]
    finally:
        # Restore original backends
        shape_backend.RFDETRShapeBackend = original_shape
        stain_backend.RFDETRStainBackend = original_stain
        importlib.reload(model_handler)


def test_handle_raises_on_invalid_threshold(mock_image, mock_bbox, mock_mapping):
    """Test that model handler raises ValueError for invalid confidence_threshold."""
    import importlib
    from PIL import Image
    
    model_handler = importlib.import_module('model_handler')
    
    handler = model_handler.ModelHandler()
    pil_image = Image.fromarray(mock_image)
    
    # Test invalid value (non-numeric)
    with pytest.raises(ValueError, match="confidence_threshold must be a number"):
        handler.handle(pil_image, mock_bbox, mock_mapping, confidence_threshold='bad-value')
    
    # Test out of range (too low)
    with pytest.raises(ValueError, match="confidence_threshold must be between 0.05 and 0.99"):
        handler.handle(pil_image, mock_bbox, mock_mapping, confidence_threshold=0.01)
    
    # Test out of range (too high)
    with pytest.raises(ValueError, match="confidence_threshold must be between 0.05 and 0.99"):
        handler.handle(pil_image, mock_bbox, mock_mapping, confidence_threshold=1.5)


def test_handle_uses_env_default_when_no_request_threshold(mock_image, mock_bbox, mock_mapping):
    """Test that model handler uses env default threshold when request doesn't provide one."""
    import importlib
    from PIL import Image
    
    model_handler = importlib.import_module('model_handler')
    
    received_thresholds = {'shape': [], 'stain': []}
    
    class ThresholdCapturingShapeBackend:
        def __init__(self, checkpoint_dir, config_path, conf_threshold):
            self.checkpoint_dir = checkpoint_dir
            self.config_path = config_path
            self.conf_threshold = conf_threshold
        
        def predict(self, image, conf_threshold=None):
            received_thresholds['shape'].append(conf_threshold)
            return []
    
    class ThresholdCapturingStainBackend:
        def __init__(self, checkpoint_dir, config_path, conf_threshold):
            self.checkpoint_dir = checkpoint_dir
            self.config_path = config_path
            self.conf_threshold = conf_threshold
        
        def predict(self, image, conf_threshold=None):
            received_thresholds['stain'].append(conf_threshold)
            return []
    
    # Replace backends with capturing versions
    import importlib
    shape_backend = importlib.import_module('shape_backend')
    stain_backend = importlib.import_module('stain_backend')
    original_shape = shape_backend.RFDETRShapeBackend
    original_stain = stain_backend.RFDETRStainBackend
    
    shape_backend.RFDETRShapeBackend = ThresholdCapturingShapeBackend
    stain_backend.RFDETRStainBackend = ThresholdCapturingStainBackend
    
    try:
        # Reload model_handler to pick up new backends
        importlib.reload(model_handler)
        
        handler = model_handler.ModelHandler()
        pil_image = Image.fromarray(mock_image)
        
        # Call without request threshold (should use env default 0.2)
        shapes = handler.handle(pil_image, mock_bbox, mock_mapping)
        
        # Verify both backends received the env default (0.2 from mock_env fixture)
        assert received_thresholds['shape'] == [0.2]
        assert received_thresholds['stain'] == [0.2]
    finally:
        # Restore original backends
        shape_backend.RFDETRShapeBackend = original_shape
        stain_backend.RFDETRStainBackend = original_stain
        importlib.reload(model_handler)
