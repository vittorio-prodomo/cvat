# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import base64
import importlib.util
import io
import sys
import xml.etree.ElementTree as ET
from copy import deepcopy
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch
from zipfile import ZipFile

import numpy as np
import yaml
from django.test import TestCase
from PIL import Image

from cvat.apps.dataset_manager.task import JobAnnotation, export_job
from cvat.apps.engine import models
from cvat.apps.iam.models import User
from cvat.apps.lambda_manager.views import DetectionResultConverter, LambdaFunction

DETECTORS = Path(__file__).resolve().parents[4] / "serverless/pytorch/rfdetr"


def load_handler(directory):
    modules = {}
    for name in ("geometry", "model_handler"):
        spec = importlib.util.spec_from_file_location(
            f"confidence_{directory.name}_{name}", directory / f"{name}.py"
        )
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, modules):
            spec.loader.exec_module(module)
        modules[name] = module
    return modules["model_handler"]


class DetectorConfidenceTests(TestCase):
    def check_round_trip(self, package, roi=None):
        directory = DETECTORS / package
        model = load_handler(directory)
        metadata = yaml.safe_load((directory / "function-gpu.yaml").read_text())
        metadata["status"] = {"httpPort": 0, "state": "ready"}
        scores = np.linspace(0.12345678912345678, 1.0, len(model.CLASS_NAMES))
        masks = np.zeros((len(scores), model.INPUT_SIZE, model.INPUT_SIZE), dtype=bool)
        for index in range(len(scores)):
            masks[index, 200:210, 200 + index * 12 : 210 + index * 12] = True
        backend = SimpleNamespace(
            predict=lambda image, threshold: {
                "masks": masks,
                "labels": np.arange(len(scores)),
                "scores": scores,
            }
        )
        handler = model.ModelHandler(backend=backend)

        raw_results = []

        def invoke(function, payload):
            image = Image.open(io.BytesIO(base64.b64decode(payload["image"])))
            result = handler.handle(image=image, threshold=payload.get("threshold"))
            raw_results[:] = deepcopy(result)
            return result

        function = LambdaFunction(Mock(invoke=invoke), metadata)
        owner = User.objects.create(username=f"confidence-{package}-{bool(roi)}")
        data = models.Data.objects.create(size=1, start_frame=0, stop_frame=0, image_quality=70)
        task = models.Task.objects.create(name="confidence round trip", owner=owner, data=data)
        models.Image.objects.create(data=data, path="frame.png", frame=0, width=504, height=504)
        segment = models.Segment.objects.create(task=task, start_frame=0, stop_frame=0)
        job = models.Job.objects.create(segment=segment)
        mapping = {}
        for name in model.CLASS_NAMES:
            label = models.Label.objects.create(task=task, name=f"mapped_{name}", type="mask")
            models.AttributeSpec.objects.create(
                label=label,
                name="model_confidence",
                input_type="text",
                mutable=False,
                default_value="",
                values="",
            )
            mapping[name] = {
                "name": label.name,
                "attributes": {"model_confidence": "model_confidence"},
            }

        image_bytes = io.BytesIO()
        Image.new("RGB", (504, 504)).save(image_bytes, format="PNG")
        provider = SimpleNamespace(
            get_frame=lambda frame: SimpleNamespace(
                data=io.BytesIO(image_bytes.getvalue()),
            )
        )
        request = {"frame": 0, "threshold": 0, "mapping": mapping}
        if roi is not None:
            request["roi"] = roi
        with patch("cvat.apps.lambda_manager.views.TaskFrameProvider", return_value=provider):
            result = function.invoke(task, request, converter=DetectionResultConverter(task))
        expected = [str(float(score)) for score in scores]
        self.assertEqual(len(result["shapes"]), len(expected))
        self.assertEqual([shape["attributes"][0]["value"] for shape in result["shapes"]], expected)
        offset = roi[:2] if roi else [0, 0]
        for shape, raw in zip(result["shapes"], raw_results):
            self.assertEqual(
                shape["points"][-4:],
                [value + offset[index % 2] for index, value in enumerate(raw["mask"][-4:])],
            )

        manual = deepcopy(result["shapes"][0])
        manual.update(source="manual", attributes=[])
        writer = JobAnnotation(job.id)
        writer.put(
            {"tags": [], "shapes": [*result["shapes"], manual], "tracks": [], "intervals": []}
        )
        reloaded = JobAnnotation(job.id)
        reloaded.init_from_db()
        self.assertEqual(
            [shape["attributes"][0]["value"] for shape in reloaded.data["shapes"]],
            [*expected, ""],
        )

        with TemporaryDirectory() as temp:
            archive = Path(temp) / "annotations.zip"
            export_job(job.id, str(archive), format_name="CVAT for images 1.1")
            with ZipFile(archive) as zipped:
                xml = ET.fromstring(zipped.read("annotations.xml"))
            self.assertCountEqual(
                [
                    attr.text or ""
                    for attr in xml.findall(".//image/mask/attribute[@name='model_confidence']")
                ],
                [*expected, ""],
            )

    def test_argus_mapping_persistence_and_export(self):
        self.check_round_trip("argus-outdoor-v1")

    def test_argus_roi_mapping_persistence_and_export(self):
        self.check_round_trip("argus-outdoor-v1", [12, 18, 492, 498])

    def test_indoor_mapping_persistence_and_export(self):
        self.check_round_trip("indoor-v3")

    def test_indoor_roi_mapping_persistence_and_export(self):
        self.check_round_trip("indoor-v3", [12, 18, 492, 498])


class ConfigureConfidenceTests(TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location(
            "configure_confidence", DETECTORS / "configure_model_confidence.py"
        )
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)
        self.project = models.Project.objects.create(name="target project")
        self.label = models.Label.objects.create(
            project=self.project, name="C1", type="any", color="#123456"
        )
        self.original = models.AttributeSpec.objects.create(
            label=self.label,
            name="label_id",
            input_type="text",
            mutable=False,
            default_value="",
            values="",
        )

    def test_dry_run_and_repeat_preserve_existing_schema(self):
        preview = self.module.configure(project_ids=[self.project.id])
        self.assertEqual(preview["added"], 0)
        self.assertEqual(preview["would_add"], 1)
        self.assertEqual(self.label.attributespec_set.count(), 1)
        result = self.module.configure(project_ids=[self.project.id], apply=True)
        self.assertEqual(result["added"], 1)
        self.label.refresh_from_db()
        self.assertEqual(
            (self.label.name, self.label.type, self.label.color), ("C1", "any", "#123456")
        )
        self.original.refresh_from_db()
        self.assertEqual(self.original.name, "label_id")
        added = self.label.attributespec_set.get(name="model_confidence")
        self.assertEqual((added.input_type, added.default_value), ("text", ""))
        repeated = self.module.configure(project_ids=[self.project.id], apply=True)
        self.assertEqual(repeated["added"], 0)
        self.assertEqual(self.label.attributespec_set.count(), 2)

    def test_incompatible_existing_field_aborts_entire_update(self):
        other = models.Label.objects.create(project=self.project, name="C2", type="mask")
        models.AttributeSpec.objects.create(
            label=other,
            name="model_confidence",
            input_type="text",
            mutable=False,
            default_value="1.0",
            values="",
        )
        with self.assertRaisesRegex(ValueError, "incompatible"):
            self.module.configure(project_ids=[self.project.id], apply=True)
        self.assertFalse(self.label.attributespec_set.filter(name="model_confidence").exists())

    def test_task_in_project_requires_explicit_project_scope(self):
        task = models.Task.objects.create(name="project task", project=self.project)
        with self.assertRaisesRegex(ValueError, "project"):
            self.module.configure(task_ids=[task.id], apply=True)
        with self.assertRaisesRegex(ValueError, "target"):
            self.module.configure(apply=True)

    def test_standalone_scope_excludes_other_projects_and_tags(self):
        task = models.Task.objects.create(name="standalone")
        mask = models.Label.objects.create(task=task, name="C1", type="mask")
        tag = models.Label.objects.create(task=task, name="no defect", type="tag")
        result = self.module.configure(task_ids=[task.id], apply=True)
        self.assertEqual(result["added"], 1)
        self.assertTrue(mask.attributespec_set.filter(name="model_confidence").exists())
        self.assertFalse(tag.attributespec_set.exists())
        self.assertFalse(self.label.attributespec_set.filter(name="model_confidence").exists())
