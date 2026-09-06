#!/usr/bin/env python3
"""Create a small, pinned Docker context; never deploy or modify the training repo."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bridge-root", type=Path, default=Path("/data/projects/bridge_defect_detection"))
    parser.add_argument("--context", required=True, type=Path, help="New directory; must not already exist")
    parser.add_argument("--model-dir", required=True, type=Path, help="Dedicated checkpoint directory")
    args = parser.parse_args()
    metadata = json.loads((HERE / "model-metadata.json").read_text())
    checkpoint = args.bridge_root / "runs" / metadata["run"] / "checkpoints" / metadata["checkpoint"]
    if sha256(checkpoint) != metadata["checkpoint_sha256"]:
        raise ValueError("Source checkpoint SHA256 does not match the approved Indoor artifact")
    args.context.mkdir(parents=True, exist_ok=False)
    for name in ("Dockerfile", "requirements.txt", "main.py", "model_handler.py", "geometry.py", "model-metadata.json", "function-gpu.yaml"):
        shutil.copy2(HERE / name, args.context / name)
    archives = {}
    for name, commit in metadata["source_commits"].items():
        repo = args.bridge_root / name
        paths = ["src", "pyproject.toml", "README.md"]
        if name == "rf-detr":
            paths.append("LICENSE")
        archive = subprocess.check_output(["git", "-C", str(repo), "archive", "--format=tar", commit, *paths])
        archives[name] = hashlib.sha256(archive).hexdigest()
        target = args.context / "vendor" / name
        target.mkdir(parents=True)
        with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
            # The selected source trees contain ordinary files only. Refuse links
            # and path traversal rather than importing files outside this context.
            for member in tar.getmembers():
                if not (member.isfile() or member.isdir()) or not (target / member.name).resolve().is_relative_to(target.resolve()):
                    raise ValueError(f"Unsafe source archive member: {member.name}")
            tar.extractall(target)
    args.model_dir.mkdir(parents=True, exist_ok=True)
    destination = args.model_dir / metadata["checkpoint"]
    if destination.exists():
        if sha256(destination) != metadata["checkpoint_sha256"]:
            raise ValueError("Existing destination checkpoint differs; refusing to overwrite")
    else:
        # Exclusive creation prevents overwriting a concurrent preparation.
        with checkpoint.open("rb") as source, destination.open("xb") as output:
            shutil.copyfileobj(source, output, 1024 * 1024)
        if sha256(destination) != metadata["checkpoint_sha256"]:
            raise ValueError("Copied checkpoint SHA256 mismatch")
        destination.chmod(0o444)
    receipt = {"model": metadata, "source_archive_sha256": archives,
               "files_sha256": {p.name: sha256(p) for p in args.context.iterdir() if p.is_file()},
               "checkpoint_path": str(destination.resolve())}
    (args.context / "preparation.json").write_text(json.dumps(receipt, indent=2) + "\n")
    print(json.dumps({"context": str(args.context.resolve()), "checkpoint": str(destination.resolve())}))


if __name__ == "__main__":
    main()
