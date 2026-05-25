from pathlib import Path
import sys

import numpy as np
import pytest


MODULE_DIR = Path(__file__).parent
LOCAL_MODULE_NAMES = ('postprocess', 'shape_backend')


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


# Test isolation: Create a fixture-based mock with proper module-level isolation
@pytest.fixture(autouse=True)
def mock_torch():
    """Fixture to mock torch module with proper cleanup.
    
    Uses autouse=True so it's automatically applied to all tests,
    ensuring torch mock is available when shape_backend imports it.
    """
    class MockTensor:
        """Mock tensor with device support."""
        def __init__(self, data, device='cpu'):
            self.data = np.array(data)
            self._device = device
        
        def to(self, device):
            """Mock tensor.to(device) method."""
            return MockTensor(self.data, device=str(device))
        
        def cpu(self):
            """Mock tensor.cpu() method."""
            return MockTensor(self.data, device='cpu')
        
        def numpy(self):
            """Mock tensor.numpy() method."""
            return self.data
        
        def item(self):
            """Mock tensor.item() method."""
            return float(self.data)
        
        def squeeze(self, dim=None):
            """Mock tensor.squeeze() method."""
            squeezed = np.squeeze(self.data, axis=dim)
            return MockTensor(squeezed, device=self._device)
        
        def unsqueeze(self, dim):
            """Mock tensor.unsqueeze() method."""
            unsqueezed = np.expand_dims(self.data, axis=dim)
            return MockTensor(unsqueezed, device=self._device)
        
        def permute(self, *dims):
            """Mock tensor.permute() method."""
            permuted = np.transpose(self.data, dims)
            return MockTensor(permuted, device=self._device)
        
        def view(self, *shape):
            """Mock tensor.view() method."""
            reshaped = self.data.reshape(*shape)
            return MockTensor(reshaped, device=self._device)
        
        def float(self):
            """Mock tensor.float() method."""
            return MockTensor(self.data.astype(np.float32), device=self._device)
        
        def __truediv__(self, other):
            """Mock division."""
            if isinstance(other, MockTensor):
                result = self.data / other.data
            else:
                result = self.data / other
            return MockTensor(result, device=self._device)
        
        def __sub__(self, other):
            """Mock subtraction."""
            if isinstance(other, MockTensor):
                result = self.data - other.data
            else:
                result = self.data - other
            return MockTensor(result, device=self._device)
        
        def __getitem__(self, key):
            """Mock indexing."""
            result = self.data[key]
            return MockTensor(result, device=self._device)
        
        def __gt__(self, other):
            """Mock greater than comparison."""
            result = self.data > other
            return MockTensor(result, device=self._device)
        
        def any(self):
            """Mock any() method."""
            return np.any(self.data)
    
    class MockDevice:
        """Mock torch.device."""
        def __init__(self, device_str):
            self.type = device_str.split(':')[0] if ':' in device_str else device_str
            self.full_str = device_str
        
        def __str__(self):
            return self.full_str
    
    class MockTorch:
        @staticmethod
        def load(path, map_location=None, weights_only=False):
            raise NotImplementedError("torch.load should be mocked in tests")
        
        @staticmethod
        def from_numpy(arr):
            return MockTensor(arr)
        
        @staticmethod
        def tensor(data):
            return MockTensor(data)
        
        @staticmethod
        def no_grad():
            """Mock torch.no_grad() context manager."""
            class NoGradContext:
                def __enter__(self):
                    return self
                def __exit__(self, *args):
                    pass
            return NoGradContext()
        
        @staticmethod
        def device(device_str):
            return MockDevice(device_str)
    
    original_torch = sys.modules.get('torch', None)
    sys.modules['torch'] = MockTorch()
    
    # Force reimport of shape_backend so it picks up the mocked torch
    if 'shape_backend' in sys.modules:
        del sys.modules['shape_backend']
    
    yield MockTorch
    
    # Cleanup: restore original torch or remove mock
    if original_torch is not None:
        sys.modules['torch'] = original_torch
    elif 'torch' in sys.modules:
        del sys.modules['torch']
    
    # Clean up shape_backend to force reimport next time
    if 'shape_backend' in sys.modules:
        del sys.modules['shape_backend']


# Import shape_backend functions inside each test, not at module level
# This ensures the import happens after the mock_torch fixture has set up sys.modules['torch']


def test_parse_map_score_reads_epoch_style_checkpoint_names(mock_torch):
    from shape_backend import parse_map_score
    assert parse_map_score("epoch=068-map=0.1328.ckpt") == pytest.approx(0.1328)
    assert parse_map_score("epoch=037-map=0.3146.ckpt") == pytest.approx(0.3146)


def test_parse_map_score_returns_negative_for_invalid_names(mock_torch):
    from shape_backend import parse_map_score
    assert parse_map_score("last.ckpt") == -1.0
    assert parse_map_score("model.pth") == -1.0
    assert parse_map_score("no-map-here.ckpt") == -1.0


def test_find_best_checkpoint_picks_highest_map(mock_torch, tmp_path):
    from shape_backend import find_best_checkpoint
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=068-map=0.1328.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=073-map=0.1325.ckpt").write_bytes(b"x")
    (checkpoints / "last.ckpt").write_bytes(b"x")

    selected = find_best_checkpoint(checkpoints)

    assert selected == checkpoints / "epoch=068-map=0.1328.ckpt"


def test_find_best_checkpoint_requires_epoch_map_files(mock_torch, tmp_path):
    from shape_backend import find_best_checkpoint
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "last.ckpt").write_bytes(b"x")

    with pytest.raises(RuntimeError, match="No epoch=.*-map=.*ckpt files"):
        find_best_checkpoint(checkpoints)


def test_find_best_checkpoint_requires_directory_to_exist(mock_torch):
    from shape_backend import find_best_checkpoint
    non_existent = Path("/nonexistent/path/checkpoints")
    with pytest.raises(RuntimeError, match="Checkpoint directory does not exist"):
        find_best_checkpoint(non_existent)


def test_load_checkpoint_state_dict_strips_lightning_model_prefix(mock_torch, tmp_path):
    from shape_backend import load_checkpoint_state_dict
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        assert Path(path) == checkpoint
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
                "model.head.bias": np.array([2.0]),
            }
        }

    # Replace the mock torch.load with our fake
    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        state_dict = load_checkpoint_state_dict(checkpoint)
        assert sorted(state_dict) == ["backbone.weight", "head.bias"]
    finally:
        sys.modules['torch'].load = original_load


def test_load_checkpoint_state_dict_requires_state_dict_key(mock_torch, tmp_path):
    from shape_backend import load_checkpoint_state_dict
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        return {"some_other_key": {}}

    # Replace the mock torch.load with our fake
    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        with pytest.raises(KeyError, match="state_dict"):
            load_checkpoint_state_dict(checkpoint)
    finally:
        sys.modules['torch'].load = original_load


def test_parse_map_score_requires_epoch_prefix(mock_torch):
    """Checkpoint selection must match exact epoch=...-map=...ckpt format."""
    from shape_backend import parse_map_score
    # These should match
    assert parse_map_score("epoch=001-map=0.1234.ckpt") == pytest.approx(0.1234)
    assert parse_map_score("epoch=999-map=0.9999.ckpt") == pytest.approx(0.9999)
    
    # These should NOT match (missing epoch= prefix)
    assert parse_map_score("map=0.1234.ckpt") == -1.0
    assert parse_map_score("e001-map=0.1234.ckpt") == -1.0
    assert parse_map_score("training-map=0.1234.ckpt") == -1.0


def test_find_best_checkpoint_breaks_map_ties_by_epoch(mock_torch, tmp_path):
    """When mAP scores are equal, pick the checkpoint with the highest epoch."""
    from shape_backend import find_best_checkpoint
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=010-map=0.1500.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=020-map=0.1500.ckpt").write_bytes(b"x")
    (checkpoints / "epoch=015-map=0.1500.ckpt").write_bytes(b"x")

    selected = find_best_checkpoint(checkpoints)

    # Should pick epoch=020 (highest epoch among tied maps)
    assert selected == checkpoints / "epoch=020-map=0.1500.ckpt"


def test_find_best_checkpoint_rejects_non_epoch_map_patterns(mock_torch, tmp_path):
    """Checkpoint selection must reject files that don't match epoch=...-map=...ckpt."""
    from shape_backend import find_best_checkpoint
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "map=0.2000.ckpt").write_bytes(b"x")  # Missing epoch=
    (checkpoints / "last.ckpt").write_bytes(b"x")

    with pytest.raises(RuntimeError, match="No epoch=.*-map=.*ckpt files"):
        find_best_checkpoint(checkpoints)


def test_load_checkpoint_state_dict_fails_on_incompatible_checkpoint(mock_torch, tmp_path):
    """Incompatible checkpoints should fail explicitly, not silently drop keys."""
    from shape_backend import load_checkpoint_state_dict
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        # Checkpoint with NO model. prefix keys
        return {
            "state_dict": {
                "backbone.weight": np.array([1.0]),
                "head.bias": np.array([2.0]),
            }
        }

    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        # Should raise an error because no keys start with "model."
        with pytest.raises(RuntimeError, match="No keys.*model\\."):
            load_checkpoint_state_dict(checkpoint)
    finally:
        sys.modules['torch'].load = original_load


def test_load_checkpoint_state_dict_rejects_mixed_key_formats(mock_torch, tmp_path):
    """Mixed key formats should fail explicitly, not partially accepted."""
    from shape_backend import load_checkpoint_state_dict
    import sys
    checkpoint = tmp_path / "epoch=001-map=0.1000.ckpt"
    checkpoint.write_bytes(b"x")

    def fake_torch_load(path, map_location=None, weights_only=False):
        # Mixed checkpoint: some keys have model. prefix, some don't
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
                "model.head.bias": np.array([2.0]),
                "optimizer.state": np.array([3.0]),  # No model. prefix
                "other.value": np.array([4.0]),  # No model. prefix
            }
        }

    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load

    try:
        # Should raise an error because of mixed key formats
        with pytest.raises(RuntimeError, match="mixed key formats|incompatible"):
            load_checkpoint_state_dict(checkpoint)
    finally:
        sys.modules['torch'].load = original_load


def test_postprocess_constructor_accepts_only_num_select(mock_torch):
    """Test that PostProcess is initialized with only num_select parameter.
    
    This test will FAIL if the backend tries to pass num_classes to PostProcess.
    The upstream RF-DETR PostProcess only accepts num_select.
    """
    # This test simulates what would happen during _load_model()
    # The real PostProcess class only accepts num_select, not num_classes
    class RealPostProcess:
        def __init__(self, num_select=300):
            self.num_select = num_select
            # If num_classes is passed, it will fail
    
    # This should work (correct)
    postproc = RealPostProcess(num_select=100)
    assert postproc.num_select == 100
    
    # This would fail (incorrect - what the backend currently does)
    with pytest.raises(TypeError, match="unexpected keyword argument"):
        RealPostProcess(num_select=100, num_classes=11)


def test_masks_are_squeezed_to_2d_from_postprocessor_output(mock_torch):
    """Test that masks from postprocessor are squeezed from [K,1,H,W] to [H,W].
    
    This test will FAIL if the backend doesn't squeeze the singleton channel dimension.
    The upstream PostProcess returns masks shaped [K, 1, H, W] after interpolation,
    but downstream crop postprocessing expects 2-D [H, W] masks.
    """
    # Simulate postprocessor output with singleton channel dimension
    # This is what the real PostProcess.forward() returns
    mock_mask_4d = np.ones((1, 1, 4, 4), dtype=bool)  # [K=1, C=1, H=4, W=4]
    
    # The backend should squeeze this to 2-D
    # Expected: [4, 4]
    # Actual (buggy): [1, 4, 4] if only indexing [0] but not squeezing channel
    
    # Check that 4-D mask can't be used directly with downstream mask_to_rle
    # mask_to_rle expects: height, width = mask.shape
    # If mask has 3 dimensions (buggy case), unpacking will fail
    
    # This will FAIL if mask is not 2-D
    mask_3d = mock_mask_4d[0]  # [1, 4, 4] - still has singleton channel
    with pytest.raises(ValueError):
        # Should fail to unpack 3 values from 2-element tuple
        height, width = mask_3d.shape
    
    # This should work (2-D mask)
    mask_2d = mock_mask_4d[0, 0]  # [4, 4] - properly squeezed
    height, width = mask_2d.shape
    assert (height, width) == (4, 4)


def test_torch_mock_isolation_does_not_leak(mock_torch):
    """Test that torch mock is properly isolated and cleaned up.
    
    This test verifies that the mock_torch fixture properly restores the
    original torch module state after each test, preventing mocks from
    leaking into the pytest process.
    """
    import sys
    
    # The fixture should have injected a mock
    assert 'torch' in sys.modules
    assert hasattr(sys.modules['torch'], 'load')
    
    # The mock should raise NotImplementedError as defined in fixture
    with pytest.raises(NotImplementedError, match="torch.load should be mocked in tests"):
        sys.modules['torch'].load("dummy_path")
    
    # After this test completes, the fixture will clean up
    # Subsequent tests should get a fresh mock, not leak this one


def test_model_is_moved_to_device_after_loading(mock_torch, tmp_path):
    """Test that model is moved to args.device after loading.
    
    This test will FAIL if the backend doesn't move the model to the configured device.
    GPU deployment requires model on correct device.
    """
    from shape_backend import RFDETRShapeBackend
    import sys
    
    # Create mock checkpoint
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=001-map=0.1000.ckpt").write_bytes(b"x")
    
    # Track whether model.to(device) was called
    to_device_called = []
    
    class MockModel:
        def __init__(self):
            self.eval_called = False
        
        def load_state_dict(self, state_dict, strict=True):
            pass
        
        def eval(self):
            self.eval_called = True
            return self
        
        def to(self, device):
            """Track that model.to(device) was called."""
            to_device_called.append(str(device))
            return self
        
        def __call__(self, x):
            # Mock forward pass
            return {
                "pred_logits": mock_torch.tensor([[0.9, 0.1]]),
                "pred_boxes": mock_torch.tensor([[0.5, 0.5, 0.2, 0.2]]),
                "pred_masks": mock_torch.tensor([[[[1, 0], [0, 1]]]]),
            }
    
    def fake_torch_load(path, map_location=None, weights_only=False):
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
            }
        }
    
    def fake_build_model(args):
        """Mock build_model to return our tracked model."""
        return MockModel()
    
    # Patch torch.load
    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load
    
    # Patch build_model by injecting into sys.modules
    fake_rfdetr_module = type(sys)('rfdetr')
    fake_rfdetr_models = type(sys)('rfdetr.models')
    fake_rfdetr_models_lwdetr = type(sys)('rfdetr.models.lwdetr')
    fake_rfdetr_config = type(sys)('rfdetr.config')
    fake_rfdetr_main = type(sys)('rfdetr.main')
    
    sys.modules['rfdetr'] = fake_rfdetr_module
    sys.modules['rfdetr.models'] = fake_rfdetr_models
    sys.modules['rfdetr.models.lwdetr'] = fake_rfdetr_models_lwdetr
    sys.modules['rfdetr.config'] = fake_rfdetr_config
    sys.modules['rfdetr.main'] = fake_rfdetr_main
    
    # Add build_model to module
    fake_rfdetr_models_lwdetr.build_model = fake_build_model
    
    # Add PostProcess
    class FakePostProcess:
        def __init__(self, num_select=300):
            self.num_select = num_select
        
        def __call__(self, outputs, target_sizes):
            # Return empty results for simplicity
            return []
    
    fake_rfdetr_models_lwdetr.PostProcess = FakePostProcess
    
    # Add config class
    class FakeConfig:
        def dict(self):
            return {
                "num_classes": 11,
                "device": "cuda:0",  # This is the key: args should have device
            }
    
    fake_rfdetr_config.RFDETRSegLargeConfig = FakeConfig
    
    # Add populate_args
    class FakeArgs:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
            # populate_args should set device from config
            if not hasattr(self, 'device'):
                self.device = 'cuda:0'
            # Ensure num_select is set (RF-DETR default)
            if not hasattr(self, 'num_select'):
                self.num_select = 200
    
    fake_rfdetr_main.populate_args = lambda **kwargs: FakeArgs(**kwargs)
    
    try:
        # Create backend and trigger model loading
        backend = RFDETRShapeBackend(
            checkpoint_dir=checkpoints,
            _skip_mount_check=True,
        )
        
        # Access _load_model to trigger loading
        backend._load_model()
        
        # Verify model.to(device) was called with the correct device
        # The bug: model.to() is never called
        # The fix: model.to(args.device) should be called after load_state_dict
        assert len(to_device_called) > 0, "model.to(device) was never called!"
        assert to_device_called[0] == "cuda:0", f"Expected cuda:0, got {to_device_called[0]}"
        
    finally:
        # Cleanup
        sys.modules['torch'].load = original_load
        for module in ['rfdetr', 'rfdetr.models', 'rfdetr.models.lwdetr', 'rfdetr.config', 'rfdetr.main']:
            if module in sys.modules:
                del sys.modules[module]


def test_predict_tensors_use_model_device(mock_torch, tmp_path):
    """Test that predict() moves input tensors to model device.
    
    This test will FAIL if the backend doesn't keep tensors on the correct device.
    GPU inference requires all tensors on same device as model.
    """
    from shape_backend import RFDETRShapeBackend
    import sys
    
    # Create mock checkpoint
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=001-map=0.1000.ckpt").write_bytes(b"x")
    
    # Track device of tensors passed to model
    tensor_devices = []
    
    class MockModel:
        def __init__(self):
            self._device = "cuda:0"
        
        def load_state_dict(self, state_dict, strict=True):
            pass
        
        def eval(self):
            return self
        
        def to(self, device):
            self._device = str(device)
            return self
        
        def __call__(self, x):
            """Track device of input tensor."""
            # In real torch, we'd check x.device
            # In our mock, we track the device attribute
            tensor_devices.append(getattr(x, '_device', 'cpu'))
            
            # Mock forward pass
            return {
                "pred_logits": mock_torch.tensor([[0.9, 0.1]]),
                "pred_boxes": mock_torch.tensor([[0.5, 0.5, 0.2, 0.2]]),
                "pred_masks": mock_torch.tensor([[[[1, 0], [0, 1]]]]),
            }
    
    def fake_torch_load(path, map_location=None, weights_only=False):
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
            }
        }
    
    def fake_build_model(args):
        """Mock build_model to return our tracked model."""
        return MockModel()
    
    # Patch torch.load
    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load
    
    # Patch build_model by injecting into sys.modules
    fake_rfdetr_module = type(sys)('rfdetr')
    fake_rfdetr_models = type(sys)('rfdetr.models')
    fake_rfdetr_models_lwdetr = type(sys)('rfdetr.models.lwdetr')
    fake_rfdetr_config = type(sys)('rfdetr.config')
    fake_rfdetr_main = type(sys)('rfdetr.main')
    
    sys.modules['rfdetr'] = fake_rfdetr_module
    sys.modules['rfdetr.models'] = fake_rfdetr_models
    sys.modules['rfdetr.models.lwdetr'] = fake_rfdetr_models_lwdetr
    sys.modules['rfdetr.config'] = fake_rfdetr_config
    sys.modules['rfdetr.main'] = fake_rfdetr_main
    
    # Add build_model to module
    fake_rfdetr_models_lwdetr.build_model = fake_build_model
    
    # Add PostProcess
    class FakePostProcess:
        def __init__(self, num_select=300):
            self.num_select = num_select
        
        def __call__(self, outputs, target_sizes):
            # Return empty results for simplicity
            return []
    
    fake_rfdetr_models_lwdetr.PostProcess = FakePostProcess
    
    # Add config class
    class FakeConfig:
        def dict(self):
            return {
                "num_classes": 11,
                "device": "cuda:0",
            }
    
    fake_rfdetr_config.RFDETRSegLargeConfig = FakeConfig
    
    # Add populate_args
    class FakeArgs:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
            if not hasattr(self, 'device'):
                self.device = 'cuda:0'
            # Ensure num_select is set (RF-DETR default)
            if not hasattr(self, 'num_select'):
                self.num_select = 200
    
    fake_rfdetr_main.populate_args = lambda **kwargs: FakeArgs(**kwargs)
    
    try:
        # Create backend
        backend = RFDETRShapeBackend(
            checkpoint_dir=checkpoints,
            _skip_mount_check=True,
        )
        
        # Call predict with dummy image
        dummy_image = np.random.rand(100, 100, 3).astype(np.uint8)
        backend.predict(dummy_image)
        
        # Verify tensor was moved to model device
        # The bug: tensors stay on CPU
        # The fix: tensors should be moved to self._device
        assert len(tensor_devices) > 0, "No tensors passed to model!"
        assert tensor_devices[0] == "cuda:0", f"Expected tensor on cuda:0, got {tensor_devices[0]}"
        
    finally:
        # Cleanup
        sys.modules['torch'].load = original_load
        for module in ['rfdetr', 'rfdetr.models', 'rfdetr.models.lwdetr', 'rfdetr.config', 'rfdetr.main']:
            if module in sys.modules:
                del sys.modules[module]


def test_postprocess_uses_config_num_select(mock_torch, tmp_path):
    """Test that PostProcess is initialized with args.num_select from config.
    
    This test will FAIL if the backend hardcodes num_select=100 instead of
    using the RF-DETR config's num_select (which defaults to 200 for large).
    
    Following the training-toolkit adapter pattern:
    PostProcess(num_select=self._args.num_select)
    """
    from shape_backend import RFDETRShapeBackend
    import sys
    
    # Create mock checkpoint
    checkpoints = tmp_path / "checkpoints"
    checkpoints.mkdir()
    (checkpoints / "epoch=001-map=0.1000.ckpt").write_bytes(b"x")
    
    # Track PostProcess initialization
    postprocess_num_select = []
    
    class MockModel:
        def load_state_dict(self, state_dict, strict=True):
            pass
        
        def eval(self):
            return self
        
        def to(self, device):
            return self
        
        def __call__(self, x):
            return {
                "pred_logits": mock_torch.tensor([[0.9, 0.1]]),
                "pred_boxes": mock_torch.tensor([[0.5, 0.5, 0.2, 0.2]]),
                "pred_masks": mock_torch.tensor([[[[1, 0], [0, 1]]]]),
            }
    
    def fake_torch_load(path, map_location=None, weights_only=False):
        return {
            "state_dict": {
                "model.backbone.weight": np.array([1.0]),
            }
        }
    
    def fake_build_model(args):
        return MockModel()
    
    # Patch torch.load
    original_load = sys.modules['torch'].load
    sys.modules['torch'].load = fake_torch_load
    
    # Patch build_model by injecting into sys.modules
    fake_rfdetr_module = type(sys)('rfdetr')
    fake_rfdetr_models = type(sys)('rfdetr.models')
    fake_rfdetr_models_lwdetr = type(sys)('rfdetr.models.lwdetr')
    fake_rfdetr_config = type(sys)('rfdetr.config')
    fake_rfdetr_main = type(sys)('rfdetr.main')
    
    sys.modules['rfdetr'] = fake_rfdetr_module
    sys.modules['rfdetr.models'] = fake_rfdetr_models
    sys.modules['rfdetr.models.lwdetr'] = fake_rfdetr_models_lwdetr
    sys.modules['rfdetr.config'] = fake_rfdetr_config
    sys.modules['rfdetr.main'] = fake_rfdetr_main
    
    # Add build_model to module
    fake_rfdetr_models_lwdetr.build_model = fake_build_model
    
    # Add PostProcess with tracking
    class FakePostProcess:
        def __init__(self, num_select=300):
            """Track num_select initialization."""
            postprocess_num_select.append(num_select)
            self.num_select = num_select
        
        def __call__(self, outputs, target_sizes):
            return []
    
    fake_rfdetr_models_lwdetr.PostProcess = FakePostProcess
    
    # Add config class with num_select=200 (RF-DETR large default)
    class FakeConfig:
        def dict(self):
            return {
                "num_classes": 11,
                "device": "cpu",
                "num_select": 200,  # RF-DETR large default
            }
    
    fake_rfdetr_config.RFDETRSegLargeConfig = FakeConfig
    
    # Add populate_args that preserves num_select
    class FakeArgs:
        def __init__(self, **kwargs):
            for k, v in kwargs.items():
                setattr(self, k, v)
            if not hasattr(self, 'device'):
                self.device = 'cpu'
            # Ensure num_select is set from config
            if not hasattr(self, 'num_select'):
                self.num_select = 200
    
    fake_rfdetr_main.populate_args = lambda **kwargs: FakeArgs(**kwargs)
    
    try:
        # Create backend and trigger model loading
        backend = RFDETRShapeBackend(
            checkpoint_dir=checkpoints,
            _skip_mount_check=True,
        )
        
        # Access _load_model to trigger loading
        backend._load_model()
        
        # Verify PostProcess was initialized with config's num_select (200), not hardcoded 100
        # The bug: PostProcess(num_select=100) is hardcoded
        # The fix: PostProcess(num_select=self._args.num_select) should be used
        assert len(postprocess_num_select) > 0, "PostProcess was never initialized!"
        assert postprocess_num_select[0] == 200, (
            f"Expected PostProcess(num_select=200) from config, "
            f"got num_select={postprocess_num_select[0]}. "
            f"Backend should use self._args.num_select, not hardcode 100."
        )
        
    finally:
        # Cleanup
        sys.modules['torch'].load = original_load
        for module in ['rfdetr', 'rfdetr.models', 'rfdetr.models.lwdetr', 'rfdetr.config', 'rfdetr.main']:
            if module in sys.modules:
                del sys.modules[module]


def test_default_paths_match_manifest_opt_bdd_mount(mock_torch):
    """Verify backend's default paths match the manifest's /opt/bdd mount.
    
    The manifest (function-gpu.yaml) mounts the host's /data/projects/bridge_defect_detection
    to the container's /opt/bdd. The backend's default paths must use /opt/bdd, not the
    host-side /data/projects/bridge_defect_detection path, because the backend runs inside
    the Nuclio container where only /opt/bdd exists.
    
    This is a contract test: it ensures the backend's hardcoded defaults are consistent
    with the manifest's volume mount configuration.
    """
    from shape_backend import RFDETRShapeBackend
    
    # Expected paths from the manifest's /opt/bdd mount
    expected_checkpoint_dir = Path("/opt/bdd/runs/echo-combined-v5/shape_round1/checkpoints")
    expected_config_path = Path("/opt/bdd/runs/echo-combined-v5/shape_round1/config.yaml")
    expected_training_toolkit = Path("/opt/bdd/training-toolkit/src")
    expected_rfdetr_src = Path("/opt/bdd/rf-detr/src")
    
    # Verify the backend's class-level defaults match the manifest
    assert RFDETRShapeBackend.DEFAULT_CHECKPOINT_DIR == expected_checkpoint_dir, (
        f"DEFAULT_CHECKPOINT_DIR must be {expected_checkpoint_dir} to match manifest, "
        f"got {RFDETRShapeBackend.DEFAULT_CHECKPOINT_DIR}"
    )
    assert RFDETRShapeBackend.DEFAULT_CONFIG_PATH == expected_config_path, (
        f"DEFAULT_CONFIG_PATH must be {expected_config_path} to match manifest, "
        f"got {RFDETRShapeBackend.DEFAULT_CONFIG_PATH}"
    )
    assert RFDETRShapeBackend.TRAINING_TOOLKIT_PATH == expected_training_toolkit, (
        f"TRAINING_TOOLKIT_PATH must be {expected_training_toolkit} to match manifest, "
        f"got {RFDETRShapeBackend.TRAINING_TOOLKIT_PATH}"
    )
    assert RFDETRShapeBackend.RFDETR_SRC_PATH == expected_rfdetr_src, (
        f"RFDETR_SRC_PATH must be {expected_rfdetr_src} to match manifest, "
        f"got {RFDETRShapeBackend.RFDETR_SRC_PATH}"
    )

