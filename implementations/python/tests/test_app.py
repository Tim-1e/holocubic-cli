import os
import tempfile
import unittest
from pathlib import Path

from holocubic_cli_python.app import validate_app_directory, validate_app_id
from holocubic_cli_python.errors import CubicError, UsageError


class AppTests(unittest.TestCase):
    def test_validates_standard_app(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "sample-app"
            app.mkdir()
            (app / "app.info").write_text(
                "name = Sample\nentry = main.lua\n", encoding="utf-8"
            )
            (app / "main.lua").write_text("print('ok')\n", encoding="utf-8")
            result = validate_app_directory(app)
            self.assertEqual(result.id, "sample-app")
            self.assertEqual(result.destination, "/sd/apps/sample-app")

    def test_rejects_invalid_apps_and_ids(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "main.lua").write_text("print('ok')\n", encoding="utf-8")
            with self.assertRaises(CubicError):
                validate_app_directory(root)
        for value in ("../bad", ".cubic-upload-x"):
            with self.subTest(value=value), self.assertRaises(UsageError):
                validate_app_id(value)

    @unittest.skipIf(
        os.name == "nt", "symlink creation may require Windows developer mode"
    )
    def test_rejects_a_symbolic_link_app_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            app = Path(directory) / "app"
            app.mkdir()
            (app / "app.info").write_text("entry = main.lua\n", encoding="utf-8")
            (app / "main.lua").write_text("print('ok')\n", encoding="utf-8")
            link = Path(directory) / "app-link"
            link.symlink_to(app, target_is_directory=True)
            with self.assertRaisesRegex(CubicError, "regular directory"):
                validate_app_directory(link)


if __name__ == "__main__":
    unittest.main()
