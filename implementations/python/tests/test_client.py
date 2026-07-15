import unittest

from holocubic_cli_python.client import CubicClient
from holocubic_cli_python.errors import CubicError, HttpError
from holocubic_cli_python.models import LEGACY_V1_CAPABILITIES

from mock_devtools import MockDevTools


class ClientTests(unittest.TestCase):
    def test_legacy_handshake_and_explicit_capabilities(self) -> None:
        with MockDevTools() as mock:
            info = CubicClient(mock.base_url).info()
            self.assertEqual(info.api_version, 1)
            self.assertEqual(info.capabilities, LEGACY_V1_CAPABILITIES)
        with MockDevTools(capabilities=["fs.list"]) as mock:
            client = CubicClient(mock.base_url)
            self.assertEqual(client.info().capabilities, ("fs.list",))
            with self.assertRaisesRegex(CubicError, "fs.mkdir"):
                client.mkdir("/sd/nope")
            self.assertNotIn(("POST", "mkdir"), mock.requests)

    def test_filesystem_and_binary_routes(self) -> None:
        with MockDevTools(chunk_size=3) as mock:
            (mock.root / "folder").mkdir()
            (mock.root / "empty").mkdir()
            (mock.root / "folder" / "空 格.bin").write_bytes(bytes((0, 1, 2, 255)))
            client = CubicClient(mock.base_url)
            self.assertEqual(client.list("/sd/empty").items, ())
            self.assertEqual(client.list("/sd/folder").items[0].name, "空 格.bin")
            first = client.read("/sd/folder/空 格.bin", 0, 3)
            second = client.read("/sd/folder/空 格.bin", first.next_offset, 3)
            self.assertEqual(first.data, bytes((0, 1, 2)))
            self.assertFalse(first.eof)
            self.assertEqual(second.data, bytes((255,)))
            self.assertTrue(second.eof)
            client.mkdir("/sd/new")
            client.upload("/sd/new/file.bin", bytes((9, 8)), 0, 4)
            self.assertTrue(client.upload("/sd/new/file.bin", bytes((7, 6)), 2, 4).done)
            client.rename("/sd/new/file.bin", "/sd/new/moved.bin")
            client.remove("/sd/new/moved.bin")
            client.rmdir("/sd/new")
            self.assertIsNone(client.stat_or_none("/sd/new"))

    def test_apps_devrun_http_errors_and_timeout(self) -> None:
        with MockDevTools() as mock:
            client = CubicClient(mock.base_url)
            self.assertEqual(client.apps().apps[0]["id"], "devrun")
            self.assertIn("ready", client.read_devrun())
            self.assertFalse(client.save_devrun("print('saved')\n").launched)
            self.assertTrue(client.save_devrun("print('run')\n", True).launched)
            with self.assertRaises(HttpError) as caught:
                client.stat("/sd/missing")
            self.assertEqual(caught.exception.status, 404)
        with MockDevTools(info_delay=0.1) as mock:
            with self.assertRaises(CubicError) as caught:
                CubicClient(mock.base_url, 20).info()
            self.assertEqual(caught.exception.code, "TIMEOUT")


if __name__ == "__main__":
    unittest.main()
