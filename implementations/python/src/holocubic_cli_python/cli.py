"""Command-line interface matching the Node reference implementation."""

import argparse
import json
import sys
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from . import __version__
from .app import validate_app_directory, validate_app_id
from .client import CubicClient, public_info
from .config import (
    ConfigStore,
    default_config_path,
    resolve_device,
    validate_device_name,
)
from .errors import CubicError, UsageError
from .models import TransferLimits
from .remote_path import assert_can_delete_remote, normalize_remote_path, remote_join
from .transfer import (
    TransferProgress,
    download_path,
    ensure_remote_directory,
    upload_path,
)
from .url import normalize_device_url


def _positive_integer(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _add_transfer_options(
    parser: argparse.ArgumentParser, *, download: bool = False
) -> None:
    parser.add_argument(
        "-f", "--force", action="store_true", help="replace an existing target"
    )
    parser.add_argument(
        "--retries",
        type=_positive_integer,
        default=2,
        help="retry transient chunk failures",
    )
    parser.add_argument(
        "--max-depth", type=_positive_integer, default=32, help="recursive depth limit"
    )
    parser.add_argument(
        "--max-entries",
        type=_positive_integer,
        default=4096,
        help="recursive entry limit",
    )
    if download:
        parser.add_argument(
            "--max-bytes",
            type=_positive_integer,
            default=128 * 1024 * 1024,
            help="aggregate directory download limit",
        )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="cubic-py",
        description="Manage HoloCubic DevTools devices and SD-card files",
    )
    parser.add_argument(
        "--version", action="version", version=f"%(prog)s {__version__}"
    )
    parser.add_argument(
        "-H", "--host", help="use a device without changing saved configuration"
    )
    parser.add_argument(
        "--timeout", type=_positive_integer, default=60_000, metavar="MILLISECONDS"
    )
    parser.add_argument(
        "--json",
        action="store_true",
        dest="as_json",
        help="write stable JSON to stdout",
    )
    parser.add_argument(
        "--quiet", action="store_true", help="suppress progress and success messages"
    )
    parser.add_argument("--config", help="override the configuration file")
    commands = parser.add_subparsers(dest="command", required=True)

    device = commands.add_parser("device", help="manage saved devices")
    device_commands = device.add_subparsers(dest="device_command", required=True)
    device_add = device_commands.add_parser("add", help="verify and save a device")
    device_add.add_argument("name")
    device_add.add_argument("device_host")
    device_add.add_argument("--no-use", action="store_false", dest="use", default=True)
    device_commands.add_parser("list", help="list saved devices")
    device_use = device_commands.add_parser("use", help="select a saved device")
    device_use.add_argument("name")
    device_remove = device_commands.add_parser("remove", help="remove a saved device")
    device_remove.add_argument("name")

    commands.add_parser("ping", help="test the selected device")
    commands.add_parser("info", help="show device capabilities and transfer limits")
    list_parser = commands.add_parser("ls", help="list a remote directory")
    list_parser.add_argument("remote", nargs="?")
    stat_parser = commands.add_parser(
        "stat", help="show remote file or directory metadata"
    )
    stat_parser.add_argument("remote")
    cat_parser = commands.add_parser("cat", help="write a remote file to stdout")
    cat_parser.add_argument("remote")
    mkdir_parser = commands.add_parser(
        "mkdir", help="create a remote directory and missing parents"
    )
    mkdir_parser.add_argument("remote")
    move_parser = commands.add_parser("mv", help="rename or move a remote path")
    move_parser.add_argument("source")
    move_parser.add_argument("target")
    remove_parser = commands.add_parser("rm", help="remove a remote file or directory")
    remove_parser.add_argument("remote")
    remove_parser.add_argument("-r", "--recursive", action="store_true")
    remove_parser.add_argument("-y", "--yes", action="store_true")

    push_parser = commands.add_parser(
        "push", aliases=["upload"], help="upload a file or directory recursively"
    )
    push_parser.add_argument("local")
    push_parser.add_argument("remote", nargs="?")
    _add_transfer_options(push_parser)
    pull_parser = commands.add_parser(
        "pull", aliases=["download"], help="download a file or directory recursively"
    )
    pull_parser.add_argument("remote")
    pull_parser.add_argument("local", nargs="?")
    _add_transfer_options(pull_parser, download=True)

    devrun = commands.add_parser("devrun", help="read, save, or run DevRun source")
    devrun_commands = devrun.add_subparsers(dest="devrun_command", required=True)
    devrun_read = devrun_commands.add_parser("read", help="read DevRun source")
    devrun_read.add_argument("output", nargs="?")
    devrun_read.add_argument("-f", "--force", action="store_true")
    for name in ("save", "run"):
        child = devrun_commands.add_parser(
            name, help=f"{'save and run' if name == 'run' else 'save'} DevRun source"
        )
        child.add_argument("file")

    app = commands.add_parser("app", help="list and install SD-card apps")
    app_commands = app.add_subparsers(dest="app_command", required=True)
    app_commands.add_parser("list", help="list installed apps")
    app_install = app_commands.add_parser(
        "install", help="validate and upload an app directory"
    )
    app_install.add_argument("directory")
    app_install.add_argument("--id")
    app_install.add_argument("-f", "--force", action="store_true")
    app_remove = app_commands.add_parser(
        "remove", help="remove an installed app directory"
    )
    app_remove.add_argument("id")
    app_remove.add_argument("-y", "--yes", action="store_true", required=True)
    return parser


def _configure_stdio() -> None:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="backslashreplace")


def _format_bytes(value: int) -> str:
    if value < 1024:
        return f"{value} B"
    if value < 1024**2:
        return f"{value / 1024:.1f} KiB"
    return f"{value / 1024**2:.1f} MiB"


class _Runtime:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        config_path = (
            Path(args.config).resolve() if args.config else default_config_path()
        )
        self.store = ConfigStore(config_path)

    def target(self) -> tuple[CubicClient, str | None, str]:
        resolved = resolve_device(self.store, self.args.host)
        url = str(resolved["url"])
        return CubicClient(url, self.args.timeout), resolved["name"], url

    def output(self, value: Any, human: Sequence[str] | str | None = None) -> None:
        if self.args.as_json:
            print(json.dumps(value, ensure_ascii=False, separators=(",", ":")))
        elif not self.args.quiet and human is not None:
            if isinstance(human, str):
                print(human)
            else:
                for line in human:
                    print(line)

    def progress(self, event: TransferProgress) -> None:
        if self.args.as_json or self.args.quiet:
            return
        if event.phase == "scan":
            print(f"Scanning {event.path} ...", file=sys.stderr)
            return
        total = f" / {_format_bytes(event.total_bytes)}" if event.total_bytes else ""
        line = f"{event.phase:<8} {_format_bytes(event.transferred_bytes)}{total}  {event.path}"
        if sys.stderr.isatty():
            print(
                f"\r{line:<90}",
                end="\n" if event.phase == "commit" else "",
                file=sys.stderr,
            )
        elif event.phase == "commit" or event.transferred_bytes == event.total_bytes:
            print(line, file=sys.stderr)

    def execute(self) -> None:
        args = self.args
        if args.command == "device":
            self._device()
        elif args.command == "ping":
            client, name, url = self.target()
            started = time.perf_counter()
            info = client.info(force=True)
            latency = round((time.perf_counter() - started) * 1000)
            self.output(
                {
                    "ok": True,
                    "name": name,
                    "url": url,
                    "latency_ms": latency,
                    "version": info.version,
                },
                f"Connected to {name or url} in {latency} ms{f' ({info.version})' if info.version else ''}.",
            )
        elif args.command == "info":
            client, name, url = self.target()
            info = client.info(force=True)
            self.output(
                public_info(info, url, name),
                [
                    f"Device:       {name or '(temporary)'}",
                    f"URL:          {url}",
                    f"Version:      {info.version or 'unknown'}",
                    f"API:          v{info.api_version}",
                    f"Root:         {info.root_path}",
                    f"Chunk size:   {_format_bytes(info.chunk_size)}",
                    f"Max file:     {_format_bytes(info.max_file_size)}",
                    f"Capabilities: {', '.join(info.capabilities)}",
                ],
            )
        elif args.command == "ls":
            client, _, _ = self.target()
            result = client.list(normalize_remote_path(args.remote))
            self.output(
                result.public(),
                [
                    f"{'d' if item.is_dir else '-'} {'' if item.is_dir else str(item.size):>10}  {item.name}{'/' if item.is_dir else ''}"
                    for item in result.items
                ],
            )
        elif args.command == "stat":
            client, _, _ = self.target()
            result = client.stat(args.remote)
            self.output(
                result.public(),
                [
                    f"Path: {result.path}",
                    f"Type: {'directory' if result.is_dir else 'file'}",
                    f"Size: {result.size} bytes",
                    f"MIME: {result.mime}",
                ],
            )
        elif args.command == "cat":
            if args.as_json:
                raise UsageError("`cat` cannot be combined with --json.")
            client, _, _ = self.target()
            remote = normalize_remote_path(args.remote)
            item = client.stat(remote)
            if item.is_dir:
                raise CubicError(
                    f"Remote source is a directory: {remote}", code="NOT_A_FILE"
                )
            info = client.info()
            offset = 0
            writer = getattr(sys.stdout, "buffer", sys.stdout)
            while offset < item.size:
                chunk = client.read(
                    remote, offset, min(info.chunk_size, item.size - offset)
                )
                if chunk.next_offset != offset + len(chunk.data) or not chunk.data:
                    raise CubicError(
                        f"Device returned an invalid read offset for {remote}.",
                        code="INVALID_RESPONSE",
                    )
                writer.write(chunk.data)
                offset = chunk.next_offset
        elif args.command == "mkdir":
            client, _, _ = self.target()
            target = normalize_remote_path(args.remote)
            ensure_remote_directory(client, target)
            self.output({"path": target}, f"Created {target}")
        elif args.command == "mv":
            client, _, _ = self.target()
            source = normalize_remote_path(args.source)
            target = normalize_remote_path(args.target)
            client.rename(source, target)
            self.output(
                {"source": source, "target": target}, f"Moved {source} -> {target}"
            )
        elif args.command == "rm":
            client, _, _ = self.target()
            target = normalize_remote_path(args.remote)
            assert_can_delete_remote(target)
            item = client.stat(target)
            if item.is_dir:
                if not args.recursive:
                    raise UsageError(
                        f"Remote path is a directory; use --recursive: {target}"
                    )
                if not args.yes:
                    raise UsageError("Recursive deletion requires --yes.")
                client.rmdir(target, True)
            else:
                client.remove(target)
            self.output(
                {"removed": target, "recursive": item.is_dir}, f"Removed {target}"
            )
        elif args.command in {"push", "upload"}:
            client, _, _ = self.target()
            result = upload_path(
                client,
                Path(args.local),
                args.remote,
                force=args.force,
                retries=args.retries,
                limits=TransferLimits(args.max_depth, args.max_entries),
                on_progress=self.progress,
            )
            self.output(
                result.public(),
                f"Uploaded {result.files} file(s), {_format_bytes(result.bytes)} -> {result.destination}",
            )
        elif args.command in {"pull", "download"}:
            client, _, _ = self.target()
            result = download_path(
                client,
                args.remote,
                Path(args.local) if args.local else None,
                force=args.force,
                retries=args.retries,
                limits=TransferLimits(args.max_depth, args.max_entries, args.max_bytes),
                on_progress=self.progress,
            )
            self.output(
                result.public(),
                f"Downloaded {result.files} file(s), {_format_bytes(result.bytes)} -> {result.destination}",
            )
        elif args.command == "devrun":
            self._devrun()
        elif args.command == "app":
            self._app()
        else:
            raise UsageError(f"Unknown command: {args.command}")

    def _device(self) -> None:
        args = self.args
        if args.device_command == "add":
            name = validate_device_name(args.name)
            url = normalize_device_url(args.device_host)
            info = CubicClient(url, args.timeout).info(force=True)
            config = self.store.read()
            profile = {"url": url}
            if info.version:
                profile["version"] = info.version
            config["devices"][name] = profile
            if args.use:
                config["current"] = name
            self.store.write(config)
            self.output(
                {
                    "name": name,
                    "url": url,
                    "selected": config["current"] == name,
                    "version": info.version,
                },
                [f"Added {name}: {url}"]
                + ([f"Selected device: {name}"] if config["current"] == name else []),
            )
        elif args.device_command == "list":
            config = self.store.read()
            rows = [
                {
                    "name": name,
                    "url": profile["url"],
                    "version": profile.get("version"),
                    "selected": name == config["current"],
                }
                for name, profile in sorted(config["devices"].items())
            ]
            lines: list[str] = []
            for row in rows:
                suffix = f"  {row['version']}" if row["version"] else ""
                lines.append(
                    f"{'*' if row['selected'] else ' '} {row['name']:<16} {row['url']}{suffix}"
                )
            if not lines:
                lines = ["No saved devices."]
            self.output({"current": config["current"], "devices": rows}, lines)
        elif args.device_command in {"use", "remove"}:
            name = validate_device_name(args.name)
            config = self.store.read()
            if name not in config["devices"]:
                raise CubicError(f"Unknown device: {name}", code="NO_DEVICE")
            if args.device_command == "use":
                config["current"] = name
                self.store.write(config)
                self.output({"current": name}, f"Selected device: {name}")
            else:
                del config["devices"][name]
                if config["current"] == name:
                    config["current"] = None
                self.store.write(config)
                self.output(
                    {"removed": name, "current": config["current"]},
                    f"Removed device: {name}",
                )

    def _devrun(self) -> None:
        args = self.args
        client, _, _ = self.target()
        if args.devrun_command == "read":
            source = client.read_devrun()
            if not args.output:
                if args.as_json:
                    self.output({"source": source})
                else:
                    print(source, end="")
                return
            output_path = Path(args.output).resolve()
            mode = "w" if args.force else "x"
            try:
                with output_path.open(mode, encoding="utf-8", newline="") as handle:
                    handle.write(source)
            except FileExistsError as error:
                raise CubicError(
                    f"Local target already exists: {output_path}. Use --force to replace it.",
                    code="TARGET_EXISTS",
                ) from error
            self.output(
                {"path": str(output_path), "bytes": len(source.encode("utf-8"))},
                f"Saved DevRun source to {output_path}",
            )
        else:
            source = Path(args.file).resolve().read_text(encoding="utf-8")
            run = args.devrun_command == "run"
            result = client.save_devrun(source, run)
            self.output(
                result.public(),
                f"{'Ran' if run else 'Saved'} {result.entry} ({result.bytes} bytes)",
            )

    def _app(self) -> None:
        args = self.args
        client, _, _ = self.target()
        if args.app_command == "list":
            result = client.apps()
            self.output(
                result.public(),
                [
                    f"{item.get('id', '')}{' *' if item.get('id') == result.current_app_id else ''}"
                    for item in result.apps
                ],
            )
        elif args.app_command == "install":
            validated = validate_app_directory(Path(args.directory), args.id)
            apps = client.apps()
            if validated.id == apps.run_app_id:
                raise UsageError(
                    f"Refusing to replace {apps.run_app_id}; use the dedicated devrun commands."
                )
            if validated.id == apps.current_app_id:
                raise UsageError(
                    f"Refusing to replace the currently running app {validated.id}; switch apps first."
                )
            transfer = upload_path(
                client,
                validated.source,
                validated.destination,
                force=args.force,
                on_progress=self.progress,
            )
            result = {
                **validated.public(),
                "transfer": transfer.public(),
                "rescanRequired": True,
            }
            self.output(
                result,
                [
                    f"Installed {validated.id} -> {validated.destination}",
                    "Rescan apps on the device before first launch.",
                ],
            )
        elif args.app_command == "remove":
            app_id = validate_app_id(args.id)
            target = remote_join("/sd/apps", app_id)
            apps = client.apps()
            if app_id == apps.run_app_id:
                raise UsageError(
                    f"Refusing to remove {apps.run_app_id}; it is managed by the dedicated devrun commands."
                )
            if app_id == apps.current_app_id:
                raise UsageError(
                    f"Refusing to remove the currently running app {app_id}; switch apps first."
                )
            client.rmdir(target, True)
            self.output({"removed": app_id, "path": target}, f"Removed app {app_id}")


def main(argv: Sequence[str] | None = None) -> int:
    _configure_stdio()
    args = build_parser().parse_args(argv)
    try:
        _Runtime(args).execute()
        return 0
    except CubicError as error:
        print(f"cubic-py: {error}", file=sys.stderr)
        return error.exit_code
    except (OSError, UnicodeError) as error:
        print(f"cubic-py: {error}", file=sys.stderr)
        return 1
