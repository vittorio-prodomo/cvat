from pathlib import Path

import numpy as np

from postprocess import PredictedInstance

try:
    from ultralytics import YOLO
except ImportError:  # pragma: no cover - exercised in runtime environments with ultralytics installed
    YOLO = None


class UltralyticsSegmentationBackend:
    def __init__(self, weights_path: str, input_size: int, conf_threshold: float = 0.2):
        if not Path(weights_path).exists():
            raise RuntimeError(f'MODEL_WEIGHTS_PATH does not exist: {weights_path}')
        if YOLO is None:
            raise RuntimeError('Ultralytics is not installed in this environment')

        self.model = YOLO(weights_path)
        self.input_size = input_size
        self.conf_threshold = conf_threshold

    def predict(self, image: np.ndarray) -> list[PredictedInstance]:
        result = self.model.predict(
            source=image,
            imgsz=self.input_size,
            conf=self.conf_threshold,
            verbose=False,
        )[0]
        if result.masks is None:
            return []

        masks = self._to_numpy(result.masks.data)
        class_indices = self._to_numpy(result.boxes.cls)
        scores = self._to_numpy(result.boxes.conf)

        instances: list[PredictedInstance] = []
        for index, mask in enumerate(masks):
            class_index = int(class_indices[index])
            score = float(scores[index])
            class_name = result.names[class_index]
            instances.append(
                PredictedInstance(
                    class_name=class_name,
                    score=score,
                    mask=np.asarray(mask, dtype=np.uint8),
                ),
            )

        return instances

    @staticmethod
    def _to_numpy(value):
        if hasattr(value, 'cpu'):
            value = value.cpu()
        if hasattr(value, 'numpy'):
            value = value.numpy()
        return np.asarray(value)
