"""Add the optional detector confidence field to explicitly selected CVAT labels.

Run inside the CVAT server container; the default is a read-only preview::

    docker exec -i cvat_server python - --project 40 < configure_model_confidence.py

Pass --apply to save the schema update. No annotation values are backfilled.
"""

import argparse
import json
import os

ATTRIBUTE = {
    "name": "model_confidence",
    "input_type": "text",
    "mutable": False,
    "default_value": "",
    "values": [""],
}


def configure(*, project_ids=(), task_ids=(), all_existing=False, apply=False):
    from django.db import transaction
    from django.db.models import Q

    from cvat.apps.engine import models
    from cvat.apps.engine.serializers import LabelSerializer

    project_ids, task_ids = set(project_ids), set(task_ids)
    if not (project_ids or task_ids or all_existing):
        raise ValueError("An explicit project or standalone task target is required")
    if all_existing and (project_ids or task_ids):
        raise ValueError("Choose all existing labels or explicit targets, not both")

    with transaction.atomic():
        projects = dict(models.Project.objects.filter(id__in=project_ids).values_list("id", "name"))
        tasks = {task.id: task for task in models.Task.objects.filter(id__in=task_ids)}
        if missing := project_ids - projects.keys():
            raise ValueError(f"Unknown project targets: {sorted(missing)}")
        if missing := task_ids - tasks.keys():
            raise ValueError(f"Unknown task targets: {sorted(missing)}")
        for task in tasks.values():
            if task.project_id is not None:
                raise ValueError(
                    f"Task {task.id} shares project {task.project_id} labels; "
                    "target that project explicitly"
                )

        labels = models.Label.objects.filter(
            parent__isnull=True,
            type__in=("any", "mask", "polygon"),
        ).order_by("id")
        if not all_existing:
            labels = labels.filter(Q(project_id__in=project_ids) | Q(task_id__in=task_ids))
        if apply:
            labels = labels.select_for_update()
        labels = list(labels.prefetch_related("attributespec_set"))
        report = {"apply": apply, "added": 0, "would_add": 0, "kept": 0, "labels": []}
        pending = []
        for label in labels:
            existing = [
                attr for attr in label.attributespec_set.all() if attr.name == ATTRIBUTE["name"]
            ]
            if existing and (
                len(existing) != 1
                or any(
                    attr.input_type != "text"
                    or attr.default_value != ""
                    or attr.mutable
                    or attr.values != ""
                    for attr in existing
                )
            ):
                raise ValueError(
                    f"Label {label.id} ({label.name}) has an incompatible model_confidence field"
                )
            report["labels"].append(
                {
                    "id": label.id,
                    "name": label.name,
                    "project_id": label.project_id,
                    "task_id": label.task_id,
                    "action": "keep" if existing else "add",
                }
            )
            if existing:
                report["kept"] += 1
            else:
                pending.append(label)

        report["would_add"] = len(pending)
        if apply:
            for label in pending:
                # Include color: the serializer generates a new one when omitted.
                # Omitted existing attributes are retained by CVAT's partial update.
                serializer = LabelSerializer(
                    label,
                    data={
                        "color": label.color,
                        "attributes": [ATTRIBUTE.copy()],
                    },
                    partial=True,
                    local=True,
                )
                serializer.is_valid(raise_exception=True)
                serializer.save()
                report["added"] += 1
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", type=int, nargs="+", default=[], help="Project IDs")
    parser.add_argument("--task", type=int, nargs="+", default=[], help="Standalone task IDs")
    parser.add_argument("--all-existing-labels", action="store_true")
    parser.add_argument("--apply", action="store_true", help="Save changes (default: preview only)")
    args = parser.parse_args()
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", "cvat.settings.production")
    import django

    django.setup()
    try:
        result = configure(
            project_ids=args.project,
            task_ids=args.task,
            all_existing=args.all_existing_labels,
            apply=args.apply,
        )
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
