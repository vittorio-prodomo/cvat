import base64
import io
import json
from types import SimpleNamespace

from PIL import Image
import pytest

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
        self.text_calls = []
        self.concept_calls = []
        self.refine_calls = []
        self.concept_error = None
        self.shapes = [{
            'type': 'mask',
            'points': [0, 1, 0, 0, 0, 0],
            'attributes': [{'spec_id': 0, 'value': '0.875'}],
        }]

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

    def handle_text(self, image, *, text_prompt):
        self.text_calls.append({'size': image.size, 'text_prompt': text_prompt})
        return self.shapes

    def handle_concept(self, image, *, text_prompt=None, exemplar_bbox=None):
        self.concept_calls.append({
            'size': image.size,
            'text_prompt': text_prompt,
            'exemplar_bbox': exemplar_bbox,
        })
        if self.concept_error is not None:
            raise ValueError(self.concept_error)
        return self.shapes

    def handle_refine(self, image, *, refinement_mask, pos_points, neg_points):
        self.refine_calls.append({
            'size': image.size, 'refinement_mask': refinement_mask,
            'pos_points': pos_points, 'neg_points': neg_points,
        })
        return self.shapes


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


@pytest.mark.parametrize('visual_fields', [{}, {'pos_points': [], 'neg_points': [], 'obj_bbox': []}])
def test_handler_routes_trimmed_text_prompt_to_multi_instance_shapes(visual_fields):
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    event = SimpleNamespace(body={
        'image': encode_image(),
        'text_prompt': '  red objects  ',
        **visual_fields,
    })

    response = main.handler(context, event)

    assert response.status_code == 200
    assert json.loads(response.body) == {'shapes': model.shapes}
    assert model.text_calls == [{'size': (2, 2), 'text_prompt': 'red objects'}]
    assert model.calls == model.concept_calls == model.refine_calls == []


def test_handler_returns_empty_shapes_for_no_text_matches():
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    model.shapes = []

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(), 'text_prompt': 'cat',
    }))

    assert response.status_code == 200
    assert json.loads(response.body) == {'shapes': []}


@pytest.mark.parametrize('text_prompt, error', [
    (None, 'string'),
    (123, 'string'),
    (['cat'], 'string'),
    ('', 'empty'),
    (' \t\n ', 'empty'),
    ('a' * 257, '256'),
])
def test_handler_rejects_invalid_text_before_decoding_image_or_inference(text_prompt, error):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={'text_prompt': text_prompt}))

    assert response.status_code == 400
    assert error in json.loads(response.body)['error']
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('visual_field, visual_prompt', [
    ('pos_points', [[1, 1]]),
    ('neg_points', [[1, 1]]),
    ('obj_bbox', [[0, 0], [1, 1]]),
])
def test_handler_rejects_mixed_text_and_visual_prompts(visual_field, visual_prompt):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'text_prompt': 'cat', visual_field: visual_prompt,
    }))

    assert response.status_code == 400
    assert 'points or a bounding box' in json.loads(response.body)['error']
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


def test_handler_accepts_256_characters_after_trimming():
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(), 'text_prompt': f'  {"a" * 256}  ',
    }))

    assert response.status_code == 200
    assert model.text_calls[0]['text_prompt'] == 'a' * 256


@pytest.mark.parametrize('shapes', [[], [{'type': 'mask', 'points': [0, 1, 0, 0, 0, 0], 'attributes': []}]])
def test_handler_dispatches_refinement_as_shapes(shapes):
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    model.shapes = shapes
    seed = [0, 1, 0, 0, 0, 0]
    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(), 'refinement_mask': seed,
        'pos_points': [[0, 0]], 'neg_points': [[1, 1]],
    }))
    assert response.status_code == 200
    assert json.loads(response.body) == {'shapes': shapes}
    assert model.refine_calls == [{
        'size': (2, 2), 'refinement_mask': seed,
        'pos_points': [[0, 0]], 'neg_points': [[1, 1]],
    }]
    assert model.calls == model.text_calls == model.concept_calls == []


@pytest.mark.parametrize('mixed_fields', [
    {'text_prompt': 'cat'}, {'text_prompt': ''}, {'text_prompt': None},
    {'obj_bbox': [[0, 0], [1, 1]]},
])
def test_handler_rejects_refinement_mixed_with_text_or_box_before_decoding(mixed_fields):
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    response = main.handler(context, SimpleNamespace(body={
        'refinement_mask': [0, 1, 0, 0, 0, 0], **mixed_fields,
    }))
    assert response.status_code == 400
    assert 'refinement' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('fields', [
    {'refinement_mask': None, 'pos_points': [[0, 0]]},
    {'refinement_mask': [0, 2, 0, 0, 0, 0], 'pos_points': [[0, 0]]},
    {'refinement_mask': [0, 1, 0, 0, 0, 0], 'pos_points': []},
    {'refinement_mask': [0, 1, 0, 0, 0, 0], 'pos_points': [[2, 1]]},
])
def test_handler_returns_400_for_model_refinement_validation_errors(fields):
    context = DummyContext()
    # Real validation must reject before a predictor or GPU is needed.
    context.user_data.model = main.ModelHandler.__new__(main.ModelHandler)
    response = main.handler(context, SimpleNamespace(body={'image': encode_image(), **fields}))
    assert response.status_code == 400
    assert json.loads(response.body)['error']


@pytest.mark.parametrize('obj_bbox', [None, []])
def test_refinement_accepts_empty_box_inserted_by_cvat_adapter(obj_bbox):
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(), 'refinement_mask': [0, 1, 0, 0, 0, 0],
        'pos_points': [[0, 0]], 'obj_bbox': obj_bbox,
    }))
    assert response.status_code == 200
    assert len(model.refine_calls) == 1


def test_explicit_single_object_routes_visual_prompts_to_interactive_handler():
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    visual_prompts = {
        'pos_points': [[0.25, 0.5]],
        'neg_points': [[1.0, 1.5]],
        'obj_bbox': [[0.0, 0.0], [2.0, 2.0]],
    }

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'prompt_mode': 'single_object',
        **visual_prompts,
    }))

    assert response.status_code == 200
    assert json.loads(response.body) == {'mask': [[1, 0], [0, 1]]}
    assert model.calls == [{'size': (2, 2), **visual_prompts}]
    assert model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('text_prompt', ['cat', '', None, 123])
def test_explicit_single_object_rejects_any_text_before_image_decode(text_prompt):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'prompt_mode': 'single_object',
        'text_prompt': text_prompt,
    }))

    assert response.status_code == 400
    assert 'text' in json.loads(response.body)['error'].lower()
    assert 'single-object' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize(('request_fields', 'expected_text', 'expected_box'), [
    ({'text_prompt': '  concrete surface  '}, 'concrete surface', None),
    ({'obj_bbox': [[0.0, 0.25], [1.5, 2.0]]}, None, [0.0, 0.25, 1.5, 2.0]),
    (
        {'text_prompt': '  concrete surface  ', 'obj_bbox': [[0.0, 0.25], [1.5, 2.0]]},
        'concrete surface',
        [0.0, 0.25, 1.5, 2.0],
    ),
])
def test_explicit_concept_routes_text_box_or_both_to_concept_handler(
    request_fields, expected_text, expected_box,
):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'prompt_mode': 'concept',
        **request_fields,
    }))

    assert response.status_code == 200
    assert json.loads(response.body) == {'shapes': model.shapes}
    assert model.concept_calls == [{
        'size': (2, 2),
        'text_prompt': expected_text,
        'exemplar_bbox': expected_box,
    }]
    assert model.calls == model.text_calls == model.refine_calls == []


@pytest.mark.parametrize('obj_bbox', [None, []])
def test_explicit_concept_treats_empty_box_as_absent(obj_bbox):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'prompt_mode': 'concept',
        'text_prompt': '  beam  ',
        'obj_bbox': obj_bbox,
    }))

    assert response.status_code == 200
    assert model.concept_calls == [{
        'size': (2, 2),
        'text_prompt': 'beam',
        'exemplar_bbox': None,
    }]
    assert model.calls == model.text_calls == model.refine_calls == []


@pytest.mark.parametrize('request_fields', [{}, {'obj_bbox': []}, {'obj_bbox': None}])
def test_explicit_concept_requires_text_or_nonempty_box_before_decode(request_fields):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'prompt_mode': 'concept',
        **request_fields,
    }))

    assert response.status_code == 400
    error = json.loads(response.body)['error'].lower()
    assert 'text prompt' in error
    assert 'bounding box' in error
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('text_prompt, error_fragment', [
    (None, 'string'),
    (123, 'string'),
    (['cat'], 'string'),
    ('', 'empty'),
    (' \t\n ', 'empty'),
    ('a' * 257, '256'),
])
def test_explicit_concept_rejects_invalid_text_before_decode(text_prompt, error_fragment):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'prompt_mode': 'concept',
        'text_prompt': text_prompt,
        'obj_bbox': [[0, 0], [1, 1]],
    }))

    assert response.status_code == 400
    assert error_fragment in json.loads(response.body)['error']
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('point_field', ['pos_points', 'neg_points'])
def test_explicit_concept_rejects_nonempty_points_before_decode(point_field):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'prompt_mode': 'concept',
        'text_prompt': 'beam',
        point_field: [[1, 1]],
    }))

    assert response.status_code == 400
    assert 'points' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('absent_points', [None, []])
def test_explicit_concept_allows_absent_point_arrays(absent_points):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'prompt_mode': 'concept',
        'text_prompt': 'beam',
        'pos_points': absent_points,
        'neg_points': absent_points,
    }))

    assert response.status_code == 200
    assert len(model.concept_calls) == 1
    assert model.calls == model.text_calls == model.refine_calls == []


@pytest.mark.parametrize('obj_bbox', [
    [0, 0, 1, 1],
    [[0, 0]],
    [[0, 0, 0], [1, 1]],
    'not-a-box',
])
def test_explicit_concept_rejects_malformed_nested_box_before_decode(obj_bbox):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'prompt_mode': 'concept',
        'obj_bbox': obj_bbox,
    }))

    assert response.status_code == 400
    assert 'bounding box' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


def test_explicit_concept_converts_adapter_value_error_to_400():
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    model.concept_error = 'Exemplar bounding box must have positive area inside the image'

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'prompt_mode': 'concept',
        'obj_bbox': [[1, 1], [1, 1]],
    }))

    assert response.status_code == 400
    assert json.loads(response.body) == {'error': model.concept_error}
    assert len(model.concept_calls) == 1
    assert model.calls == model.text_calls == model.refine_calls == []


@pytest.mark.parametrize('prompt_mode', ['single_object', 'concept'])
def test_refinement_accepts_explicit_prompt_mode(prompt_mode):
    context = DummyContext()
    model = context.user_data.model = DummyModel()
    seed = [0, 1, 0, 0, 0, 0]

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'prompt_mode': prompt_mode,
        'refinement_mask': seed,
        'pos_points': [[0, 0]],
    }))

    assert response.status_code == 200
    assert json.loads(response.body) == {'shapes': model.shapes}
    assert len(model.refine_calls) == 1
    assert model.calls == model.text_calls == model.concept_calls == []


@pytest.mark.parametrize(
    'prompt_mode', [None, '', 'text', 'find_similar', 'SINGLE_OBJECT', 1, []],
)
def test_invalid_explicit_prompt_mode_is_rejected_before_decode(prompt_mode):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={'prompt_mode': prompt_mode}))

    assert response.status_code == 400
    assert 'prompt mode' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('visual_fields', [
    {},
    {'pos_points': [[1, 1]]},
    {'neg_points': [[1, 1]]},
    {'obj_bbox': [[0, 0], [1, 1]]},
    {'pos_points': [], 'neg_points': [], 'obj_bbox': []},
])
def test_legacy_non_text_requests_remain_on_single_object_handler(visual_fields):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        **visual_fields,
    }))

    assert response.status_code == 200
    assert json.loads(response.body) == {'mask': [[1, 0], [0, 1]]}
    assert len(model.calls) == 1
    assert model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('point_field', ['pos_points', 'neg_points'])
@pytest.mark.parametrize('malformed_value', [{}, '', 0, False])
def test_explicit_concept_rejects_falsey_malformed_point_arrays_before_decode(
    point_field, malformed_value,
):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'prompt_mode': 'concept',
        'text_prompt': 'beam',
        point_field: malformed_value,
    }))

    assert response.status_code == 400
    assert 'points must be an array' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('point_field', ['pos_points', 'neg_points'])
@pytest.mark.parametrize('malformed_value', [{}, '', 0, False])
def test_refinement_rejects_falsey_malformed_point_arrays_before_decode(
    point_field, malformed_value,
):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'refinement_mask': [0, 1, 0, 0, 0, 0],
        point_field: malformed_value,
    }))

    assert response.status_code == 400
    assert 'points must be an array' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('point_field', ['pos_points', 'neg_points'])
@pytest.mark.parametrize('malformed_value', [{}, '', 0, False])
def test_legacy_single_object_rejects_falsey_malformed_point_arrays_before_decode(
    point_field, malformed_value,
):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={point_field: malformed_value}))

    assert response.status_code == 400
    assert 'points must be an array' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('malformed_value', [{}, '', 0, False])
@pytest.mark.parametrize('request_fields', [
    {'prompt_mode': 'concept', 'text_prompt': 'beam'},
    {'refinement_mask': [0, 1, 0, 0, 0, 0], 'pos_points': [[0, 0]]},
    {},
])
def test_all_routes_reject_falsey_malformed_boxes_before_decode(
    request_fields, malformed_value,
):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        **request_fields,
        'obj_bbox': malformed_value,
    }))

    assert response.status_code == 400
    assert 'bounding box' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


@pytest.mark.parametrize('coordinate', [
    None,
    '1',
    True,
    False,
    float('nan'),
    float('inf'),
    float('-inf'),
    10 ** 10_000,
], ids=['none', 'string', 'true', 'false', 'nan', 'inf', 'negative-inf', 'huge-int'])
def test_concept_rejects_non_finite_or_non_numeric_box_coordinates_before_decode(
    coordinate,
):
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'prompt_mode': 'concept',
        'obj_bbox': [[0, 0], [1, coordinate]],
    }))

    assert response.status_code == 400
    assert 'finite numeric' in json.loads(response.body)['error'].lower()
    assert model.calls == model.text_calls == model.concept_calls == model.refine_calls == []


def test_none_point_fields_are_normalized_as_absent_for_single_object():
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'obj_bbox': [[0, 0], [1, 1]],
        'pos_points': None,
        'neg_points': None,
    }))

    assert response.status_code == 200
    assert model.calls == [{
        'size': (2, 2),
        'pos_points': [],
        'neg_points': [],
        'obj_bbox': [[0, 0], [1, 1]],
    }]


def test_none_point_field_is_normalized_as_absent_for_refinement():
    context = DummyContext()
    model = context.user_data.model = DummyModel()

    response = main.handler(context, SimpleNamespace(body={
        'image': encode_image(),
        'refinement_mask': [0, 1, 0, 0, 0, 0],
        'pos_points': None,
        'neg_points': [[0, 0]],
    }))

    assert response.status_code == 200
    assert model.refine_calls == [{
        'size': (2, 2),
        'refinement_mask': [0, 1, 0, 0, 0, 0],
        'pos_points': [],
        'neg_points': [[0, 0]],
    }]
