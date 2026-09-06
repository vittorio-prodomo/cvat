# Copyright (C) CVAT.ai Corporation
#
# SPDX-License-Identifier: MIT

import json
from unittest import TestCase

from cvat.apps.lambda_manager.views import InvalidFunctionMetadataError, LambdaFunction


def make_detector_function(postprocessing_label_groups=None):
    annotations = {
        "name": "Grouped detector",
        "type": "detector",
        "spec": json.dumps(
            [
                {"id": 0, "name": "C5", "type": "mask"},
                {"id": 1, "name": "C6", "type": "mask"},
                {"id": 2, "name": "C7", "type": "mask"},
            ]
        ),
    }
    if postprocessing_label_groups is not None:
        annotations["postprocessing_label_groups"] = postprocessing_label_groups

    return LambdaFunction(
        gateway=None,
        data={
            "metadata": {"name": "test-grouped-detector", "annotations": annotations},
            "spec": {"description": "Detector metadata fixture"},
            "status": {},
        },
    )


class TestPostprocessingLabelGroups(TestCase):
    def test_exposes_valid_groups_without_sharing_mutable_state(self):
        function = make_detector_function(json.dumps([["C5", "C6"]]))

        serialized = function.to_dict()

        self.assertEqual(serialized["postprocessing_label_groups"], [["C5", "C6"]])
        serialized["postprocessing_label_groups"][0].append("C7")
        self.assertEqual(function.to_dict()["postprocessing_label_groups"], [["C5", "C6"]])

    def test_omits_groups_when_the_function_does_not_declare_them(self):
        self.assertNotIn("postprocessing_label_groups", make_detector_function().to_dict())

    def test_rejects_invalid_group_declarations(self):
        invalid_declarations = {
            "empty declaration": "",
            "malformed JSON": "not-json",
            "not an array": json.dumps({"C5": "C6"}),
            "group is not an array": json.dumps(["C5", "C6"]),
            "group has one member": json.dumps([["C5"]]),
            "group repeats a member": json.dumps([["C5", "C5"]]),
            "group contains a non-string": json.dumps([["C5", 6]]),
            "group contains an unknown label": json.dumps([["C5", "missing"]]),
            "label belongs to two groups": json.dumps([["C5", "C6"], ["C6", "C7"]]),
        }

        for description, declaration in invalid_declarations.items():
            with self.subTest(description=description):
                with self.assertRaises(InvalidFunctionMetadataError):
                    make_detector_function(declaration)
