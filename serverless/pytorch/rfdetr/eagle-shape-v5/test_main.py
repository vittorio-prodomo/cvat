import base64
import io
import json
from types import SimpleNamespace

from PIL import Image

import main


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
    def handle(self, *, image, obj_bbox, mapping):
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

    assert any('request summary' in message for message in messages)
    assert any('bbox=[[1, 1], [3, 3]]' in message for message in messages)
    assert any('mapping_keys=1' in message for message in messages)
    assert any('returned_shapes=1' in message for message in messages)


def test_init_context_stores_model(monkeypatch):
    fake_model = DummyModel()
    monkeypatch.setattr(main, 'ModelHandler', lambda: fake_model)
    context = DummyContext()

    main.init_context(context)

    assert context.user_data.model is fake_model
