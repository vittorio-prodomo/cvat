import base64
import io
import json
from types import SimpleNamespace

from PIL import Image
import pytest


def encoded_image(mode="RGB", size=(17, 11)):
    buffer = io.BytesIO()
    Image.new(mode, size).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class Context:
    def __init__(self, model):
        self.user_data = SimpleNamespace(model=model)
        self.messages = []
        self.logger = SimpleNamespace(info=self.messages.append, error=self.messages.append)

    @staticmethod
    def Response(**kwargs):
        return SimpleNamespace(**kwargs)


class Model:
    def __init__(self):
        self.calls = []

    def handle(self, *, image, threshold):
        self.calls.append((image.size, image.mode, threshold))
        return [{"label": "crack", "type": "mask", "confidence": 0.9,
                 "attributes": [], "mask": [1, 0, 0, 0, 0]}]


@pytest.mark.parametrize("body_type", [dict, str, bytes])
@pytest.mark.parametrize("mode", ["RGB", "L", "RGBA"])
def test_http_handler_accepts_native_body_forms_and_returns_flat_detector_list(load_indoor, body_type, mode):
    main = load_indoor("main")
    model = Model()
    context = Context(model)
    data = {"image": encoded_image(mode), "threshold": 0.65}
    body = data if body_type is dict else json.dumps(data)
    if body_type is bytes:
        body = body.encode()
    response = main.handler(context, SimpleNamespace(body=body))
    assert response.status_code == 200
    assert response.content_type == "application/json"
    assert response.headers == {}
    annotations = json.loads(response.body)
    assert isinstance(annotations, list)
    assert annotations[0]["mask"] == [1, 0, 0, 0, 0]
    assert model.calls == [((17, 11), "RGB", 0.65)]


@pytest.mark.parametrize("threshold", [None, 0, 1])
def test_http_handler_passes_native_null_and_threshold_boundaries(load_indoor, threshold):
    main = load_indoor("main")
    model = Model()
    response = main.handler(Context(model), SimpleNamespace(body={"image": encoded_image(), "threshold": threshold}))
    assert response.status_code == 200
    assert model.calls[0][-1] == (0.2 if threshold is None else threshold)


def test_http_handler_defaults_missing_threshold_and_leaves_native_roi_coordinates_local(load_indoor):
    main = load_indoor("main")
    model = Model()
    response = main.handler(Context(model), SimpleNamespace(body={
        "image": encoded_image(size=(3, 5)), "roi": [100, 200, 103, 205],
        "mapping": {"crack": "renamed"},
    }))
    assert response.status_code == 200
    assert model.calls == [((3, 5), "RGB", 0.2)]
    assert json.loads(response.body)[0]["label"] == "crack"
    assert json.loads(response.body)[0]["mask"][-4:] == [0, 0, 0, 0]


@pytest.mark.parametrize("body", [None, [], 3, "{", b"\xff", "null", "[]", "1"])
def test_http_handler_returns_400_for_malformed_body_without_inference(load_indoor, body):
    main = load_indoor("main")
    model = Model()
    response = main.handler(Context(model), SimpleNamespace(body=body))
    assert response.status_code == 400
    assert "error" in json.loads(response.body)
    assert model.calls == []


@pytest.mark.parametrize("value", [None, 2, [], "", "not-base64", "☃", base64.b64encode(b"not an image").decode()])
def test_http_handler_returns_400_for_invalid_image_without_inference(load_indoor, value):
    main = load_indoor("main")
    model = Model()
    response = main.handler(Context(model), SimpleNamespace(body={"image": value}))
    assert response.status_code == 400
    assert "image" in json.loads(response.body)["error"]
    assert model.calls == []


@pytest.mark.parametrize("value", [True, "0.5", float("nan"), float("inf"), -0.1, 1.1, 10**1000])
def test_http_handler_rejects_bad_threshold_before_inference(load_indoor, value):
    main = load_indoor("main")
    model = Model()
    response = main.handler(Context(model), SimpleNamespace(body={"image": encoded_image(), "threshold": value}))
    assert response.status_code == 400
    assert "threshold" in json.loads(response.body)["error"]
    assert model.calls == []


@pytest.mark.parametrize("exception", [RuntimeError("CUDA failure"), ValueError("bad model outputs")])
def test_inference_failures_are_logged_and_return_500_never_empty_detections(load_indoor, exception):
    main = load_indoor("main")

    class BrokenModel:
        def handle(self, **kwargs):
            raise exception

    context = Context(BrokenModel())
    response = main.handler(context, SimpleNamespace(body={"image": encoded_image()}))
    assert response.status_code == 500
    assert json.loads(response.body) == {"error": "Indoor inference failed"}
    assert any(str(exception) in message for message in context.messages)


def test_init_context_loads_model_eagerly_with_native_logger(load_indoor, monkeypatch):
    main = load_indoor("main")
    model = Model()
    received = []
    monkeypatch.setattr(main, "ModelHandler", lambda *, logger: received.append(logger) or model)
    context = Context(None)
    main.init_context(context)
    assert context.user_data.model is model
    assert received == [context.logger]
