import hashlib
import stat
from pathlib import Path

import pytest

import prepare_checkpoint


def digest(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def test_checkpoint_source_contract_uses_approved_literals():
    assert prepare_checkpoint.REPO_ID == 'facebook/sam3'
    assert prepare_checkpoint.REVISION == (
        '3c879f39826c281e95690f02c7821c4de09afae7'
    )
    assert prepare_checkpoint.FILENAME == 'sam3.pt'
    assert prepare_checkpoint.EXPECTED_SIZE == 3_450_062_241
    assert prepare_checkpoint.EXPECTED_SHA256 == (
        '9999e2341ceef5e136daa386eecb55cb414446a00ac2b55eb2dfd2f7c3cf8c9e'
    )


def test_install_checkpoint_pins_source_and_atomically_promotes(tmp_path):
    payload = b'verified-sam3-checkpoint'
    destination = tmp_path / 'models' / 'sam3.pt'
    calls = []

    def downloader(**kwargs):
        calls.append(kwargs)
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    installed = prepare_checkpoint.install_checkpoint(
        destination,
        token='secret-not-for-output',
        downloader=downloader,
        expected_size=len(payload),
        expected_sha256=digest(payload),
    )

    assert installed == destination
    assert destination.read_bytes() == payload
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600
    assert len(calls) == 1
    assert calls[0]['repo_id'] == prepare_checkpoint.REPO_ID
    assert calls[0]['filename'] == prepare_checkpoint.FILENAME
    assert calls[0]['revision'] == prepare_checkpoint.REVISION
    assert calls[0]['token'] == 'secret-not-for-output'
    assert Path(calls[0]['local_dir']).parent == destination.parent
    assert not list(destination.parent.glob(f'.{destination.name}.*.staged'))


def test_install_checkpoint_rejects_bad_download_without_destination(tmp_path):
    payload = b'corrupt'
    destination = tmp_path / 'models' / 'sam3.pt'

    def downloader(**kwargs):
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    with pytest.raises(RuntimeError, match='SHA-256 mismatch'):
        prepare_checkpoint.install_checkpoint(
            destination,
            token='secret-not-for-output',
            downloader=downloader,
            expected_size=len(payload),
            expected_sha256=digest(b'expected'),
        )

    assert not destination.exists()
    assert not list(destination.parent.glob(f'.{destination.name}.*.staged'))


def test_install_checkpoint_rejects_bad_size_without_destination(tmp_path):
    payload = b'wrong-size'
    destination = tmp_path / 'models' / 'sam3.pt'

    def downloader(**kwargs):
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    with pytest.raises(RuntimeError, match='size mismatch'):
        prepare_checkpoint.install_checkpoint(
            destination,
            token='secret-not-for-output',
            downloader=downloader,
            expected_size=len(payload) + 1,
            expected_sha256=digest(payload),
        )

    assert not destination.exists()


def test_verify_checkpoint_rejects_symlink(tmp_path):
    target = tmp_path / 'target.pt'
    target.write_bytes(b'checkpoint')
    checkpoint = tmp_path / 'sam3.pt'
    checkpoint.symlink_to(target)

    with pytest.raises(RuntimeError, match='not a regular file'):
        prepare_checkpoint.verify_checkpoint(
            checkpoint,
            expected_size=target.stat().st_size,
            expected_sha256=digest(target.read_bytes()),
        )


def test_install_checkpoint_reuses_verified_destination_without_downloading(tmp_path):
    payload = b'already-present'
    destination = tmp_path / 'sam3.pt'
    destination.write_bytes(payload)

    def downloader(**kwargs):
        raise AssertionError('downloader must not run for a verified destination')

    installed = prepare_checkpoint.install_checkpoint(
        destination,
        token='secret-not-for-output',
        downloader=downloader,
        expected_size=len(payload),
        expected_sha256=digest(payload),
    )

    assert installed == destination
    assert destination.read_bytes() == payload
    assert stat.S_IMODE(destination.stat().st_mode) == 0o600


def test_install_checkpoint_does_not_log_token(tmp_path, capsys):
    payload = b'payload'
    destination = tmp_path / 'sam3.pt'

    def downloader(**kwargs):
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    prepare_checkpoint.install_checkpoint(
        destination,
        token='secret-not-for-output',
        downloader=downloader,
        expected_size=len(payload),
        expected_sha256=digest(payload),
    )

    captured = capsys.readouterr()
    assert 'secret-not-for-output' not in captured.out
    assert 'secret-not-for-output' not in captured.err


def test_install_checkpoint_rejects_blank_token_before_downloading(tmp_path):
    destination = tmp_path / 'sam3.pt'

    def downloader(**kwargs):
        raise AssertionError('downloader must not run without a token')

    with pytest.raises(RuntimeError, match='token is required'):
        prepare_checkpoint.install_checkpoint(
            destination,
            token='   ',
            downloader=downloader,
        )


def test_install_checkpoint_fsyncs_staged_file_and_parent_directory(
    tmp_path,
    monkeypatch,
):
    payload = b'durable-checkpoint'
    destination = tmp_path / 'models' / 'sam3.pt'
    fsync_calls = []

    def downloader(**kwargs):
        downloaded = Path(kwargs['local_dir']) / prepare_checkpoint.FILENAME
        downloaded.write_bytes(payload)
        return str(downloaded)

    monkeypatch.setattr(
        prepare_checkpoint.os,
        'fsync',
        lambda file_descriptor: fsync_calls.append(file_descriptor),
    )

    prepare_checkpoint.install_checkpoint(
        destination,
        token='secret-not-for-output',
        downloader=downloader,
        expected_size=len(payload),
        expected_sha256=digest(payload),
    )

    assert len(fsync_calls) == 2
