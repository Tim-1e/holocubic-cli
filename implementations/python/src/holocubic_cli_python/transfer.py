"""Safe chunked file and recursive directory transfers."""

import os
import posixpath
import secrets
import shutil
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .client import CubicClient
from .errors import CubicError, HttpError
from .models import RemoteStat, TransferLimits, TransferSummary
from .remote_path import (
    normalize_remote_path,
    remote_basename,
    remote_join,
    safe_local_destination,
)


@dataclass(frozen=True)
class TransferProgress:
    phase: str
    path: str
    transferred_bytes: int
    total_bytes: int
    completed_entries: int
    total_entries: int


ProgressCallback = Callable[[TransferProgress], None]


@dataclass(frozen=True)
class _LocalFile:
    absolute: Path
    relative: str
    size: int


@dataclass(frozen=True)
class _RemoteFile:
    remote: str
    relative: str
    size: int


def _suffix() -> str:
    return f"{os.getpid()}-{secrets.token_hex(5)}"


def _absolute_path(value: str | Path) -> Path:
    """Make a path absolute without following its final symbolic link."""
    return Path(os.path.abspath(os.fspath(value)))


def _transient(error: BaseException) -> bool:
    return (
        isinstance(error, HttpError)
        and error.status >= 500
        or isinstance(error, CubicError)
        and error.code in {"TIMEOUT", "CONNECTION_ERROR"}
    )


def _with_retry(operation: Callable[[], object], retries: int) -> object:
    for attempt in range(max(0, retries) + 1):
        try:
            return operation()
        except CubicError as error:
            if not _transient(error) or attempt >= retries:
                raise
            time.sleep(0.1 * (2**attempt))
    raise AssertionError("unreachable retry state")


def ensure_remote_directory(client: CubicClient, remote_directory: str) -> None:
    normalized = normalize_remote_path(remote_directory)
    if normalized == "/sd":
        return
    current = "/sd"
    for segment in normalized[4:].split("/"):
        current = remote_join(current, segment)
        current_stat = client.stat_or_none(current)
        if current_stat is None:
            client.mkdir(current)
        elif not current_stat.is_dir:
            raise CubicError(
                f"Remote parent is a file: {current}", code="PATH_CONFLICT"
            )


def _remove_remote_path(client: CubicClient, remote_path: str) -> None:
    target = client.stat_or_none(remote_path)
    if target is None:
        return
    if target.is_dir:
        client.rmdir(remote_path, True)
    else:
        client.remove(remote_path)


def _commit_remote(
    client: CubicClient,
    temporary: str,
    target: str,
    current_target: RemoteStat | None,
    force: bool,
) -> None:
    if current_target is not None and not force:
        raise CubicError(
            f"Remote target already exists: {target}. Use --force to replace it.",
            code="TARGET_EXISTS",
        )
    backup = f"{target}.cubic-backup-{_suffix()}"
    backed_up = False
    if current_target is not None:
        client.rename(target, backup)
        backed_up = True
    try:
        client.rename(temporary, target)
    except CubicError as error:
        if backed_up:
            try:
                client.rename(backup, target)
            except CubicError:
                pass
        raise CubicError(
            f"Unable to commit remote target {target}: {error}", code="COMMIT_FAILED"
        ) from error
    if backed_up:
        _remove_remote_path(client, backup)


def _scan_local_tree(
    root: Path, limits: TransferLimits
) -> tuple[list[str], list[_LocalFile], int]:
    directories: list[str] = []
    files: list[_LocalFile] = []
    entries = 0
    total_bytes = 0

    def visit(absolute: Path, relative: str, depth: int) -> None:
        nonlocal entries, total_bytes
        if depth > limits.max_depth:
            raise CubicError(
                f"Local directory exceeds maximum depth {limits.max_depth}: {absolute}",
                code="TREE_LIMIT",
            )
        for child in sorted(absolute.iterdir(), key=lambda item: item.name):
            entries += 1
            if entries > limits.max_entries:
                raise CubicError(
                    f"Local directory exceeds maximum entries {limits.max_entries}.",
                    code="TREE_LIMIT",
                )
            child_relative = (
                posixpath.join(relative, child.name) if relative else child.name
            )
            if child.is_symlink():
                raise CubicError(
                    f"Symbolic links are not followed: {child}", code="SYMLINK_REJECTED"
                )
            if child.is_dir():
                directories.append(child_relative)
                visit(child, child_relative, depth + 1)
            elif child.is_file():
                size = child.stat().st_size
                files.append(_LocalFile(child, child_relative, size))
                total_bytes += size
            else:
                raise CubicError(
                    f"Unsupported local filesystem entry: {child}",
                    code="UNSUPPORTED_ENTRY",
                )

    visit(root, "", 0)
    return directories, files, total_bytes


def _scan_remote_tree(
    client: CubicClient, root: str, limits: TransferLimits
) -> tuple[list[str], list[_RemoteFile], int]:
    directories: list[str] = []
    files: list[_RemoteFile] = []
    seen: set[str] = set()
    entries = 0
    total_bytes = 0

    def visit(current: str, relative: str, depth: int) -> None:
        nonlocal entries, total_bytes
        if depth > limits.max_depth:
            raise CubicError(
                f"Remote directory exceeds maximum depth {limits.max_depth}: {current}",
                code="TREE_LIMIT",
            )
        result = client.list(current)
        for item in result.items:
            entries += 1
            if entries > limits.max_entries:
                raise CubicError(
                    f"Remote directory exceeds maximum entries {limits.max_entries}.",
                    code="TREE_LIMIT",
                )
            expected = remote_join(current, item.name)
            if item.path != expected:
                raise CubicError(
                    f"Unsafe directory entry path returned by device: {item.path}",
                    code="UNSAFE_REMOTE_ENTRY",
                )
            item_relative = (
                posixpath.join(relative, item.name) if relative else item.name
            )
            if item_relative in seen:
                raise CubicError(
                    f"Duplicate remote directory entry: {item_relative}",
                    code="INVALID_RESPONSE",
                )
            seen.add(item_relative)
            if item.is_dir:
                directories.append(item_relative)
                visit(item.path, item_relative, depth + 1)
            else:
                files.append(_RemoteFile(item.path, item_relative, item.size))
                total_bytes += item.size
                if total_bytes > limits.max_download_bytes:
                    raise CubicError(
                        f"Remote directory exceeds download limit {limits.max_download_bytes} bytes.",
                        code="TREE_LIMIT",
                    )

    visit(root, "", 0)
    return directories, files, total_bytes


def upload_file(
    client: CubicClient,
    local_file: str | Path,
    remote_file: str,
    *,
    force: bool = False,
    retries: int = 2,
    on_progress: ProgressCallback | None = None,
) -> TransferSummary:
    source = _absolute_path(local_file)
    if source.is_symlink():
        raise CubicError(
            f"Symbolic links are not followed: {source}", code="SYMLINK_REJECTED"
        )
    if not source.is_file():
        raise CubicError(f"Local source is not a file: {source}", code="NOT_A_FILE")
    size = source.stat().st_size
    target = normalize_remote_path(remote_file)
    info = client.info()
    if size > info.max_file_size:
        raise CubicError(
            f"Local file is {size} bytes; device limit is {info.max_file_size} bytes.",
            code="FILE_TOO_LARGE",
        )
    current_target = client.stat_or_none(target)
    if current_target is not None and current_target.is_dir:
        raise CubicError(
            f"Remote target is a directory: {target}", code="PATH_CONFLICT"
        )
    if current_target is not None and not force:
        raise CubicError(
            f"Remote target already exists: {target}. Use --force to replace it.",
            code="TARGET_EXISTS",
        )
    ensure_remote_directory(client, posixpath.dirname(target))
    temporary = f"{target}.cubic-upload-{_suffix()}"
    offset = 0
    try:
        if size == 0:
            result = _with_retry(lambda: client.upload(temporary, b"", 0, 0), retries)
            if not getattr(result, "done") or getattr(result, "next_offset") != 0:
                raise CubicError(
                    "Device did not complete the empty upload.", code="INVALID_RESPONSE"
                )
        else:
            with source.open("rb") as handle:
                while offset < size:
                    data = handle.read(min(info.chunk_size, size - offset))
                    if not data:
                        raise CubicError(
                            f"Unexpected end of local file: {source}",
                            code="LOCAL_READ_ERROR",
                        )
                    result = _with_retry(
                        lambda data=data, offset=offset: client.upload(
                            temporary, data, offset, size
                        ),
                        retries,
                    )
                    if (
                        getattr(result, "next_offset") != offset + len(data)
                        or getattr(result, "total") != size
                    ):
                        raise CubicError(
                            f"Device returned an invalid upload offset for {target}.",
                            code="INVALID_RESPONSE",
                        )
                    offset = getattr(result, "next_offset")
                    if on_progress:
                        on_progress(
                            TransferProgress(
                                "upload",
                                target,
                                offset,
                                size,
                                1 if offset == size else 0,
                                1,
                            )
                        )
        uploaded = client.stat(temporary)
        if uploaded.is_dir or uploaded.size != size:
            raise CubicError(
                f"Remote upload verification failed for {target}.", code="VERIFY_FAILED"
            )
        if on_progress:
            on_progress(TransferProgress("commit", target, size, size, 1, 1))
        _commit_remote(client, temporary, target, current_target, force)
        return TransferSummary(str(source), target, 1, 0, size)
    except Exception:
        try:
            _remove_remote_path(client, temporary)
        except CubicError:
            pass
        raise


def upload_path(
    client: CubicClient,
    local_source: str | Path,
    remote_destination: str | None = None,
    *,
    force: bool = False,
    retries: int = 2,
    limits: TransferLimits | None = None,
    on_progress: ProgressCallback | None = None,
) -> TransferSummary:
    source = _absolute_path(local_source)
    if source.is_symlink():
        raise CubicError(
            f"Symbolic links are not followed: {source}", code="SYMLINK_REJECTED"
        )
    target = normalize_remote_path(
        remote_destination or remote_join("/sd", source.name)
    )
    if source.is_file():
        return upload_file(
            client,
            source,
            target,
            force=force,
            retries=retries,
            on_progress=on_progress,
        )
    if not source.is_dir():
        raise CubicError(
            f"Unsupported local source: {source}", code="UNSUPPORTED_ENTRY"
        )
    transfer_limits = limits or TransferLimits()
    if on_progress:
        on_progress(TransferProgress("scan", str(source), 0, 0, 0, 0))
    directories, files, total_bytes = _scan_local_tree(source, transfer_limits)
    info = client.info()
    oversized = next((item for item in files if item.size > info.max_file_size), None)
    if oversized:
        raise CubicError(
            f"Local file is {oversized.size} bytes; device limit is {info.max_file_size}: {oversized.absolute}",
            code="FILE_TOO_LARGE",
        )
    current_target = client.stat_or_none(target)
    if current_target is not None and not force:
        raise CubicError(
            f"Remote target already exists: {target}. Use --force to replace it.",
            code="TARGET_EXISTS",
        )
    ensure_remote_directory(client, posixpath.dirname(target))
    temporary = f"{target}.cubic-upload-{_suffix()}"
    transferred = 0
    completed = 0
    total_entries = len(directories) + len(files)
    try:
        client.mkdir(temporary)
        for directory in directories:
            ensure_remote_directory(client, posixpath.join(temporary, directory))
            completed += 1
        for local in files:
            before = transferred

            def child_progress(
                event: TransferProgress, relative: str = local.relative
            ) -> None:
                if on_progress:
                    on_progress(
                        TransferProgress(
                            event.phase,
                            relative,
                            before + event.transferred_bytes,
                            total_bytes,
                            completed,
                            total_entries,
                        )
                    )

            upload_file(
                client,
                local.absolute,
                posixpath.join(temporary, local.relative),
                retries=retries,
                on_progress=child_progress,
            )
            transferred += local.size
            completed += 1
        if on_progress:
            on_progress(
                TransferProgress(
                    "commit", target, total_bytes, total_bytes, completed, total_entries
                )
            )
        _commit_remote(client, temporary, target, current_target, force)
        return TransferSummary(
            str(source), target, len(files), len(directories) + 1, total_bytes
        )
    except Exception:
        try:
            _remove_remote_path(client, temporary)
        except CubicError:
            pass
        raise


def _existing_local(target: Path) -> os.stat_result | None:
    try:
        return target.lstat()
    except FileNotFoundError:
        return None


def _remove_local(target: Path) -> None:
    if target.is_dir() and not target.is_symlink():
        shutil.rmtree(target)
    else:
        target.unlink(missing_ok=True)


def _commit_local(
    temporary: Path, target: Path, current_target: os.stat_result | None, force: bool
) -> None:
    if current_target is not None and not force:
        raise CubicError(
            f"Local target already exists: {target}. Use --force to replace it.",
            code="TARGET_EXISTS",
        )
    backup = target.with_name(f"{target.name}.cubic-backup-{_suffix()}")
    backed_up = False
    if current_target is not None:
        target.rename(backup)
        backed_up = True
    try:
        temporary.rename(target)
    except OSError as error:
        if backed_up:
            try:
                backup.rename(target)
            except OSError:
                pass
        raise CubicError(
            f"Unable to commit local target {target}: {error}", code="COMMIT_FAILED"
        ) from error
    if backed_up:
        _remove_local(backup)


def download_file(
    client: CubicClient,
    remote_file: str,
    local_file: str | Path,
    *,
    force: bool = False,
    retries: int = 2,
    limits: TransferLimits | None = None,
    on_progress: ProgressCallback | None = None,
) -> TransferSummary:
    source = normalize_remote_path(remote_file)
    source_stat = client.stat(source)
    if source_stat.is_dir:
        raise CubicError(f"Remote source is a directory: {source}", code="NOT_A_FILE")
    transfer_limits = limits or TransferLimits()
    if source_stat.size > transfer_limits.max_download_bytes:
        raise CubicError(
            f"Remote file exceeds download limit {transfer_limits.max_download_bytes} bytes: {source}",
            code="TREE_LIMIT",
        )
    target = _absolute_path(local_file)
    current_target = _existing_local(target)
    if current_target is not None and target.is_dir():
        raise CubicError(f"Local target is a directory: {target}", code="PATH_CONFLICT")
    if current_target is not None and not force:
        raise CubicError(
            f"Local target already exists: {target}. Use --force to replace it.",
            code="TARGET_EXISTS",
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.cubic-download-{_suffix()}")
    info = client.info()
    offset = 0
    try:
        with temporary.open("xb") as handle:
            while offset < source_stat.size:
                chunk = _with_retry(
                    lambda offset=offset: client.read(
                        source, offset, min(info.chunk_size, source_stat.size - offset)
                    ),
                    retries,
                )
                data = getattr(chunk, "data")
                if (
                    getattr(chunk, "size") != source_stat.size
                    or getattr(chunk, "next_offset") != offset + len(data)
                    or not data
                ):
                    raise CubicError(
                        f"Device returned an invalid read offset for {source}.",
                        code="INVALID_RESPONSE",
                    )
                handle.write(data)
                offset = getattr(chunk, "next_offset")
                if getattr(chunk, "eof") and offset != source_stat.size:
                    raise CubicError(
                        f"Device ended the download early for {source}.",
                        code="INVALID_RESPONSE",
                    )
                if on_progress:
                    on_progress(
                        TransferProgress(
                            "download",
                            source,
                            offset,
                            source_stat.size,
                            1 if offset == source_stat.size else 0,
                            1,
                        )
                    )
        if temporary.stat().st_size != source_stat.size:
            raise CubicError(
                f"Local download verification failed for {source}.",
                code="VERIFY_FAILED",
            )
        if on_progress:
            on_progress(
                TransferProgress(
                    "commit", str(target), source_stat.size, source_stat.size, 1, 1
                )
            )
        _commit_local(temporary, target, current_target, force)
        return TransferSummary(source, str(target), 1, 0, source_stat.size)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def download_path(
    client: CubicClient,
    remote_source: str,
    local_destination: str | Path | None = None,
    *,
    force: bool = False,
    retries: int = 2,
    limits: TransferLimits | None = None,
    on_progress: ProgressCallback | None = None,
) -> TransferSummary:
    source = normalize_remote_path(remote_source)
    source_stat = client.stat(source)
    target = _absolute_path(local_destination or remote_basename(source))
    if not source_stat.is_dir:
        return download_file(
            client,
            source,
            target,
            force=force,
            retries=retries,
            limits=limits,
            on_progress=on_progress,
        )
    transfer_limits = limits or TransferLimits()
    if on_progress:
        on_progress(TransferProgress("scan", source, 0, 0, 0, 0))
    directories, files, total_bytes = _scan_remote_tree(client, source, transfer_limits)
    current_target = _existing_local(target)
    if current_target is not None and not force:
        raise CubicError(
            f"Local target already exists: {target}. Use --force to replace it.",
            code="TARGET_EXISTS",
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f"{target.name}.cubic-download-{_suffix()}")
    transferred = 0
    completed = 0
    total_entries = len(directories) + len(files)
    try:
        temporary.mkdir()
        for directory in directories:
            safe_local_destination(temporary, directory).mkdir(
                parents=True, exist_ok=True
            )
            completed += 1
        for remote in files:
            destination = safe_local_destination(temporary, remote.relative)
            before = transferred

            def child_progress(
                event: TransferProgress, relative: str = remote.relative
            ) -> None:
                if on_progress:
                    on_progress(
                        TransferProgress(
                            event.phase,
                            relative,
                            before + event.transferred_bytes,
                            total_bytes,
                            completed,
                            total_entries,
                        )
                    )

            download_file(
                client,
                remote.remote,
                destination,
                retries=retries,
                limits=TransferLimits(
                    transfer_limits.max_depth, transfer_limits.max_entries, remote.size
                ),
                on_progress=child_progress,
            )
            transferred += remote.size
            completed += 1
        if on_progress:
            on_progress(
                TransferProgress(
                    "commit",
                    str(target),
                    total_bytes,
                    total_bytes,
                    completed,
                    total_entries,
                )
            )
        _commit_local(temporary, target, current_target, force)
        return TransferSummary(
            source, str(target), len(files), len(directories) + 1, total_bytes
        )
    except Exception:
        if temporary.exists():
            shutil.rmtree(temporary, ignore_errors=True)
        raise
