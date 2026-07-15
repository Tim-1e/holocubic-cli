import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from mock_devtools import MockDevTools


SOURCE = Path(__file__).resolve().parents[1] / "src"


class CliTests(unittest.TestCase):
    def run_cli(
        self, cwd: Path, config: Path, *arguments: str, check: bool = True
    ) -> subprocess.CompletedProcess[str]:
        env = os.environ.copy()
        env["PYTHONPATH"] = os.pathsep.join(
            filter(None, (str(SOURCE), env.get("PYTHONPATH")))
        )
        env["CUBIC_CONFIG"] = str(config)
        result = subprocess.run(
            [sys.executable, "-m", "holocubic_cli_python", *arguments],
            cwd=cwd,
            env=env,
            text=True,
            encoding="utf-8",
            capture_output=True,
            check=False,
            timeout=30,
        )
        if check and result.returncode != 0:
            self.fail(f"CLI exited {result.returncode}: {result.stderr}")
        return result

    def test_device_files_devrun_and_app_workflows(self) -> None:
        with (
            MockDevTools(chunk_size=3) as mock,
            tempfile.TemporaryDirectory() as directory,
        ):
            cwd = Path(directory)
            config = cwd / "config.json"
            self.run_cli(cwd, config, "device", "add", "桌面", mock.base_url)
            listed = self.run_cli(cwd, config, "--json", "device", "list")
            self.assertEqual(json.loads(listed.stdout)["current"], "桌面")
            source = cwd / "source"
            (source / "empty").mkdir(parents=True)
            (source / "file.bin").write_bytes(bytes((0, 1, 2, 255)))
            self.run_cli(
                cwd, config, "--host", mock.base_url, "push", "source", "/sd/tree"
            )
            self.run_cli(
                cwd, config, "--host", mock.base_url, "pull", "/sd/tree", "copy"
            )
            self.assertEqual(
                (cwd / "copy" / "file.bin").read_bytes(), bytes((0, 1, 2, 255))
            )
            (cwd / "dev.lua").write_text("print('cli')\n", encoding="utf-8")
            self.run_cli(
                cwd, config, "--host", mock.base_url, "devrun", "run", "dev.lua"
            )
            app = cwd / "sample-app"
            app.mkdir()
            (app / "app.info").write_text("entry = main.lua\n", encoding="utf-8")
            (app / "main.lua").write_text("print('app')\n", encoding="utf-8")
            self.run_cli(
                cwd,
                config,
                "--host",
                mock.base_url,
                "app",
                "install",
                "sample-app",
                "--id",
                "cli-test",
            )
            apps = self.run_cli(
                cwd, config, "--host", mock.base_url, "--json", "app", "list"
            )
            self.assertIn(
                "cli-test", [item["id"] for item in json.loads(apps.stdout)["apps"]]
            )
            self.run_cli(
                cwd,
                config,
                "--host",
                mock.base_url,
                "app",
                "remove",
                "cli-test",
                "--yes",
            )

    def test_usage_errors_exit_two_and_json_stdout_is_clean(self) -> None:
        with MockDevTools() as mock, tempfile.TemporaryDirectory() as directory:
            cwd = Path(directory)
            config = cwd / "config.json"
            result = self.run_cli(
                cwd,
                config,
                "--host",
                mock.base_url,
                "--json",
                "cat",
                "/sd/apps/devrun/main.lua",
                check=False,
            )
            self.assertEqual(result.returncode, 2)
            self.assertEqual(result.stdout, "")


if __name__ == "__main__":
    unittest.main()
