import base64
import io
import json

from PIL import Image

from model_handler import ModelHandler


def init_context(context):
    context.logger.info('Init context...  0%')
    context.user_data.model = ModelHandler(logger=context.logger)
    context.logger.info('Init context...100%')


def handler(context, event):
    data = event.body
    buf = io.BytesIO(base64.b64decode(data['image']))
    image = Image.open(buf).convert('RGB')
    obj_bbox = data.get('obj_bbox')
    mapping = data.get('mapping', {})
    confidence_threshold = data.get('confidence_threshold')

    context.logger.info(
        'RF-DETR shape request summary: '
        f'image_size={image.size} '
        f'bbox={obj_bbox} '
        f'mapping_keys={len(mapping)} '
        f'mapping_labels={sorted(mapping.keys())}'
    )

    shapes = context.user_data.model.handle(
        image=image,
        obj_bbox=obj_bbox,
        mapping=mapping,
        confidence_threshold=confidence_threshold,
    )

    context.logger.info(
        'RF-DETR shape response summary: '
        f'returned_shapes={len(shapes)}'
    )

    return context.Response(
        body=json.dumps({'shapes': shapes}),
        headers={},
        content_type='application/json',
        status_code=200,
    )
