import math
import logging
import os
from pathlib import Path

from rfdetr_backend import RFDETRShapeBackend
from postprocess import (
    PredictedInstance,
    apply_class_aware_ios_nms,
    clip_mask_to_valid_region,
    mask_to_rle,
    prepare_crop,
    project_mask_to_image,
)

LOGGER = logging.getLogger(__name__)


def validate_confidence_threshold(confidence_threshold, env_default):
    """Validate request-level confidence_threshold.
    
    Args:
        confidence_threshold: Request-level threshold (None or numeric)
        env_default: Fallback threshold from environment
    
    Returns:
        Effective threshold to use
    
    Raises:
        ValueError: If threshold is malformed or out of range
    """
    if confidence_threshold is None:
        return env_default
    
    # Validate numeric type
    if not isinstance(confidence_threshold, (int, float)):
        raise ValueError(
            f'confidence_threshold must be a number, got {type(confidence_threshold).__name__}'
        )

    if not math.isfinite(confidence_threshold):
        raise ValueError(
            f'confidence_threshold must be finite, got {confidence_threshold}'
        )
    
    # Validate range
    if confidence_threshold < 0.05 or confidence_threshold > 0.99:
        raise ValueError(
            f'confidence_threshold must be between 0.05 and 0.99, got {confidence_threshold}'
        )
    
    return float(confidence_threshold)


class ModelHandler:
    def __init__(self, *, logger=None):
        input_size = int(os.environ.get('MODEL_INPUT_SIZE', '504'))
        self.env_conf_threshold = float(os.environ.get('MODEL_CONF_THRESHOLD', '0.2'))
        
        # Wire manifest-configured checkpoint and config paths from env
        checkpoint_dir = os.environ.get('CHECKPOINT_DIR')
        config_path = os.environ.get('CONFIG_PATH')
        
        backend_kwargs = {'conf_threshold': self.env_conf_threshold}
        if checkpoint_dir:
            backend_kwargs['checkpoint_dir'] = Path(checkpoint_dir)
        if config_path:
            backend_kwargs['config_path'] = Path(config_path)
        
        self.backend = RFDETRShapeBackend(**backend_kwargs)
        self.input_size = input_size
        self.logger = logger or LOGGER

    def handle(self, *, image, obj_bbox, mapping, confidence_threshold=None):
        if not obj_bbox:
            raise ValueError('Crop interactor requires a bounding box')

        effective_threshold = validate_confidence_threshold(
            confidence_threshold, self.env_conf_threshold
        )

        prepared = prepare_crop(image=image, obj_bbox=obj_bbox, target_size=self.input_size)
        predicted = self.backend.predict(prepared.image, conf_threshold=effective_threshold)

        clipped: list[PredictedInstance] = []
        for instance in predicted:
            clipped_mask = clip_mask_to_valid_region(instance.mask, prepared.valid_region)
            if clipped_mask.any():
                clipped.append(
                    PredictedInstance(
                        class_name=instance.class_name,
                        score=instance.score,
                        mask=clipped_mask,
                    ),
                )

        kept = apply_class_aware_ios_nms(clipped, threshold=0.8)
        raw_predictions = len(predicted)
        clipped_predictions = len(clipped)
        kept_predictions = len(kept)
        unmapped_predictions = 0
        empty_projected_masks = 0
        shapes = []
        for instance in kept:
            if instance.class_name not in mapping:
                unmapped_predictions += 1
                continue

            full_mask = project_mask_to_image(instance.mask, prepared)
            if not full_mask.any():
                empty_projected_masks += 1
                continue

            shapes.append({
                'label': mapping[instance.class_name]['name'],
                'type': 'mask',
                'points': mask_to_rle(full_mask),
                'attributes': [{
                    'spec_id': 0,
                    'value': f'{instance.score:.6f}',
                }],
            })

        self.logger.info(
            'RF-DETR shape pipeline summary: '
            f'raw_predictions={raw_predictions} '
            f'clipped_predictions={clipped_predictions} '
            f'kept_predictions={kept_predictions} '
            f'unmapped_predictions={unmapped_predictions} '
            f'empty_projected_masks={empty_projected_masks} '
            f'returned_shapes={len(shapes)}'
        )
        return shapes
