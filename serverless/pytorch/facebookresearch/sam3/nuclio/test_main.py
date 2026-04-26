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
    def __init__(self):
        self.calls = []

    def handle(self, image, *, pos_points, neg_points, obj_bbox):
        self.calls.append(
            {
                'size': image.size,
                'pos_points': pos_points,
                'neg_points': neg_points,
                'obj_bbox': obj_bbox,
            },
        )
        return [[1, 0], [0, 1]]


def encode_image():
    buf = io.BytesIO()
    Image.new('RGB', (2, 2), 'white').save(buf, format='PNG')
    return base64.b64encode(buf.getvalue()).decode('utf-8')


def test_handler_decodes_request_and_returns_mask_json():
    context = DummyContext()
    context.user_data.model = DummyModel()
    event = SimpleNamespace(
        body={
            'image': encode_image(),
            'pos_points': [[10.0, 20.0]],
            'neg_points': [[30.0, 40.0]],
            'obj_bbox': [[1.0, 2.0], [3.0, 4.0]],
        },
    )

    response = main.handler(context, event)

    assert response.status_code == 200
    assert json.loads(response.body) == {'mask': [[1, 0], [0, 1]]}
    assert context.user_data.model.calls[0]['size'] == (2, 2)
    assert context.user_data.model.calls[0]['pos_points'] == [[10.0, 20.0]]
    assert context.user_data.model.calls[0]['neg_points'] == [[30.0, 40.0]]
    assert context.user_data.model.calls[0]['obj_bbox'] == [[1.0, 2.0], [3.0, 4.0]]


def test_init_context_stores_model(monkeypatch):
    fake_model = DummyModel()
    monkeypatch.setattr(main, 'ModelHandler', lambda: fake_model)
    context = DummyContext()

    main.init_context(context)

    assert context.user_data.model is fake_model
