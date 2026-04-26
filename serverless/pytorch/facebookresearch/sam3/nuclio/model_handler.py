import os

import numpy as np


class ModelHandler:
    def __init__(self):
        import torch
        from sam3.model_builder import build_sam3_image_model, download_ckpt_from_hf

        if not torch.cuda.is_available():
            raise RuntimeError('SAM3 interactor requires an NVIDIA GPU with CUDA support')

        version = os.environ.get('SAM3_MODEL_VERSION', 'sam3')
        checkpoint_path = os.environ.get('SAM3_CHECKPOINT_PATH')
        if checkpoint_path is None and version == 'sam3.1':
            raise RuntimeError(
                'sam3.1 multiplex checkpoint is not supported for the SAM3 interactive interactor; '
                'use SAM3_MODEL_VERSION=sam3 or provide SAM3_CHECKPOINT_PATH'
            )

        if checkpoint_path is None:
            checkpoint_path = download_ckpt_from_hf(version=version)

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

        self.predictor = predictor

    def handle(self, image, *, pos_points, neg_points, obj_bbox):
        if not pos_points and not neg_points and not obj_bbox:
            raise ValueError('SAM3 interactor requires at least one point or a bounding box')

        self.predictor.set_image(np.array(image))

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

        masks, scores, _ = self.predictor.predict(
            point_coords=point_coords,
            point_labels=point_labels,
            box=box,
            multimask_output=True,
            return_logits=False,
        )

        best_index = int(np.argmax(scores))
        return masks[best_index].astype(np.uint8).tolist()
