"""Nuclio entry point for the Indoor v3 standard CVAT detector."""

import base64
import binascii
import io
import json
import warnings

from PIL import Image, UnidentifiedImageError

from model_handler import ModelHandler, validate_threshold


def init_context(context):
    context.logger.info("Initializing Indoor v3")
    context.user_data.model = ModelHandler(logger=context.logger)
    context.logger.info("Indoor v3 initialization complete")


def parse_request(body):
    if isinstance(body, (str, bytes, bytearray)):
        try:
            body = json.loads(body)
        except (ValueError, UnicodeError) as exc:
            raise ValueError("Request body must be a JSON object") from exc
    if not isinstance(body, dict):
        raise ValueError("Request body must be a JSON object")
    threshold = validate_threshold(body.get("threshold"))
    encoded = body.get("image")
    if not isinstance(encoded, str) or not encoded:
        raise ValueError("image must be a nonempty base64 encoded image")
    try:
        payload = base64.b64decode(encoded, validate=True)
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(payload)) as source:
                image = source.convert("RGB")
                image.load()
    except (ValueError, binascii.Error, OSError, UnidentifiedImageError,
            Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise ValueError("image must be a valid base64 encoded image") from exc
    return image, threshold


def response(context, body, status_code):
    return context.Response(
        body=body,
        headers={},
        content_type="application/json",
        status_code=status_code,
    )


def handler(context, event):
    try:
        image, threshold = parse_request(event.body)
    except ValueError as exc:
        return response(context, json.dumps({"error": str(exc)}), 400)

    with image:
        context.logger.info(f"Indoor request: image_size={image.size} threshold={threshold}")
        try:
            annotations = context.user_data.model.handle(image=image, threshold=threshold)
            body = json.dumps(annotations, allow_nan=False)
        except Exception as exc:
            context.logger.error(f"Indoor inference failed: {type(exc).__name__}: {exc}")
            return response(context, json.dumps({"error": "Indoor inference failed"}), 500)
    context.logger.info(f"Indoor response: detections={len(annotations)}")
    return response(context, body, 200)
