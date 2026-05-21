"""RF-DETR backend for eagle-shape-v5 crop interactor.

Provides checkpoint discovery, Lightning checkpoint loading, and prediction
normalization for the RF-DETR shape detection model.
"""
import re
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# Defer torch import to runtime
try:
    import torch
except ImportError:  # pragma: no cover
    torch = None

# PredictedInstance is the contract for crop interactor backends
@dataclass(frozen=True)
class PredictedInstance:
    """Normalized prediction instance with class_name, score, and binary mask."""
    class_name: str
    score: float
    mask: np.ndarray


def parse_map_score(filename: str) -> float:
    """Parse mAP score from checkpoint filename (epoch=XXX-map=Y.YYYY.ckpt).

    Args:
        filename: Checkpoint filename to parse

    Returns:
        mAP score if found, otherwise -1.0
    """
    # Require exact epoch=...-map=...ckpt format
    match = re.search(r"^epoch=\d+-map=([\d.]+)\.ckpt$", filename)
    if match:
        return float(match.group(1))
    return -1.0


def parse_epoch_number(filename: str) -> int:
    """Parse epoch number from checkpoint filename (epoch=XXX-map=Y.YYYY.ckpt).

    Args:
        filename: Checkpoint filename to parse

    Returns:
        Epoch number if found, otherwise -1
    """
    match = re.search(r"^epoch=(\d+)-map=[\d.]+\.ckpt$", filename)
    if match:
        return int(match.group(1))
    return -1


def find_best_checkpoint(checkpoint_dir: Path) -> Path:
    """Find the checkpoint with highest mAP score in the given directory.

    Args:
        checkpoint_dir: Directory containing checkpoint files

    Returns:
        Path to the best checkpoint file

    Raises:
        RuntimeError: If checkpoint directory doesn't exist or no valid
            epoch=XXX-map=Y.YYYY.ckpt files are found
    """
    if not checkpoint_dir.exists():
        raise RuntimeError(
            f"Checkpoint directory does not exist: {checkpoint_dir}"
        )

    checkpoints = []
    for path in checkpoint_dir.glob("*.ckpt"):
        map_score = parse_map_score(path.name)
        epoch = parse_epoch_number(path.name)
        if map_score >= 0 and epoch >= 0:
            checkpoints.append((map_score, epoch, path))

    if not checkpoints:
        raise RuntimeError(
            f"No epoch=XXX-map=Y.YYYY.ckpt files found in {checkpoint_dir}"
        )

    # Sort by mAP score descending, then by epoch descending for ties
    checkpoints.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return checkpoints[0][2]


def load_checkpoint_state_dict(checkpoint_path: Path) -> dict:
    """Load state_dict from Lightning checkpoint and strip 'model.' prefix.

    Args:
        checkpoint_path: Path to Lightning checkpoint file

    Returns:
        State dict with 'model.' prefix stripped from keys

    Raises:
        KeyError: If checkpoint doesn't contain 'state_dict' key
        RuntimeError: If torch is not available or checkpoint is incompatible
    """
    if torch is None:
        raise RuntimeError("torch is not installed")
    
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)

    if "state_dict" not in checkpoint:
        available_keys = list(checkpoint.keys())
        raise KeyError(
            f"Checkpoint {checkpoint_path} does not contain 'state_dict' key. "
            f"Available keys: {available_keys}"
        )

    # Strip 'model.' prefix from Lightning checkpoint keys
    state_dict = {}
    has_model_prefix = False
    for key, value in checkpoint["state_dict"].items():
        if key.startswith("model."):
            has_model_prefix = True
            stripped_key = key[len("model."):]
            state_dict[stripped_key] = value

    # Fail explicitly if no keys had the model. prefix
    if not has_model_prefix:
        raise RuntimeError(
            f"No keys in checkpoint {checkpoint_path} start with 'model.' prefix. "
            f"This checkpoint may not be a Lightning checkpoint or is incompatible."
        )

    return state_dict


class RFDETRShapeBackend:
    """RF-DETR backend for shape detection.

    Loads the best checkpoint from the shape_round1 training run and provides
    prediction normalization for the crop interactor.
    """

    DEFAULT_CHECKPOINT_DIR = Path(
        "/data/projects/bridge_defect_detection/runs/echo-combined-v5/shape_round1/checkpoints"
    )
    DEFAULT_CONFIG_PATH = Path(
        "/data/projects/bridge_defect_detection/runs/echo-combined-v5/shape_round1/config.yaml"
    )
    TRAINING_TOOLKIT_PATH = Path(
        "/data/projects/bridge_defect_detection/training-toolkit/src"
    )
    RFDETR_SRC_PATH = Path(
        "/data/projects/bridge_defect_detection/rf-detr/src"
    )

    def __init__(
        self,
        checkpoint_dir: Path | None = None,
        conf_threshold: float = 0.2,
        _skip_mount_check: bool = False,
    ):
        """Initialize RF-DETR backend with checkpoint discovery.

        Args:
            checkpoint_dir: Directory containing checkpoints (uses default if None)
            conf_threshold: Confidence threshold for predictions
            _skip_mount_check: Internal flag to skip mount checks for testing

        Raises:
            RuntimeError: If external project mounts are missing or checkpoints
                are not found
        """
        # Verify torch is available
        if torch is None:
            raise RuntimeError("torch is not installed")
        
        # Verify external project mounts (skip for testing)
        if not _skip_mount_check:
            if not self.TRAINING_TOOLKIT_PATH.exists():
                raise RuntimeError(
                    f"Training toolkit not mounted at {self.TRAINING_TOOLKIT_PATH}. "
                    f"Cannot load RF-DETR model."
                )
            if not self.RFDETR_SRC_PATH.exists():
                raise RuntimeError(
                    f"RF-DETR source not mounted at {self.RFDETR_SRC_PATH}. "
                    f"Cannot load RF-DETR model."
                )

        # Add external paths to sys.path for imports
        for path in [self.TRAINING_TOOLKIT_PATH, self.RFDETR_SRC_PATH]:
            if str(path) not in sys.path:
                sys.path.insert(0, str(path))

        # Find best checkpoint
        checkpoint_dir = checkpoint_dir or self.DEFAULT_CHECKPOINT_DIR
        self.checkpoint_path = find_best_checkpoint(checkpoint_dir)
        self.conf_threshold = conf_threshold

        # Load model (deferred to avoid imports at module level)
        self._model = None
        self._class_names = None

    def _load_model(self):
        """Lazily load the RF-DETR model from checkpoint."""
        if self._model is not None:
            return

        # Import RF-DETR components
        from rfdetr.models.lwdetr import build_model
        from rfdetr.config import RFDETRSegLargeConfig

        # Load checkpoint state dict
        state_dict = load_checkpoint_state_dict(self.checkpoint_path)

        # Build model configuration matching training config
        # (rf-detr-seg-large with 11 classes for shape detection)
        config = RFDETRSegLargeConfig()
        cfg_dict = config.dict()
        cfg_dict["num_classes"] = 11
        cfg_dict["mask_downsample_ratio"] = 2
        cfg_dict["segmentation_head"] = True

        # Import and populate args
        from rfdetr.main import populate_args
        args = populate_args(**cfg_dict)

        # Build model and load weights
        model = build_model(args)
        model.load_state_dict(state_dict, strict=True)
        model.eval()

        self._model = model

        # Load class names from config if available
        # Default shape class names from echo-combined dataset
        # Note: Background class is not included since predictions exclude it
        self._class_names = [
            "concrete_spalling",
            "concrete_exposed_bars",
            "concrete_crack",
            "steel_corrosion",
            "steel_crack",
            "steel_fatigue_crack",
            "steel_bolt_corrosion",
            "steel_rivet_corrosion",
            "steel_fastener_corrosion",
            "concrete_efflorescence",
        ]

    def predict(self, image: np.ndarray) -> list[PredictedInstance]:
        """Run RF-DETR prediction on image and normalize to PredictedInstance format.

        Args:
            image: Input image as numpy array (H, W, 3) in RGB format

        Returns:
            List of predicted instances with class_name, score, and binary mask
        """
        self._load_model()

        # Prepare image tensor
        # RF-DETR expects ImageNet-normalized input
        image_tensor = torch.from_numpy(image).permute(2, 0, 1).float() / 255.0
        mean = torch.tensor([0.485, 0.456, 0.406]).view(3, 1, 1)
        std = torch.tensor([0.229, 0.224, 0.225]).view(3, 1, 1)
        image_tensor = (image_tensor - mean) / std

        # Add batch dimension
        image_tensor = image_tensor.unsqueeze(0)

        # Run inference
        with torch.no_grad():
            outputs = self._model(image_tensor)

        # Extract predictions
        # RF-DETR outputs: pred_logits (B, num_queries, num_classes)
        #                  pred_masks (B, num_queries, H, W)
        #                  pred_boxes (B, num_queries, 4)
        pred_logits = outputs["pred_logits"][0]  # (num_queries, num_classes)
        pred_masks = outputs.get("pred_masks")

        # Get scores and class indices
        scores = pred_logits.softmax(-1)
        max_scores, class_indices = scores[:, :-1].max(-1)  # Exclude background class

        # Filter by confidence threshold
        keep = max_scores > self.conf_threshold
        kept_scores = max_scores[keep]
        kept_classes = class_indices[keep]

        instances = []
        if pred_masks is not None and keep.any():
            kept_masks = pred_masks[0][keep]  # (N, H, W)

            for mask, score, class_idx in zip(kept_masks, kept_scores, kept_classes):
                class_name = self._class_names[class_idx.item()]
                score_val = score.item()

                # Convert mask to binary numpy array
                mask_np = (mask > 0.5).cpu().numpy().astype(np.uint8)

                instances.append(
                    PredictedInstance(
                        class_name=class_name,
                        score=score_val,
                        mask=mask_np,
                    )
                )

        return instances
