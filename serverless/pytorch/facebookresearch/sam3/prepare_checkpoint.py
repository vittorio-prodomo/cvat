#!/usr/bin/env python3
import argparse
import getpass
import hashlib
import os
import shutil
import tempfile
from pathlib import Path


REPO_ID = 'facebook/sam3'
REVISION = '3c879f39826c281e95690f02c7821c4de09afae7'
FILENAME = 'sam3.pt'
EXPECTED_SIZE = 3_450_062_241
EXPECTED_SHA256 = '9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e'
DEFAULT_DESTINATION = Path('/data/cvat/data/models/sam3/sam3.pt')


def sha256_file(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()


def verify_checkpoint(
    path: Path,
    *,
    expected_size: int = EXPECTED_SIZE,
    expected_sha256: str = EXPECTED_SHA256,
) -> None:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError(f'SAM3 checkpoint is not a regular file: {path}')

    actual_size = path.stat().st_size
    if actual_size != expected_size:
        raise RuntimeError(
            f'SAM3 checkpoint size mismatch: expected {expected_size} bytes, '
            f'got {actual_size} bytes at {path}'
        )

    actual_sha256 = sha256_file(path)
    if actual_sha256 != expected_sha256:
        raise RuntimeError(
            f'SAM3 checkpoint SHA-256 mismatch: expected {expected_sha256}, '
            f'got {actual_sha256} at {path}'
        )


def install_checkpoint(
    destination: Path,
    *,
    token: str,
    downloader=None,
    expected_size: int = EXPECTED_SIZE,
    expected_sha256: str = EXPECTED_SHA256,
) -> Path:
    destination = Path(destination)
    if destination.exists():
        verify_checkpoint(
            destination,
            expected_size=expected_size,
            expected_sha256=expected_sha256,
        )
        os.chmod(destination.parent, 0o700)
        os.chmod(destination, 0o600)
        return destination

    if not token.strip():
        raise RuntimeError('A Hugging Face token is required to download SAM3')

    if downloader is None:
        from huggingface_hub import hf_hub_download

        downloader = hf_hub_download

    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(destination.parent, 0o700)

    staged_path = None
    try:
        with tempfile.TemporaryDirectory(
            prefix='.sam3-download-',
            dir=destination.parent,
        ) as download_dir:
            downloaded = Path(
                downloader(
                    repo_id=REPO_ID,
                    filename=FILENAME,
                    revision=REVISION,
                    token=token,
                    local_dir=download_dir,
                )
            )
            verify_checkpoint(
                downloaded,
                expected_size=expected_size,
                expected_sha256=expected_sha256,
            )

            with (
                tempfile.NamedTemporaryFile(
                    mode='wb',
                    prefix=f'.{destination.name}.',
                    suffix='.staged',
                    dir=destination.parent,
                    delete=False,
                ) as staged,
                downloaded.open('rb') as source,
            ):
                staged_path = Path(staged.name)
                shutil.copyfileobj(source, staged, length=8 * 1024 * 1024)
                staged.flush()
                os.fsync(staged.fileno())

            os.chmod(staged_path, 0o600)
            verify_checkpoint(
                staged_path,
                expected_size=expected_size,
                expected_sha256=expected_sha256,
            )
            os.replace(staged_path, destination)
            staged_path = None

            directory_fd = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
    finally:
        if staged_path is not None:
            staged_path.unlink(missing_ok=True)

    return destination


def main() -> int:
    parser = argparse.ArgumentParser(
        description='Download and verify the pinned native SAM3 checkpoint.',
    )
    parser.add_argument(
        '--destination',
        type=Path,
        default=DEFAULT_DESTINATION,
    )
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()

    if args.verify_only or args.destination.exists():
        verify_checkpoint(args.destination)
        print(f'SAM3 checkpoint verified: {args.destination}')
        return 0

    token = getpass.getpass('Hugging Face token: ')
    installed = install_checkpoint(args.destination, token=token)
    print(f'SAM3 checkpoint installed and verified: {installed}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
