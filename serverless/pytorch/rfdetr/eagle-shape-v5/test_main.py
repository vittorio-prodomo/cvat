import base64
import importlib.util
import io
import json
from pathlib import Path
import sys
from types import SimpleNamespace

from PIL import Image

MODULE_NAME = 'eagle_shape_v5_main'
LOCAL_MODULE_NAMES = ('postprocess', 'rfdetr_backend', 'model_handler')


def load_local_module(module_dir, module_name):
    spec = importlib.util.spec_from_file_location(
        f'{MODULE_NAME}_{module_name}',
        module_dir / f'{module_name}.py',
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[spec.name] = module
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def load_main():
    module_dir = Path(__file__).parent
    saved_modules = {
        module_name: sys.modules.get(module_name)
        for module_name in LOCAL_MODULE_NAMES
    }
    sys.path.insert(0, str(module_dir))
    try:
        for module_name in LOCAL_MODULE_NAMES:
            load_local_module(module_dir, module_name)
        spec = importlib.util.spec_from_file_location(
            MODULE_NAME,
            module_dir / 'main.py',
        )
        module = importlib.util.module_from_spec(spec)
        assert spec.loader is not None
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        return module
    finally:
        sys.path.pop(0)
        for module_name, saved_module in saved_modules.items():
            if saved_module is None:
                sys.modules.pop(module_name, None)
            else:
                sys.modules[module_name] = saved_module


main = load_main()
MODEL_HANDLER_PATH = Path(__file__).with_name('model_handler.py').resolve()


class DummyContext:
    def __init__(self):
        self.user_data = SimpleNamespace()
        self.logger = SimpleNamespace(info=lambda *args, **kwargs: None)

    class Response:
        def __init__(self, *, body, headers, content_type, status_code):
            self.body = body
            self.headers = headers
            self.content_type = content_type
            self.status_code = status_code


class DummyModel:
    def handle(self, *, image, obj_bbox, mapping, confidence_threshold=None):
        assert image.size == (4, 4)
        assert obj_bbox == [[1, 1], [3, 3]]
        assert mapping == {'(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}}}
        return [{
            'label': 'danno_urto_a13',
            'type': 'mask',
            'points': [0, 4, 4, 4, 0, 0, 3, 3],
            'attributes': [{'spec_id': 0, 'value': '0.9'}],
        }]


def encode_image():
    buf = io.BytesIO()
    Image.new('RGB', (4, 4), 'white').save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def test_handler_decodes_image_and_returns_shapes_json():
    context = DummyContext()
    context.user_data.model = DummyModel()
    event = SimpleNamespace(body={
        'image': encode_image(),
        'obj_bbox': [[1, 1], [3, 3]],
        'mapping': {'(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}}},
    })

    response = main.handler(context, event)

    assert response.status_code == 200
    assert json.loads(response.body)['shapes'][0]['label'] == 'danno_urto_a13'


def test_handler_logs_request_summary():
    messages = []

    class LoggingContext(DummyContext):
        def __init__(self):
            super().__init__()
            self.logger = SimpleNamespace(info=lambda message: messages.append(message))

    context = LoggingContext()
    context.user_data.model = DummyModel()
    event = SimpleNamespace(body={
        'image': encode_image(),
        'obj_bbox': [[1, 1], [3, 3]],
        'mapping': {'(A13) danno_urto': {'name': 'danno_urto_a13', 'attributes': {}}},
    })

    main.handler(context, event)

    assert any(
        message == (
            'RF-DETR shape request summary: '
            'image_size=(4, 4) '
            'bbox=[[1, 1], [3, 3]] '
            'mapping_keys=1 '
            "mapping_labels=['(A13) danno_urto']"
        )
        for message in messages
    )
    assert any(
        message == 'RF-DETR shape response summary: returned_shapes=1'
        for message in messages
    )


def test_init_context_passes_context_logger_into_model_handler(monkeypatch):
    fake_model = DummyModel()
    received_logger = []

    def fake_model_handler(*, logger):
        received_logger.append(logger)
        return fake_model

    monkeypatch.setattr(main, 'ModelHandler', fake_model_handler)
    context = DummyContext()

    main.init_context(context)

    assert received_logger == [context.logger]
    assert context.user_data.model is fake_model


def test_main_uses_local_model_handler_module():
    loaded_model_handler = sys.modules[main.ModelHandler.__module__]

    assert Path(loaded_model_handler.__file__).resolve() == MODEL_HANDLER_PATH


def test_handler_passes_confidence_threshold_to_model_handler():
    """Verify main.handler reads confidence_threshold from request and forwards it to ModelHandler.handle()."""
    received_threshold = []

    class ThresholdCaptureModel:
        def handle(self, *, image, obj_bbox, mapping, confidence_threshold=None):
            received_threshold.append(confidence_threshold)
            return []

    context = DummyContext()
    context.user_data.model = ThresholdCaptureModel()
    event = SimpleNamespace(body={
        'image': encode_image(),
        'obj_bbox': [[1, 1], [3, 3]],
        'mapping': {},
        'confidence_threshold': 0.35,
    })

    main.handler(context, event)

    assert received_threshold == [0.35]


def test_handler_returns_400_on_invalid_confidence_threshold():
    """Verify main.handler catches ValueError from ModelHandler and returns HTTP 400."""
    class InvalidThresholdModel:
        def handle(self, *, image, obj_bbox, mapping, confidence_threshold=None):
            if confidence_threshold is not None and confidence_threshold > 1.0:
                raise ValueError(f'confidence_threshold must be between 0.0 and 1.0, got {confidence_threshold}')
            return []

    context = DummyContext()
    context.user_data.model = InvalidThresholdModel()
    event = SimpleNamespace(body={
        'image': encode_image(),
        'obj_bbox': [[1, 1], [3, 3]],
        'mapping': {},
        'confidence_threshold': 1.2,
    })

    response = main.handler(context, event)

    assert response.status_code == 400
    error_body = json.loads(response.body)
    assert 'error' in error_body
    assert 'confidence_threshold' in error_body['error']
