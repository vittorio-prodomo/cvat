import hashlib
import math
import os
from functools import partial
from pathlib import Path
from threading import Lock

import numpy as np


EXPECTED_CHECKPOINT_SIZE = 3_450_062_241
EXPECTED_CHECKPOINT_SHA256 = (
    '9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e'
)


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def verify_checkpoint(path: Path) -> None:
    if path.is_symlink():
        raise RuntimeError(f'SAM3 checkpoint is not a regular file: {path}')
    if not path.exists():
        raise RuntimeError(f'SAM3 checkpoint file does not exist: {path}')
    if not path.is_file():
        raise RuntimeError(f'SAM3 checkpoint is not a regular file: {path}')

    actual_size = path.stat().st_size
    if actual_size != EXPECTED_CHECKPOINT_SIZE:
        raise RuntimeError(
            f'SAM3 checkpoint size mismatch: expected {EXPECTED_CHECKPOINT_SIZE} bytes, '
            f'got {actual_size} bytes at {path}'
        )

    actual_sha256 = sha256_file(path)
    if actual_sha256 != EXPECTED_CHECKPOINT_SHA256:
        raise RuntimeError(
            f'SAM3 checkpoint SHA-256 mismatch: expected {EXPECTED_CHECKPOINT_SHA256}, '
            f'got {actual_sha256} at {path}'
        )


def checkpoint_from_environment() -> str:
    configured = os.environ.get('SAM3_CHECKPOINT_PATH')
    if not configured:
        raise RuntimeError(
            'SAM3_CHECKPOINT_PATH is required; mount the verified sam3.pt read-only'
        )

    checkpoint = Path(configured)
    verify_checkpoint(checkpoint)

    return str(checkpoint)


def mask_shape(mask, *, attributes):
    """Encode a binary image mask as CVAT tight-bounds, row-major RLE."""
    mask = np.asarray(mask, dtype=bool)
    rows, columns = np.nonzero(mask)
    if not columns.size:
        return None

    left, top, right, bottom = map(int, (
        columns.min(), rows.min(), columns.max(), rows.max(),
    ))
    pixels = mask[top:bottom + 1, left:right + 1].reshape(-1)
    changes = np.flatnonzero(pixels[1:] != pixels[:-1]) + 1
    counts = np.diff(np.concatenate(([0], changes, [pixels.size]))).tolist()
    if pixels[0]:
        counts.insert(0, 0)

    return {
        'type': 'mask',
        'points': [*counts, left, top, right, bottom],
        'attributes': attributes,
    }


def normalize_exemplar_bbox(exemplar_bbox, image_size):
    """Convert a clamped CVAT XYXY box to normalized CXCYWH coordinates."""
    if not isinstance(exemplar_bbox, (list, tuple)) or len(exemplar_bbox) != 4:
        raise ValueError(
            'Exemplar bounding box must contain four finite pixel coordinates'
        )
    if any(
        isinstance(value, bool) or not isinstance(value, (int, float))
        for value in exemplar_bbox
    ):
        raise ValueError(
            'Exemplar bounding box must contain four finite pixel coordinates'
        )
    try:
        coordinates = tuple(map(float, exemplar_bbox))
    except (TypeError, ValueError, OverflowError):
        raise ValueError(
            'Exemplar bounding box must contain four finite pixel coordinates'
        ) from None
    if any(not math.isfinite(value) for value in coordinates):
        raise ValueError(
            'Exemplar bounding box must contain four finite pixel coordinates'
        )

    width, height = image_size
    if width <= 0 or height <= 0:
        raise ValueError('Exemplar bounding box requires an image with positive dimensions')

    xtl, ytl, xbr, ybr = coordinates
    xtl = min(max(xtl, 0.0), width)
    xbr = min(max(xbr, 0.0), width)
    ytl = min(max(ytl, 0.0), height)
    ybr = min(max(ybr, 0.0), height)
    box_width = xbr - xtl
    box_height = ybr - ytl
    if box_width <= 0 or box_height <= 0:
        raise ValueError(
            'Exemplar bounding box must have positive area inside the image'
        )

    return [
        (xtl + xbr) / (2 * width),
        (ytl + ybr) / (2 * height),
        box_width / width,
        box_height / height,
    ]


def decode_refinement_mask(points, image_size):
    """Validate before allocating a mask or interpreting any untrusted run length."""
    if not isinstance(points, list) or len(points) < 5 or any(
        not isinstance(value, int) or isinstance(value, bool) for value in points
    ):
        raise ValueError('Refinement mask must be a flat integer RLE with a bounding box')

    counts, (left, top, right, bottom) = points[:-4], points[-4:]
    width, height = image_size
    if not (0 <= left <= right < width and 0 <= top <= bottom < height):
        raise ValueError('Refinement mask bounding box must be inside the image')
    if any(count < 0 for count in counts):
        raise ValueError('Refinement mask run lengths must be nonnegative')
    if sum(counts) != (right - left + 1) * (bottom - top + 1):
        raise ValueError('Refinement mask run lengths must exactly fill the bounding box')
    if not sum(counts[1::2]):
        raise ValueError('Refinement mask must contain foreground pixels')

    pixels = np.repeat(np.arange(len(counts)) % 2, counts).astype(bool)
    mask = np.zeros((height, width), dtype=bool)
    mask[top:bottom + 1, left:right + 1] = pixels.reshape(
        bottom - top + 1, right - left + 1,
    )
    return mask


def refinement_points(pos_points, neg_points, image_size):
    for name, points in (('Positive', pos_points), ('Negative', neg_points)):
        if not isinstance(points, list):
            raise ValueError(f'{name} points must be an array of coordinate pairs')
        for point in points:
            if not isinstance(point, list) or len(point) != 2 or any(
                isinstance(value, bool) or not isinstance(value, (int, float))
                or not 0 <= value < bound or not math.isfinite(value)
                for value, bound in zip(point, image_size)
            ):
                raise ValueError(f'{name} points must be finite coordinate pairs inside the image')
    if not pos_points and not neg_points:
        raise ValueError('Mask refinement requires at least one point')
    return (
        np.asarray([*pos_points, *neg_points], dtype=np.float32),
        np.asarray([1] * len(pos_points) + [0] * len(neg_points), dtype=np.int32),
    )


class ModelHandler:
    def __init__(self):
        checkpoint_path = checkpoint_from_environment()

        import torch
        from sam3.model.sam3_image_processor import Sam3Processor
        from sam3.model_builder import build_sam3_image_model

        if not torch.cuda.is_available():
            raise RuntimeError('SAM3 interactor requires an NVIDIA GPU with CUDA support')

        model = build_sam3_image_model(
            device='cuda',
            checkpoint_path=checkpoint_path,
            load_from_HF=False,
            enable_inst_interactivity=True,
        )
        predictor = model.inst_interactive_predictor
        if predictor is None:
            raise RuntimeError('SAM3 image model did not expose an interactive predictor')

        if getattr(predictor.model, 'backbone', None) is None:
            predictor.model.backbone = model.backbone

        self._inference_lock = Lock()
        # SAM3's constructor enables autocast only on its own thread. Requests
        # may run on another thread, so enter a new precision context per call.
        self._autocast = partial(torch.autocast, device_type='cuda', dtype=torch.bfloat16)
        self.model = model
        self.predictor = predictor
        self.processor = Sam3Processor(model, confidence_threshold=0.2)

    @staticmethod
    def _processor_predictions(output):
        masks = output['masks'].detach().cpu().numpy()[:, 0]
        scores = output['scores'].detach().float().cpu().numpy()
        return masks, scores

    @staticmethod
    def _concept_shapes(masks, scores):
        shapes = []
        for mask, score in zip(masks, scores):
            shape = mask_shape(
                mask,
                attributes=[{'spec_id': 0, 'value': str(float(score))}],
            )
            if shape is not None:
                shapes.append(shape)
        return shapes

    def handle_text(self, image, *, text_prompt):
        with self._inference_lock, self._autocast():
            state = self.processor.set_image(image)
            output = self.processor.set_text_prompt(prompt=text_prompt.strip(), state=state)
            masks, scores = self._processor_predictions(output)

        return self._concept_shapes(masks, scores)

    def handle_concept(self, image, *, text_prompt=None, exemplar_bbox=None):
        if text_prompt is not None and not isinstance(text_prompt, str):
            raise ValueError('Concept text prompt must be a string')
        prompt = text_prompt.strip() if text_prompt is not None else ''

        normalized_box = None
        exemplar_is_empty = isinstance(exemplar_bbox, list) and not exemplar_bbox
        if exemplar_bbox is not None and not exemplar_is_empty:
            normalized_box = normalize_exemplar_bbox(exemplar_bbox, image.size)

        if not prompt and normalized_box is None:
            raise ValueError(
                'SAM3 concept inference requires a text prompt or an exemplar bounding box'
            )

        # Keep the existing text-only path exact, including its processor output
        # conversion and confidence attribute format.
        if normalized_box is None:
            return self.handle_text(image, text_prompt=prompt)

        with self._inference_lock, self._autocast():
            state = self.processor.set_image(image)
            if prompt:
                self.processor.set_text_prompt(prompt=prompt, state=state)
            output = self.processor.add_geometric_prompt(
                box=normalized_box,
                label=True,
                state=state,
            )
            masks, scores = self._processor_predictions(output)

        return self._concept_shapes(masks, scores)

    def handle_refine(self, image, *, refinement_mask, pos_points, neg_points):
        seed = decode_refinement_mask(refinement_mask, image.size)
        point_coords, point_labels = refinement_points(pos_points, neg_points, image.size)

        # A click on a distinctive part can select that part instead of the whole
        # object even with mask guidance. Anchor the selected object's extent,
        # allowing positive points to extend it. RLE bounds are pixel-inclusive.
        box = np.asarray(refinement_mask[-4:], dtype=np.float32)
        box[2:] += 1
        if pos_points:
            positives = point_coords[:len(pos_points)]
            box[:2] = np.minimum(box[:2], positives.min(axis=0))
            box[2:] = np.maximum(box[2:], positives.max(axis=0))

        import torch
        from torch.nn.functional import interpolate

        # SAM3 resizes the complete image to its square input. Match that transform
        # for the mask, preserving negative background logits outside the seed bbox.
        # A soft +/-1 prior lets clicks correct the binary seed; saturated logits
        # can override negative clicks that fall inside the original mask.
        logits = torch.from_numpy(seed).to(dtype=torch.float32) * 2 - 1
        mask_input = interpolate(
            logits[None, None],
            size=self.predictor.model.sam_prompt_encoder.mask_input_size,
            mode='bilinear',
            align_corners=False,
        )[0].numpy()

        # Float32 prompt coordinates can round a fractional edge click up to the
        # image boundary. Sample its last valid pixel when checking agreement.
        click_x, click_y = np.minimum(
            point_coords.astype(np.intp), np.asarray(image.size) - 1,
        ).T

        def disagreements(mask):
            return np.count_nonzero(mask[click_y, click_x] != point_labels)

        # The predictor caches image features. Serialize the image/predict pair,
        # but retain no seed or click history between these self-contained requests.
        with self._inference_lock, self._autocast():
            self.predictor.set_image(np.array(image))
            masks, _, _ = self.predictor.predict(
                point_coords=point_coords,
                point_labels=point_labels,
                box=box,
                mask_input=mask_input,
                multimask_output=False,
                return_logits=False,
            )
            # Extent guidance can overpower a correction or an extension. Retry
            # without the box only when a user click is missed, reusing the same
            # image features, seed, and points. Prefer explicit corrections; keep
            # the anchored result when relaxing the extent does not help.
            missed = disagreements(masks[0])
            if missed:
                relaxed_masks, _, _ = self.predictor.predict(
                    point_coords=point_coords,
                    point_labels=point_labels,
                    box=None,
                    mask_input=mask_input,
                    multimask_output=False,
                    return_logits=False,
                )
                if disagreements(relaxed_masks[0]) < missed:
                    masks = relaxed_masks
        shape = mask_shape(masks[0], attributes=[])
        return [shape] if shape is not None else []

    def handle(self, image, *, pos_points, neg_points, obj_bbox):
        if not pos_points and not neg_points and not obj_bbox:
            raise ValueError('SAM3 interactor requires at least one point or a bounding box')

        point_coords = None
        point_labels = None
        if pos_points or neg_points:
            point_coords = np.array([*pos_points, *neg_points], dtype=np.float32)
            point_labels = np.array(
                [1] * len(pos_points) + [0] * len(neg_points),
                dtype=np.int32,
            )

        box = None
        if obj_bbox:
            box = np.array(
                [obj_bbox[0][0], obj_bbox[0][1], obj_bbox[1][0], obj_bbox[1][1]],
                dtype=np.float32,
            )

        with self._inference_lock, self._autocast():
            self.predictor.set_image(np.array(image))
            masks, scores, _ = self.predictor.predict(
                point_coords=point_coords,
                point_labels=point_labels,
                box=box,
                multimask_output=True,
                return_logits=False,
            )

        best_index = int(np.argmax(scores))
        return masks[best_index].astype(np.uint8).tolist()
