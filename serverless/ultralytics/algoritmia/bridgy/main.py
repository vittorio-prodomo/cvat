import base64
import io
from PIL import Image
from ultralytics import YOLO
import json
from sahi import AutoDetectionModel
from sahi.predict import get_sliced_prediction
import numpy as np
import sahi.models.ultralytics
import torch
import cv2
import supervision as sv
from skimage import measure
from typing import Optional, List
from ultralytics.engine.results import Results
from skimage.measure import approximate_polygon, find_contours


def sahi_to_ultralytics_results(sahi_result, model_names: Optional[List[str]] = None, device: str = "cuda") -> Results:
    """
    Convert SAHI PredictionResult to Ultralytics Results format.

    Args:
        sahi_result: SAHI PredictionResult object
        model_names: List of class names (if None, uses category names from predictions)
        device: Device for tensors ('cpu' or 'cuda')

    Returns:
        Ultralytics Results object (or Results-like object)
    """

    object_predictions = sahi_result.object_prediction_list
    image = sahi_result.image

    # Get image dimensions
    if isinstance(image, Image.Image):
        img_height, img_width = image.size[1], image.size[0]
        img_array = np.array(image)
    else:
        img_height, img_width = image.shape[:2]
        img_array = image

    # Prepare containers
    boxes_data = []
    masks_data = []
    has_masks = False

    # Extract class names if not provided
    if model_names is None:
        unique_categories = set()
        for pred in object_predictions:
            unique_categories.add(pred.category.name)
        model_names = list(unique_categories)
        # Create mapping from category name to index
        name_to_idx = {name: idx for idx, name in enumerate(model_names)}
    else:
        name_to_idx = {name: idx for idx, name in enumerate(model_names)}

    # Process each prediction
    for pred in object_predictions:
        # Get bounding box in xyxy format
        bbox = pred.bbox.to_xyxy()  # [x1, y1, x2, y2]

        # Get class index
        if pred.category.name in name_to_idx:
            class_idx = name_to_idx[pred.category.name]
        else:
            # If category not in provided names, use category.id or add to names
            if hasattr(pred.category, "id") and pred.category.id < len(model_names):
                class_idx = pred.category.id
            else:
                # Add new category
                model_names.append(pred.category.name)
                class_idx = len(model_names) - 1
                name_to_idx[pred.category.name] = class_idx

        # Create box data: [x1, y1, x2, y2, confidence, class]
        box_data = bbox + [pred.score.value, class_idx]
        boxes_data.append(box_data)

        # Handle masks if present
        if pred.mask is not None:
            has_masks = True
            # Convert mask to the format expected by Ultralytics
            bool_mask = pred.mask.bool_mask
            # Ensure mask is the right size
            if bool_mask.shape != (img_height, img_width):
                # Resize if needed (this shouldn't normally happen)
                import cv2

                bool_mask = cv2.resize(bool_mask.astype(np.uint8), (img_width, img_height)).astype(bool)
            masks_data.append(bool_mask)

    # Convert to tensors
    device = torch.device(device)

    if boxes_data:
        boxes_tensor = torch.tensor(boxes_data, dtype=torch.float32).to(device)
    else:
        boxes_tensor = torch.zeros((0, 6), dtype=torch.float32).to(device)

    if has_masks and masks_data:
        masks_tensor = torch.tensor(np.stack(masks_data), dtype=torch.bool).to(device)
    else:
        masks_tensor = None

    # Create Boxes object
    # boxes_obj = Boxes(boxes_tensor, (img_height, img_width))

    # Create Results object
    # Note: This is simplified - real Results objects have more attributes
    orig_img = img_array if img_array.ndim == 3 else np.stack([img_array] * 3, axis=-1)

    results = Results(
        orig_img=orig_img,
        path=None,  # SAHI doesn't preserve original path
        names=model_names,
        boxes=boxes_tensor,
        masks=masks_tensor,
    )

    return results


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


def init_context(context):
    context.logger.info("Initializing context...")
    model_path = "/data/runs/segment/yolo11l-seg/the200_tiled320_small_classes_minus_effl/imgsz_320/cls_all/sgd/lr_0.001_lrf0.01/coco_pretrained_google_style/weights/best.pt"

    if torch.cuda.is_available():
        context.logger.info("GPU is available...")
        device = "cuda:0"
    else:
        context.logger.info("GPU is not available! Falling back to CPU...")
        device = "cpu"

    context.logger.info(f"Using device: {device}")
    context.logger.info("Loading model...")
    # Load SAHI model for instance segmentation with enhanced inference
    context.user_data.model = AutoDetectionModel.from_pretrained(
        model_type="ultralytics",
        model_path=model_path,
        device=device,
        load_at_init=True,
    )
    # context.user_data.model = YOLO(model_path)

    context.logger.info("Model loaded successfully.")


def handler(context, event):
    context.logger.info("Processing image...")
    data = event.body
    image_data = base64.b64decode(data["image"])
    threshold = float(data.get("threshold", 0.3))
    context.user_data.model.confidence_threshold = threshold
    image = Image.open(io.BytesIO(image_data))  # .convert("RGB")
    context.logger.info("Starting prediction on image...")

    # SAHI-powered sliced inference for instance segmentation
    image = np.array(image)
    result = get_sliced_prediction(
        image,
        context.user_data.model,
        perform_standard_pred=False,
        slice_height=320,
        slice_width=320,
        overlap_height_ratio=0.5,
        overlap_width_ratio=0.5,
        verbose=2,
    )
    context.logger.info(f"Prediction completed!")
    context.logger.info(f"Analysing results...")
    yolo_results = sahi_to_ultralytics_results(result, device="cuda")
    labels = yolo_results.names
    detections = sv.Detections.from_ultralytics(yolo_results)
    merged_detections = []
    class_names = detections["class_name"]

    for class_name in context.user_data.model.category_mapping.values():
        # Get indices for this class
        class_indices = np.where(class_names == class_name)[0]
        class_boxes = detections.xyxy[class_indices]
        class_confidence = detections.confidence[class_indices]
        class_masks = detections.mask[class_indices] if detections.mask is not None else None

        # Initialize clusters with the first detection
        clusters = []
        cluster_confidences = []
        cluster_boxes = []
        cluster_masks = []

        # Process each detection for this class
        for i in range(len(class_indices)):
            box = class_boxes[i]
            conf = class_confidence[i]
            mask = class_masks[i] if class_masks is not None else None

            merged = False
            for j in range(len(clusters)):
                # Check if boxes overlap
                if sv.box_iou_batch(box.reshape(1, 4), cluster_boxes[j].reshape(1, 4))[0][0] > 0:
                    # Merge detection with this cluster
                    clusters[j].append(class_indices[i])
                    cluster_confidences[j].append(conf)
                    # Update cluster bounding box to encompass both
                    cluster_boxes[j] = np.array(
                        [
                            min(box[0], cluster_boxes[j][0]),
                            min(box[1], cluster_boxes[j][1]),
                            max(box[2], cluster_boxes[j][2]),
                            max(box[3], cluster_boxes[j][3]),
                        ]
                    )
                    # Merge masks if available
                    if mask is not None and cluster_masks[j] is not None:
                        cluster_masks[j] = np.logical_or(mask, cluster_masks[j])
                    merged = True
                    break

            if not merged:
                # Create new cluster
                clusters.append([class_indices[i]])
                cluster_confidences.append([conf])
                cluster_boxes.append(box)
                cluster_masks.append(mask)

        # Create merged detections for each cluster
        for i in range(len(clusters)):
            avg_conf = np.mean(cluster_confidences[i])
            merged_detections.append(
                {
                    "xyxy": cluster_boxes[i],
                    "confidence": avg_conf,
                    "class_id": detections.class_id[clusters[i][0]],
                    "class_name": class_name,
                    "mask": cluster_masks[i],
                }
            )

    # Create new Detections object from merged detections
    if merged_detections:
        # Prepare arrays for the new Detections object
        xyxy = np.array([d["xyxy"] for d in merged_detections])
        confidence = np.array([d["confidence"] for d in merged_detections])
        class_id = np.array([d["class_id"] for d in merged_detections])
        class_name = np.array([d["class_name"] for d in merged_detections])

        # Handle masks if they exist
        if detections.mask is not None and merged_detections[0]["mask"] is not None:
            masks = np.array([d["mask"] for d in merged_detections])
        else:
            masks = None

        # Create new Detections object
        detections = sv.Detections(
            xyxy=xyxy, confidence=confidence, class_id=class_id, mask=masks, data={"class_name": class_name}
        )
    results = []
    if len(detections) > 0:
        for i in range(len(detections)):
            xyxy = detections.xyxy[i]
            mask = detections.mask[i]
            confidence = detections.confidence[i]
            class_id = detections.class_id[i]

            mask = mask.astype(np.uint8)

            xtl = int(xyxy[0])
            ytl = int(xyxy[1])
            xbr = int(xyxy[2])
            ybr = int(xyxy[3])

            label = int(class_id)
            cvat_mask = to_cvat_mask((xtl, ytl, xbr, ybr), mask)

            # contours = find_contours(mask, 0.5)
            # contour = contours[0]
            # contour = np.flip(contour, axis=1)
            # polygons = approximate_polygon(contour, tolerance=2.5)

            results.append(
                {
                    "confidence": str(confidence),
                    "label": labels[class_id] if 0 <= class_id < len(labels) else "unknown",
                    "type": "mask",
                    # "points": polygons.ravel().tolist(),
                    "mask": cvat_mask,
                }
            )
    context.logger.info(f"Results analysed!")
    context.logger.info(f"Returning results...")
    return context.Response(body=json.dumps(results), headers={}, content_type="application/json", status_code=200)
