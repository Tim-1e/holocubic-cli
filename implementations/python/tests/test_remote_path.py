import tempfile
import unittest
from pathlib import Path

from holocubic_cli_python.errors import UsageError
from holocubic_cli_python.remote_path import (
    assert_can_delete_remote,
    normalize_remote_path,
    remote_join,
    safe_local_destination,
)


class RemotePathTests(unittest.TestCase):
    def test_normalizes_and_confines_remote_paths(self) -> None:
        self.assertEqual(normalize_remote_path(None), "/sd")
        self.assertEqual(normalize_remote_path("apps\\demo"), "/sd/apps/demo")
        self.assertEqual(normalize_remote_path("/sd//apps/./demo"), "/sd/apps/demo")
        for value in ("../etc", "/flash/file", "/sd/a\0b"):
            with self.subTest(value=value), self.assertRaises(UsageError):
                normalize_remote_path(value)

    def test_join_delete_and_local_destination_guards(self) -> None:
        self.assertEqual(remote_join("/sd/apps", "天气 app"), "/sd/apps/天气 app")
        with self.assertRaises(UsageError):
            remote_join("/sd", "../x")
        with self.assertRaises(UsageError):
            assert_can_delete_remote("/sd/./")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.assertEqual(
                safe_local_destination(root, "nested/file.txt"),
                root / "nested" / "file.txt",
            )
            with self.assertRaises(UsageError):
                safe_local_destination(root, "../escape.txt")


if __name__ == "__main__":
    unittest.main()
