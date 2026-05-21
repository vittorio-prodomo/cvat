import base64
import io
import json

from PIL import Image

from model_handler import ModelHandler


def init_context(context):
    context.logger.info('Init context...  0%')
    context.user_data.model = ModelHandler()
    context.logger.info('Init context...100%')


def handler(context, event):
    data = event.body
    buf = io.BytesIO(base64.b64decode(data['image']))
    image = Image.open(buf).convert('RGB')
    shapes = context.user_data.model.handle(
        image=image,
        obj_bbox=data.get('obj_bbox'),
        mapping=data.get('mapping', {}),
    )

    return context.Response(
        body=json.dumps({'shapes': shapes}),
        headers={},
        content_type='application/json',
        status_code=200,
    )
