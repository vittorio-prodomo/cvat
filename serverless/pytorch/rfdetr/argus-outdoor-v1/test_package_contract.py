import json
from pathlib import Path

import yaml


def test_function_metadata_and_handler_agree_on_native_detector_contract(load_argus):
    model = load_argus("model_handler")
    directory = Path(__file__).parent
    metadata = json.loads((directory / "model-metadata.json").read_text())
    manifest = yaml.safe_load((directory / "function-gpu.yaml").read_text())
    annotations = manifest["metadata"]["annotations"]
    assert annotations["type"] == "detector"
    assert manifest["spec"]["handler"] == "main:handler"
    labels = json.loads(annotations["spec"])
    assert labels == [
        {
            "id": index,
            "name": name,
            "type": "mask",
            "attributes": [{"name": "model_confidence", "input_type": "text", "values": [""]}],
        }
        for index, name in enumerate(model.CLASS_NAMES)
    ]
    assert metadata["classes"] == list(model.CLASS_NAMES)
    assert metadata["input_size"] == model.INPUT_SIZE
    assert metadata["checkpoint_sha256"] == model.CHECKPOINT_SHA256
    assert metadata["checkpoint"] == Path(model.DEFAULT_CHECKPOINT_PATH).name
    assert metadata["inference"]["default_threshold"] == model.DEFAULT_THRESHOLD
    assert metadata["inference"]["sliced"] is False
