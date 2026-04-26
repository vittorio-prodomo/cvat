import os

from backends import UltralyticsSegmentationBackend
from postprocess import (
    PredictedInstance,
    apply_class_aware_ios_nms,
    clip_mask_to_valid_region,
    mask_to_rle,
    prepare_crop,
    project_mask_to_image,
)


class ModelHandler:
    def __init__(self):
        weights_path = os.environ['MODEL_WEIGHTS_PATH']
        input_size = int(os.environ.get('MODEL_INPUT_SIZE', '640'))
        conf_threshold = float(os.environ.get('MODEL_CONF_THRESHOLD', '0.2'))
        self.backend = UltralyticsSegmentationBackend(
            weights_path=weights_path,
            input_size=input_size,
            conf_threshold=conf_threshold,
        )
        self.input_size = input_size

    def handle(self, *, image, obj_bbox, mapping):
        if not obj_bbox:
            raise ValueError('Crop interactor requires a bounding box')

        prepared = prepare_crop(image=image, obj_bbox=obj_bbox, target_size=self.input_size)
        predicted = self.backend.predict(prepared.image)

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
        shapes = []
        for instance in kept:
            if instance.class_name not in mapping:
                continue

            full_mask = project_mask_to_image(instance.mask, prepared)
            if not full_mask.any():
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

        return shapes
