import base64
import io
import json
import math

from PIL import Image

from model_handler import ModelHandler


PROMPT_MODES = ('single_object', 'concept')


def init_context(context):
    context.logger.info('Init context...  0%')
    context.user_data.model = ModelHandler()
    context.logger.info('Init context...100%')


def error_response(context, error):
    return context.Response(
        body=json.dumps({'error': str(error)}),
        headers={},
        content_type='application/json',
        status_code=400,
    )


def validate_text_prompt(text_prompt):
    if not isinstance(text_prompt, str):
        raise ValueError('Text prompt must be a string')

    text_prompt = text_prompt.strip()
    if not text_prompt:
        raise ValueError('Text prompt must not be empty')
    if len(text_prompt) > 256:
        raise ValueError('Text prompt must contain at most 256 characters')

    return text_prompt


def validate_point_array(data, name):
    points = data.get(name)
    if points is None:
        return []
    if not isinstance(points, list):
        label = 'Positive' if name == 'pos_points' else 'Negative'
        raise ValueError(f'{label} points must be an array')
    return points


def flatten_exemplar_bbox(obj_bbox):
    if obj_bbox is None or isinstance(obj_bbox, list) and len(obj_bbox) == 0:
        return None
    if (
        not isinstance(obj_bbox, list) or len(obj_bbox) != 2
        or any(not isinstance(point, list) or len(point) != 2 for point in obj_bbox)
    ):
        raise ValueError('Exemplar bounding box must contain two coordinate pairs')

    coordinates = [*obj_bbox[0], *obj_bbox[1]]
    for coordinate in coordinates:
        if isinstance(coordinate, bool) or not isinstance(coordinate, (int, float)):
            raise ValueError('Exemplar bounding box must contain four finite numeric coordinates')
        try:
            finite = math.isfinite(coordinate)
        except OverflowError:
            finite = False
        if not finite:
            raise ValueError('Exemplar bounding box must contain four finite numeric coordinates')

    return coordinates


def handler(context, event):
    data = event.body
    prompt_mode_provided = 'prompt_mode' in data
    prompt_mode = data.get('prompt_mode')
    if prompt_mode_provided and (
        not isinstance(prompt_mode, str) or prompt_mode not in PROMPT_MODES
    ):
        return error_response(
            context,
            'Prompt mode must be single_object or concept',
        )

    try:
        pos_points = validate_point_array(data, 'pos_points')
        neg_points = validate_point_array(data, 'neg_points')
        exemplar_bbox = flatten_exemplar_bbox(data.get('obj_bbox'))
    except ValueError as error:
        return error_response(context, error)

    refining = 'refinement_mask' in data
    if refining and ('text_prompt' in data or exemplar_bbox is not None):
        return error_response(context, 'Mask refinement cannot be combined with text or a bounding box')

    if prompt_mode == 'single_object' and 'text_prompt' in data:
        return error_response(context, 'Text is not allowed in single-object prompt mode')

    text_prompt = None
    if 'text_prompt' in data:
        try:
            text_prompt = validate_text_prompt(data['text_prompt'])
        except ValueError as error:
            return error_response(context, error)

    if not refining and prompt_mode == 'concept':
        if len(pos_points) > 0 or len(neg_points) > 0:
            return error_response(
                context,
                'Concept inference cannot be combined with points',
            )
        if text_prompt is None and exemplar_bbox is None:
            return error_response(
                context,
                'Concept inference requires a text prompt or an exemplar bounding box',
            )
    elif text_prompt is not None and (
        len(pos_points) > 0 or len(neg_points) > 0 or exemplar_bbox is not None
    ):
        return error_response(
            context,
            'Text prompt cannot be combined with points or a bounding box',
        )

    buf = io.BytesIO(base64.b64decode(data['image']))
    image = Image.open(buf).convert('RGB')

    if refining:
        try:
            shapes = context.user_data.model.handle_refine(
                image,
                refinement_mask=data['refinement_mask'],
                pos_points=pos_points,
                neg_points=neg_points,
            )
        except ValueError as error:
            return error_response(context, error)
        result = {'shapes': shapes}
    elif prompt_mode == 'concept':
        try:
            shapes = context.user_data.model.handle_concept(
                image,
                text_prompt=text_prompt,
                exemplar_bbox=exemplar_bbox,
            )
        except ValueError as error:
            return error_response(context, error)
        result = {'shapes': shapes}
    elif text_prompt is not None:
        result = {'shapes': context.user_data.model.handle_text(image, text_prompt=text_prompt)}
    else:
        result = {'mask': context.user_data.model.handle(
            image,
            pos_points=pos_points,
            neg_points=neg_points,
            obj_bbox=data.get('obj_bbox'),
        )}

    return context.Response(
        body=json.dumps(result),
        headers={},
        content_type='application/json',
        status_code=200,
    )
