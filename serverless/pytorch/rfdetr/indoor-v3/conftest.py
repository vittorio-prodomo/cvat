"""Keep Nuclio's flat module imports isolated from the other RF-DETR functions."""

import importlib.util
from pathlib import Path
import sys

import pytest


@pytest.fixture(scope="session")
def load_indoor():
    modules = {}

    def load(name):
        names = ("geometry", "model_handler", "main")
        required = names[: names.index(name) + 1]
        saved = {key: sys.modules.get(key) for key in required}
        try:
            for key in required:
                if key not in modules:
                    spec = importlib.util.spec_from_file_location(
                        f"indoor_v3_{key}", Path(__file__).with_name(f"{key}.py")
                    )
                    module = importlib.util.module_from_spec(spec)
                    sys.modules[spec.name] = module
                    spec.loader.exec_module(module)
                    modules[key] = module
                sys.modules[key] = modules[key]
            return modules[name]
        finally:
            for key, original in saved.items():
                if original is None:
                    sys.modules.pop(key, None)
                else:
                    sys.modules[key] = original

    return load
