import json
from pathlib import Path

import yaml


def test_function_metadata_and_handler_agree_on_native_detector_contract(load_indoor):
    model = load_indoor("model_handler")
    directory = Path(__file__).parent
    metadata = json.loads((directory / "model-metadata.json").read_text())
    manifest = yaml.safe_load((directory / "function-gpu.yaml").read_text())
    dockerfile = (directory / "Dockerfile").read_text()
    annotations = manifest["metadata"]["annotations"]
    checkpoint_path = "/opt/models/epoch=022-map=0.0805.ckpt"
    assert annotations["type"] == "detector"
    assert annotations["name"] == "Indoor v3"
    assert annotations["version"] == "3"
    assert manifest["spec"]["handler"] == "main:handler"
    assert manifest["spec"]["image"] == "cvat.rfdetr.indoor.v3:1008-20260906"
    assert manifest["spec"]["env"] == [{"name": "CHECKPOINT_PATH", "value": checkpoint_path}]
    assert f"CHECKPOINT_PATH={checkpoint_path}" in dockerfile
    labels = json.loads(annotations["spec"])
    assert labels == [{"id": index, "name": name, "type": "mask",
                       "attributes": [{"name": "model_confidence", "input_type": "text", "values": [""]}]}
                      for index, name in enumerate(model.CLASS_NAMES)]
    postprocessing_label_groups = json.loads(annotations["postprocessing_label_groups"])
    assert postprocessing_label_groups == [["C1", "C5", "C6", "C7"]]
    assert all(
        label in model.CLASS_NAMES
        for group in postprocessing_label_groups
        for label in group
    )
    assert metadata["classes"] == list(model.CLASS_NAMES)
    assert metadata["run"] == "rfdetr-indoor-domus-v3-1008"
    assert metadata["checkpoint"] == "epoch=022-map=0.0805.ckpt"
    assert metadata["checkpoint_sha256"] == (
        "17da6b5e29a877a4ffb6881a6ac44f99b1f2515882265d19f22a594239dfc385"
    )
    assert metadata["training_config_sha256"] == (
        "e3e31ca72d0990b2e349571eb99bae5e298929e298bc7f27cce17dbbed8ecd1c"
    )
    assert metadata["input_size"] == 1008
    assert metadata["input_size"] == model.INPUT_SIZE
    assert metadata["checkpoint_sha256"] == model.CHECKPOINT_SHA256
    assert metadata["checkpoint"] == Path(model.DEFAULT_CHECKPOINT_PATH).name
    assert model.DEFAULT_CHECKPOINT_PATH == checkpoint_path
    assert metadata["inference"]["default_threshold"] == model.DEFAULT_THRESHOLD
    assert metadata["inference"]["sliced"] is False
