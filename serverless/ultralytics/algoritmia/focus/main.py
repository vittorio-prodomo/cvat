import base64
import io
from PIL import Image
from ultralytics import YOLO
import json
import numpy as np
import torch
import cv2
import supervision as sv
import time
from skimage import measure
from typing import Optional, List, Callable, Any, Dict
from ultralytics.engine.results import Results
from skimage.measure import approximate_polygon, find_contours


def to_cvat_mask(box: list, mask):
    xtl, ytl, xbr, ybr = box
    flattened = mask[ytl : ybr + 1, xtl : xbr + 1].flat[:].tolist()
    flattened.extend([xtl, ytl, xbr, ybr])
    return flattened


def encode_mask(bitmap, bbox):
    """
    Encodes an image mask into an array of numbers suitable for CVAT mask format.

    Args:
        bitmap: Boolean numpy array of shape (H, W)
        bbox: List [x1, y1, x2, y2] defining the bounding box

    Returns:
        List of encoded mask values plus bounding box coordinates
    """
    import math

    bitmap = np.asanyarray(bitmap)
    if bitmap.ndim != 2:
        raise ValueError("bitmap must have 2 dimensions")
    if bitmap.dtype != np.bool_:
        raise ValueError("bitmap must have boolean items")

    x1, y1 = map(math.floor, bbox[0:2])
    x2, y2 = map(math.ceil, bbox[2:4])

    if not (0 <= x1 < x2 <= bitmap.shape[1] and 0 <= y1 < y2 <= bitmap.shape[0]):
        raise ValueError("bbox has invalid coordinates")

    flat = bitmap[y1:y2, x1:x2].ravel()

    (run_indices,) = np.diff(flat, prepend=[not flat[0]], append=[not flat[-1]]).nonzero()
    if flat[0]:
        run_lengths = np.diff(run_indices, prepend=[0])
    else:
        run_lengths = np.diff(run_indices)

    return run_lengths.tolist() + [x1, y1, x2 - 1, y2 - 1]


def _extract_class_names(
    model: YOLO,
    results: Optional[Any] = None,
    class_names: Optional[Dict[int, str]] = None,
) -> Dict[int, str]:
    """
    Extract class names using the fallback chain:
    1. External class_names dict (if provided)
    2. model.names from Ultralytics model
    3. results.names from inference results
    4. String representation of class_id as fallback

    Args:
        model: Ultralytics YOLO model
        results: Optional results object from inference
        class_names: Optional external class name mapping

    Returns:
        Dict mapping class_id to class name
    """
    if class_names is not None:
        return class_names

    # Try model.names
    if hasattr(model, "names") and model.names is not None:
        return model.names

    # Try results.names
    if results is not None and hasattr(results, "names") and results.names is not None:
        return results.names

    # Fallback: return empty dict, will use string(class_id) later
    return {}

def inference_callback(
    model: YOLO,
    conf: float = 0.5,
    iou: float = 0.7,
    classes: Optional[List[int]] = None,
) -> Callable[[np.ndarray], sv.Detections]:
    def _inference_callback(image_slice: np.ndarray) -> sv.Detections:

        # Normal inference for non-background tiles
        results = model.predict(
            image_slice,
            verbose=False,
            conf=conf,
            iou=iou,
            retina_masks=True,
            device="cuda:0",
        )
        return sv.Detections.from_ultralytics(results[0])

    return _inference_callback

def init_context(context):
    context.logger.info("Initializing context...")
    model_path = "/data/best_so_far.pt"

    if torch.cuda.is_available():
        context.logger.info("GPU is available...")
        device = "cuda:0"
    else:
        context.logger.info("GPU is not available! Falling back to CPU...")
        device = "cpu"

    context.logger.info(f"Using device: {device}")
    context.logger.info("Loading model...")
    # Load YOLO model for instance segmentation with enhanced inference
    model = YOLO(model_path)
    class_names = _extract_class_names(model)
    context.logger.info(f"Class names: {class_names}")
    context.user_data.model = model

    context.logger.info("Model loaded successfully.")


class InferenceParams:
    slice_wh_width = 1024
    slice_wh_height = 1024
    inference_iou = 0.8
    slicer_iou = 0.01
    overlap_w = 480
    overlap_h = 480
    overlap_filter = "NON_MAX_MERGE"
    overlap_metric = "IOU"

def handler(context, event):
    context.logger.info("Processing image...")
    data = event.body
    # context.logger.info("Event data: " + json.dumps(data, indent=2))
    image_data = base64.b64decode(data["image"])
    threshold = str(data.get("threshold", "0.04,0.3"))
    context.logger.info(f"Raw Threshold: {threshold}")
    threshold = threshold.split(",")
    threshold = [float(t) for t in threshold]
    context.logger.info(f"Threshold: {threshold}")
    image = Image.open(io.BytesIO(image_data))  # .convert("RGB")
    context.logger.info("Starting prediction on image...")
    params = InferenceParams()

    # SAHI-powered sliced inference for instance segmentation
    image = np.array(image)
    # result = get_sliced_prediction(
    #     image,
    #     context.user_data.model,
    #     perform_standard_pred=False,
    #     slice_height=320,
    #     slice_width=320,
    #     overlap_height_ratio=0.5,
    #     overlap_width_ratio=0.5,
    #     verbose=2,
    # )

    slicer = sv.InferenceSlicer(
            callback=inference_callback(
                model=context.user_data.model,
                conf=min(threshold),
                iou=params.inference_iou,
                classes=[0, 2],
            ),
            slice_wh=(params.slice_wh_width, params.slice_wh_width),
            overlap_wh=(params.overlap_w, params.overlap_h),
            overlap_filter=params.overlap_filter,
            overlap_metric=params.overlap_metric,
            iou_threshold=params.slicer_iou,
            thread_workers=1,
        )

    # Perform first sliced inference
    context.logger.info("Running first sliced inference...")
    detections = slicer(image)

    context.logger.info(f"Prediction completed!")
    context.logger.info(f"Analysing results...")

    labels = detections["class_name"]

    results = []
    if len(detections) > 0:
        for i in range(len(detections)):
            xyxy = detections.xyxy[i]
            mask = detections.mask[i]
            confidence = detections.confidence[i]
            class_id = detections.class_id[i]
            if class_id == 2:
                class_id = 1
            if confidence < threshold[class_id]:
                continue

            mask = mask.astype(np.uint8)

            xtl = int(xyxy[0])
            ytl = int(xyxy[1])
            xbr = int(xyxy[2])
            ybr = int(xyxy[3])

            cvat_mask = to_cvat_mask((xtl, ytl, xbr, ybr), mask)

            # contours = find_contours(mask, 0.5)
            # contour = contours[0]
            # contour = np.flip(contour, axis=1)
            # polygons = approximate_polygon(contour, tolerance=2.5)

            results.append(
                {
                    "confidence": str(confidence),
                    "label": str(labels[i]),
                    "type": "mask",
                    # "points": polygons.ravel().tolist(),
                    "mask": cvat_mask,
                    "attributes": [{"name": "confidence", "value": str(round(confidence, 2))}]
                }
            )
    context.logger.info(f"Results analysed!")
    context.logger.info(f"Returning results...")
    return context.Response(body=json.dumps(results), headers={}, content_type="application/json", status_code=200)
