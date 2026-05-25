import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np

from shape_backend import RFDETRShapeBackend
from stain_backend import RFDETRStainBackend
from postprocess import (
    PredictedInstance,
    clip_mask_to_valid_region,
    mask_to_rle,
    prepare_crop,
    project_mask_to_image,
)


def _validate_confidence_threshold(confidence_threshold):
    """Validate request-level confidence_threshold parameter.
    
    Args:
        confidence_threshold: Value from request (can be None, numeric, or invalid)
        
    Returns:
        Validated float if not None, otherwise None
        
    Raises:
        ValueError: If confidence_threshold is malformed or out of range
    """
    if confidence_threshold is None:
        return None
    
    # Check if numeric
    try:
        threshold_value = float(confidence_threshold)
    except (TypeError, ValueError):
        raise ValueError(
            f"confidence_threshold must be a number, got: {confidence_threshold!r}"
        )
    
    # Check range
    if threshold_value < 0.05 or threshold_value > 0.99:
        raise ValueError(
            f"confidence_threshold must be between 0.05 and 0.99, got: {threshold_value}"
        )
    
    return threshold_value


@dataclass(frozen=True)
class ResolvedPrediction:
    task_label: str
    score: float
    mask: np.ndarray


def _masks_overlap(left: np.ndarray, right: np.ndarray) -> bool:
    """Check if two binary masks have any pixel overlap."""
    return np.logical_and(left, right).any()


def _merge_by_task_label(predictions: list[ResolvedPrediction]) -> list[ResolvedPrediction]:
    """Merge predictions with same task_label using overlap-connected grouping.
    
    Predictions are merged if they have the same task_label AND their masks overlap
    (transitively). The merged mask is the union of all masks in the group,
    and the score is the maximum score in the group.
    
    Args:
        predictions: List of resolved predictions to merge
        
    Returns:
        List of merged predictions
    """
    if not predictions:
        return []
    
    # Group by task_label first
    by_label = {}
    for pred in predictions:
        if pred.task_label not in by_label:
            by_label[pred.task_label] = []
        by_label[pred.task_label].append(pred)
    
    merged = []
    
    for task_label, label_preds in by_label.items():
        # Build overlap graph within this label using transitive closure
        n = len(label_preds)
        groups = []  # List of lists: each inner list is a group of indices
        
        for i in range(n):
            # Find all existing groups this prediction overlaps with
            overlapping_groups = []
            for group in groups:
                # Check if prediction i overlaps with any prediction in this group
                if any(_masks_overlap(label_preds[i].mask, label_preds[j].mask) for j in group):
                    overlapping_groups.append(group)
            
            if overlapping_groups:
                # Merge all overlapping groups into the first one
                merged_group = overlapping_groups[0]
                merged_group.append(i)
                
                # Merge additional groups into the first
                for group in overlapping_groups[1:]:
                    merged_group.extend(group)
                    groups.remove(group)
            else:
                # Start a new group
                groups.append([i])
        
        # Merge each group
        for group in groups:
            # Union all masks in the group
            merged_mask = np.zeros_like(label_preds[group[0]].mask, dtype=np.uint8)
            max_score = 0.0
            
            for idx in group:
                merged_mask = np.bitwise_or(merged_mask, label_preds[idx].mask)
                max_score = max(max_score, label_preds[idx].score)
            
            merged.append(ResolvedPrediction(
                task_label=task_label,
                score=max_score,
                mask=merged_mask,
            ))
    
    return merged


class ModelHandler:
    def __init__(self, logger=None):
        self.logger = logger
        
        # Read config from environment
        self.input_size = int(os.environ.get('MODEL_INPUT_SIZE', '504'))
        self.env_conf_threshold = float(os.environ.get('MODEL_CONF_THRESHOLD', '0.2'))
        
        # Instantiate backends
        self.shape_backend = RFDETRShapeBackend(
            checkpoint_dir=Path(os.environ['SHAPE_CHECKPOINT_DIR']),
            config_path=Path(os.environ['SHAPE_CONFIG_PATH']),
            conf_threshold=self.env_conf_threshold,
        )
        
        self.stain_backend = RFDETRStainBackend(
            checkpoint_dir=Path(os.environ['STAIN_CHECKPOINT_DIR']),
            config_path=Path(os.environ['STAIN_CONFIG_PATH']),
            conf_threshold=self.env_conf_threshold,
        )

    def handle(self, image, obj_bbox, mapping, confidence_threshold=None):
        # Validate bbox requirement
        if not obj_bbox:
            raise ValueError('Crop interactor requires a bounding box')
        
        # Validate and resolve confidence threshold
        request_threshold = _validate_confidence_threshold(confidence_threshold)
        effective_threshold = request_threshold if request_threshold is not None else self.env_conf_threshold
        
        # Prepare crop once
        prepared = prepare_crop(image, obj_bbox, target_size=self.input_size)
        
        # Run both backends with the same effective threshold
        shape_instances = self.shape_backend.predict(prepared.image, conf_threshold=effective_threshold)
        stain_instances = self.stain_backend.predict(prepared.image, conf_threshold=effective_threshold)
        
        # Process and resolve predictions
        resolved = []
        
        for instance in shape_instances + stain_instances:
            # Clip mask to valid region
            clipped_mask = clip_mask_to_valid_region(instance.mask, prepared.valid_region)
            
            # Skip empty clipped masks
            if not clipped_mask.any():
                continue
            
            # Skip if class not in mapping
            if instance.class_name not in mapping:
                continue
            
            # Project mask back to full image
            full_mask = project_mask_to_image(clipped_mask, prepared)
            
            # Skip empty projected masks
            if not full_mask.any():
                continue
            
            # Convert to resolved prediction
            resolved.append(ResolvedPrediction(
                task_label=mapping[instance.class_name]['name'],
                score=instance.score,
                mask=full_mask,
            ))
        
        # Merge by task label with overlap-connected grouping
        merged = _merge_by_task_label(resolved)
        
        # Serialize to CVAT shapes
        shapes = []
        for pred in merged:
            shapes.append({
                'label': pred.task_label,
                'type': 'mask',
                'points': mask_to_rle(pred.mask),
                'attributes': [{'spec_id': 0, 'value': f'{pred.score:.6f}'}],
            })
        
        # Log summary
        if self.logger is not None:
            self.logger.info(
                f'RF-DETR combined pipeline summary: '
                f'raw_shape_predictions={len(shape_instances)} '
                f'raw_stain_predictions={len(stain_instances)} '
                f'resolved_predictions={len(resolved)} '
                f'merged_shapes={len(shapes)}'
            )
        
        return shapes
