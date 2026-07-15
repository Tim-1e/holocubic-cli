import json
import tempfile
import unittest
from pathlib import Path

from holocubic_cli_python.config import (
    ConfigStore,
    default_config_path,
    resolve_device,
    validate_device_name,
)
from holocubic_cli_python.errors import UsageError


class ConfigTests(unittest.TestCase):
    def test_default_paths_and_names(self) -> None:
        self.assertEqual(
            default_config_path({"APPDATA": "C:/Users/A/AppData/Roaming"}, "win32"),
            Path("C:/Users/A/AppData/Roaming") / "cubic" / "config.json",
        )
        self.assertEqual(validate_device_name(" 桌面 "), "桌面")
        for value in ("", ".", "..", "a/b", "a\\b", "a\0b"):
            with self.subTest(value=value), self.assertRaises(UsageError):
                validate_device_name(value)

    def test_atomic_unicode_config_and_resolution_precedence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested" / "config.json"
            store = ConfigStore(path)
            store.write(
                {
                    "version": 1,
                    "current": "桌面",
                    "devices": {"桌面": {"url": "192.0.2.42"}},
                }
            )
            self.assertEqual(
                store.read()["devices"]["桌面"]["url"], "http://192.0.2.42/devtools"
            )
            self.assertIn(
                "桌面", json.loads(path.read_text(encoding="utf-8"))["devices"]
            )
            self.assertEqual(
                resolve_device(store, "option", {"CUBIC_HOST": "env"})["source"],
                "option",
            )
            self.assertEqual(
                resolve_device(store, None, {"CUBIC_HOST": "env"})["source"],
                "environment",
            )
            self.assertEqual(resolve_device(store, None, {})["name"], "桌面")


if __name__ == "__main__":
    unittest.main()
