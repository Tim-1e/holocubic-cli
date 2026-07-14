import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from holocubic_cli_python.client import fetch_info, public_info


FIXTURE = {
    "ok": True,
    "version": "conformance-fixture",
    "root_path": "/sd",
    "chunk_size": 262144,
    "max_file_size": 67108864,
    "run_app_id": "devrun",
    "run_app_main": "/sd/apps/devrun/main.lua",
}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path != "/devtools/api/info":
            self.send_error(404)
            return
        body = json.dumps(FIXTURE).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *args: object) -> None:
        del args


class ClientTests(unittest.TestCase):
    def test_fetches_and_normalizes_legacy_info(self) -> None:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            info = fetch_info(f"127.0.0.1:{server.server_port}")
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
        self.assertEqual(info["api_version"], 1)
        self.assertEqual(info["root_path"], "/sd")
        self.assertIn("fs.read", info["capabilities"])

    def test_rejects_invalid_handshake(self) -> None:
        with self.assertRaises(ValueError):
            public_info({"ok": True, **{key: value for key, value in FIXTURE.items() if key != "root_path"}}, "http://host/devtools")
