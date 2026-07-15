"""Run the shared HoloCubic CLI v1 contract against every implementation."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
PYTHON_SOURCE = ROOT / "implementations" / "python" / "src"
PYTHON_TESTS = ROOT / "implementations" / "python" / "tests"
sys.path.insert(0, str(PYTHON_TESTS))

from mock_devtools import MockDevTools  # noqa: E402


@dataclass(frozen=True)
class Implementation:
    name: str
    command: tuple[str, ...]
    env: dict[str, str]


class Runner:
    def __init__(self, implementation: Implementation, cwd: Path, config: Path) -> None:
        self.implementation = implementation
        self.cwd = cwd
        self.env = implementation.env.copy()
        self.env["CUBIC_CONFIG"] = str(config)

    def raw(
        self,
        *arguments: str,
        expected: int = 0,
        env: dict[str, str] | None = None,
    ) -> subprocess.CompletedProcess[bytes]:
        current_env = self.env.copy()
        if env:
            current_env.update(env)
        result = subprocess.run(
            [*self.implementation.command, *arguments],
            cwd=self.cwd,
            env=current_env,
            capture_output=True,
            timeout=30,
            check=False,
        )
        if result.returncode != expected:
            stdout = result.stdout.decode("utf-8", errors="replace")
            stderr = result.stderr.decode("utf-8", errors="replace")
            raise AssertionError(
                f"{self.implementation.name} {' '.join(arguments)} exited "
                f"{result.returncode}, expected {expected}\nstdout: {stdout}\nstderr: {stderr}"
            )
        return result

    def json(
        self, *arguments: str, env: dict[str, str] | None = None
    ) -> dict[str, Any]:
        result = self.raw("--json", *arguments, env=env)
        try:
            payload = json.loads(result.stdout.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as error:
            raise AssertionError(
                f"{self.implementation.name} returned invalid JSON: {result.stdout!r}"
            ) from error
        if not isinstance(payload, dict):
            raise AssertionError(
                f"{self.implementation.name} returned non-object JSON: {payload!r}"
            )
        if result.stderr:
            raise AssertionError(
                f"{self.implementation.name} polluted JSON mode stderr: "
                f"{result.stderr.decode('utf-8', errors='replace')}"
            )
        return payload


def require_fields(payload: dict[str, Any], fields: set[str], label: str) -> None:
    missing = fields.difference(payload)
    if missing:
        raise AssertionError(f"{label} omitted fields {sorted(missing)}: {payload}")


def exercise(implementation: Implementation) -> dict[str, Any]:
    with (
        MockDevTools(chunk_size=3, upload_failures=1) as mock,
        tempfile.TemporaryDirectory(
            prefix=f"cubic-{implementation.name}-"
        ) as directory,
    ):
        cwd = Path(directory)
        runner = Runner(implementation, cwd, cwd / "config.json")
        host = mock.base_url

        runner.raw("--version")
        info = runner.json("info", env={"CUBIC_HOST": host})
        require_fields(
            info,
            {
                "url",
                "api_version",
                "route_base",
                "root_path",
                "chunk_size",
                "max_file_size",
                "max_code_bytes",
                "run_app_id",
                "run_app_main",
                "capabilities",
            },
            f"{implementation.name} info",
        )

        added = runner.json("device", "add", "桌面", host)
        if not added.get("selected"):
            raise AssertionError(
                f"{implementation.name} did not select the added device"
            )
        runner.json("device", "add", "备用", host, "--no-use")
        devices = runner.json("device", "list")
        if devices.get("current") != "桌面":
            raise AssertionError(
                f"{implementation.name} saved the wrong current device: {devices}"
            )
        runner.json("device", "use", "备用")
        runner.json("device", "use", "桌面")
        runner.json("device", "remove", "备用")

        ping = runner.json("ping")
        if ping.get("ok") is not True or ping.get("name") != "桌面":
            raise AssertionError(f"{implementation.name} ping mismatch: {ping}")

        created = runner.json("mkdir", "/sd/work/嵌套")
        if created != {"path": "/sd/work/嵌套"}:
            raise AssertionError(f"{implementation.name} mkdir mismatch: {created}")

        source = cwd / "source"
        (source / "empty").mkdir(parents=True)
        (source / "nested" / "深").mkdir(parents=True)
        (source / "hello.txt").write_text("hello\n", encoding="utf-8", newline="")
        (source / "zero.bin").write_bytes(b"")
        binary = bytes((0, 1, 2, 3, 255, 10, 13))
        (source / "nested" / "深" / "data.bin").write_bytes(binary)

        if os.name != "nt":
            source_link = cwd / "source-link"
            source_link.symlink_to(source, target_is_directory=True)
            runner.raw("--json", "push", "source-link", "/sd/source-link", expected=1)
            if (mock.root / "source-link").exists():
                raise AssertionError(
                    f"{implementation.name} followed a symbolic-link source"
                )

        pushed = runner.json("push", "source", "/sd/uploaded")
        if (pushed.get("files"), pushed.get("directories"), pushed.get("bytes")) != (
            3,
            4,
            13,
        ):
            raise AssertionError(
                f"{implementation.name} push summary mismatch: {pushed}"
            )
        if not (mock.root / "uploaded" / "empty").is_dir():
            raise AssertionError(
                f"{implementation.name} lost an empty directory on upload"
            )
        runner.raw("--json", "push", "source", "/sd/uploaded", expected=1)
        runner.json("push", "source", "/sd/uploaded", "--force")

        stat = runner.json("stat", "/sd/uploaded")
        listing = runner.json("ls", "/sd/uploaded")
        names = [(item["name"], item["isDir"]) for item in listing["items"]]
        if names != [
            ("empty", True),
            ("hello.txt", False),
            ("nested", True),
            ("zero.bin", False),
        ]:
            raise AssertionError(f"{implementation.name} list mismatch: {listing}")
        if stat.get("isDir") is not True:
            raise AssertionError(f"{implementation.name} stat mismatch: {stat}")

        cat = runner.raw("cat", "/sd/uploaded/nested/深/data.bin")
        if cat.stdout != binary:
            raise AssertionError(
                f"{implementation.name} cat changed binary data: {cat.stdout!r}"
            )

        mock.read_failures = 1
        pulled = runner.json("pull", "/sd/uploaded", "copy")
        if (pulled.get("files"), pulled.get("directories"), pulled.get("bytes")) != (
            3,
            4,
            13,
        ):
            raise AssertionError(
                f"{implementation.name} pull summary mismatch: {pulled}"
            )
        if (cwd / "copy" / "nested" / "深" / "data.bin").read_bytes() != binary:
            raise AssertionError(
                f"{implementation.name} changed downloaded binary data"
            )
        if list((cwd / "copy" / "empty").iterdir()):
            raise AssertionError(
                f"{implementation.name} changed an empty downloaded directory"
            )
        if (cwd / "copy" / "zero.bin").read_bytes() != b"":
            raise AssertionError(
                f"{implementation.name} changed an empty downloaded file"
            )
        runner.raw("--json", "pull", "/sd/uploaded", "copy", expected=1)
        (cwd / "copy" / "hello.txt").write_text("changed", encoding="utf-8")
        runner.json("pull", "/sd/uploaded", "copy", "--force")
        if (cwd / "copy" / "hello.txt").read_text(encoding="utf-8") != "hello\n":
            raise AssertionError(
                f"{implementation.name} did not replace a forced download"
            )
        runner.raw(
            "--json",
            "pull",
            "/sd/uploaded",
            "limited-copy",
            "--max-bytes",
            "1",
            expected=1,
        )
        if (cwd / "limited-copy").exists():
            raise AssertionError(
                f"{implementation.name} wrote before enforcing download limits"
            )
        mock.malicious_list_entry = True
        runner.raw("--json", "pull", "/sd/uploaded", "unsafe-copy", expected=1)
        mock.malicious_list_entry = False
        if (cwd / "unsafe-copy").exists():
            raise AssertionError(
                f"{implementation.name} accepted an unsafe device path"
            )

        moved = runner.json("mv", "/sd/uploaded/hello.txt", "/sd/uploaded/renamed.txt")
        removed_file = runner.json("rm", "/sd/uploaded/renamed.txt")
        runner.raw("rm", "/sd/uploaded", expected=2)
        removed_tree = runner.json("rm", "/sd/uploaded", "--recursive", "--yes")
        if moved.get("target") != "/sd/uploaded/renamed.txt":
            raise AssertionError(f"{implementation.name} mv mismatch: {moved}")
        if (
            removed_file.get("recursive") is not False
            or removed_tree.get("recursive") is not True
        ):
            raise AssertionError(f"{implementation.name} rm mismatch")

        source_code = "print('跨语言')\n"
        (cwd / "dev.lua").write_text(source_code, encoding="utf-8", newline="")
        saved = runner.json("devrun", "save", "dev.lua")
        ran = runner.json("devrun", "run", "dev.lua")
        read = runner.json("devrun", "read")
        runner.json("devrun", "read", "dev-copy.lua")
        if (
            read.get("source") != source_code
            or (cwd / "dev-copy.lua").read_text(encoding="utf-8") != source_code
        ):
            raise AssertionError(f"{implementation.name} DevRun roundtrip mismatch")
        if saved.get("launched") is not False or ran.get("launched") is not True:
            raise AssertionError(f"{implementation.name} DevRun launch flags mismatch")

        app = cwd / "sample-app"
        app.mkdir()
        (app / "app.info").write_text(
            "entry = main.lua\n", encoding="utf-8", newline=""
        )
        (app / "main.lua").write_text("print('app')\n", encoding="utf-8", newline="")
        if os.name != "nt":
            app_link = cwd / "sample-app-link"
            app_link.symlink_to(app, target_is_directory=True)
            runner.raw("--json", "app", "install", "sample-app-link", expected=1)
        installed = runner.json("app", "install", "sample-app", "--id", "cli-test")
        apps = runner.json("app", "list")
        app_ids = sorted(item["id"] for item in apps["apps"])
        if (
            app_ids != ["cli-test", "devrun"]
            or installed.get("rescanRequired") is not True
        ):
            raise AssertionError(f"{implementation.name} app install/list mismatch")
        removed_app = runner.json("app", "remove", "cli-test", "--yes")
        if removed_app.get("removed") != "cli-test":
            raise AssertionError(f"{implementation.name} app removal mismatch")

        runner.raw("--json", "cat", "/sd/apps/devrun/main.lua", expected=2)
        runner.raw("rm", "/sd", "--recursive", "--yes", expected=2)
        if any(".cubic-" in entry.name for entry in mock.root.rglob("*")):
            raise AssertionError(
                f"{implementation.name} left transactional temp files on the device"
            )

        return {
            "info": {
                key: info[key]
                for key in (
                    "api_version",
                    "route_base",
                    "root_path",
                    "chunk_size",
                    "max_file_size",
                    "max_code_bytes",
                    "run_app_id",
                    "run_app_main",
                    "capabilities",
                )
            },
            "push": {key: pushed[key] for key in ("files", "directories", "bytes")},
            "pull": {key: pulled[key] for key in ("files", "directories", "bytes")},
            "listing": names,
            "devrun": {
                "saved": saved["launched"],
                "ran": ran["launched"],
                "bytes": ran["bytes"],
            },
            "apps": app_ids,
        }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run the full HoloCubic CLI v1 contract"
    )
    parser.add_argument("--node", type=Path)
    parser.add_argument("--python", action="store_true", dest="python_impl")
    parser.add_argument("--rust", type=Path)
    args = parser.parse_args()
    if not any((args.node, args.python_impl, args.rust)):
        parser.error("select at least one implementation")

    base_env = os.environ.copy()
    implementations: list[Implementation] = []
    if args.node:
        implementations.append(
            Implementation("node", ("node", str(args.node.resolve())), base_env)
        )
    if args.python_impl:
        python_env = base_env.copy()
        python_env["PYTHONPATH"] = os.pathsep.join(
            filter(None, (str(PYTHON_SOURCE), python_env.get("PYTHONPATH")))
        )
        implementations.append(
            Implementation(
                "python",
                (sys.executable, "-m", "holocubic_cli_python"),
                python_env,
            )
        )
    if args.rust:
        implementations.append(
            Implementation("rust", (str(args.rust.resolve()),), base_env)
        )

    observations = [exercise(implementation) for implementation in implementations]
    reference = observations[0]
    for implementation, observation in zip(
        implementations[1:], observations[1:], strict=True
    ):
        if observation != reference:
            raise AssertionError(
                f"{implementation.name} differs from the reference implementation\n"
                f"reference: {reference}\ncandidate: {observation}"
            )
    print(f"Full CLI conformance passed for {len(observations)} implementation(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
