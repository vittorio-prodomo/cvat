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

    mask = context.user_data.model.handle(
        image,
        pos_points=data.get('pos_points', []),
        neg_points=data.get('neg_points', []),
        obj_bbox=data.get('obj_bbox'),
    )

    return context.Response(
        body=json.dumps({'mask': mask}),
        headers={},
        content_type='application/json',
        status_code=200,
    )
