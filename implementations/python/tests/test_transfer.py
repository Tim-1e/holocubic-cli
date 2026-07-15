import os
import tempfile
import unittest
from pathlib import Path

from holocubic_cli_python.client import CubicClient
from holocubic_cli_python.errors import CubicError
from holocubic_cli_python.models import TransferLimits
from holocubic_cli_python.transfer import download_path, upload_file, upload_path

from mock_devtools import MockDevTools


class TransferTests(unittest.TestCase):
    def test_file_upload_retries_force_and_cleanup(self) -> None:
        with (
            MockDevTools(chunk_size=3, upload_failures=1) as mock,
            tempfile.TemporaryDirectory() as directory,
        ):
            local = Path(directory) / "数据.bin"
            local.write_bytes(bytes((0, 1, 2, 3, 4, 5, 255)))
            (mock.root / "target").mkdir()
            client = CubicClient(mock.base_url)
            result = upload_file(client, local, "/sd/target/数据.bin")
            self.assertEqual(result.bytes, 7)
            self.assertEqual(
                (mock.root / "target" / "数据.bin").read_bytes(), local.read_bytes()
            )
            with self.assertRaisesRegex(CubicError, "Use --force"):
                upload_file(client, local, "/sd/target/数据.bin")
            local.write_bytes(bytes((9, 8)))
            upload_file(client, local, "/sd/target/数据.bin", force=True)
            self.assertEqual(
                (mock.root / "target" / "数据.bin").read_bytes(), bytes((9, 8))
            )
            self.assertFalse(
                any(".cubic-" in item.name for item in (mock.root / "target").iterdir())
            )

    def test_recursive_roundtrip_empty_directories_and_limits(self) -> None:
        with (
            MockDevTools(chunk_size=3) as mock,
            tempfile.TemporaryDirectory() as directory,
        ):
            source = Path(directory) / "source"
            (source / "empty").mkdir(parents=True)
            (source / "nested" / "深").mkdir(parents=True)
            (source / "hello.txt").write_text("hello\n", encoding="utf-8")
            (source / "nested" / "深" / "data.bin").write_bytes(bytes((0, 255, 1, 2)))
            client = CubicClient(mock.base_url)
            uploaded = upload_path(client, source, "/sd/uploaded")
            self.assertEqual(uploaded.files, 2)
            target = Path(directory) / "copy"
            downloaded = download_path(client, "/sd/uploaded", target)
            self.assertEqual(downloaded.files, 2)
            self.assertEqual(
                (target / "nested" / "深" / "data.bin").read_bytes(),
                bytes((0, 255, 1, 2)),
            )
            self.assertEqual(list((target / "empty").iterdir()), [])
            with self.assertRaisesRegex(CubicError, "download limit 3"):
                download_path(
                    client,
                    "/sd/uploaded",
                    Path(directory) / "limited",
                    limits=TransferLimits(max_download_bytes=3),
                )

    @unittest.skipIf(
        os.name == "nt", "symlink creation may require Windows developer mode"
    )
    def test_rejects_symbolic_links_before_remote_write(self) -> None:
        with MockDevTools() as mock, tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source"
            source.mkdir()
            (source / "file").write_text("x", encoding="utf-8")
            source_link = Path(directory) / "source-link"
            source_link.symlink_to(source, target_is_directory=True)
            with self.assertRaisesRegex(CubicError, "Symbolic links"):
                upload_path(CubicClient(mock.base_url), source_link, "/sd/source-link")
            (source / "link").symlink_to(source / "file")
            before = len(mock.requests)
            with self.assertRaisesRegex(CubicError, "Symbolic links"):
                upload_path(CubicClient(mock.base_url), source, "/sd/tree")
            self.assertFalse(
                any(route in {"mkdir", "upload"} for _, route in mock.requests[before:])
            )


if __name__ == "__main__":
    unittest.main()
