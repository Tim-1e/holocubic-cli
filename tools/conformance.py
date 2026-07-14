import argparse
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = json.loads((ROOT / "spec" / "fixtures" / "info-v1.json").read_text(encoding="utf-8"))


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


def run_implementation(name: str, command: list[str], host: str, env: dict[str, str]) -> dict[str, object]:
    result = subprocess.run(
        [*command, "--host", host, "--json", "info"],
        cwd=ROOT,
        env=env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        timeout=30,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError(f"{name} exited {result.returncode}: {result.stderr}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{name} returned invalid JSON: {result.stdout}") from error
    required = {
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
    }
    if not isinstance(payload, dict) or not required.issubset(payload):
        raise AssertionError(f"{name} omitted required public info fields: {payload}")
    return payload


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the HoloCubic bootstrap contract")
    parser.add_argument("--node", type=Path)
    parser.add_argument("--python", action="store_true", dest="python_impl")
    parser.add_argument("--rust", type=Path)
    args = parser.parse_args()
    if not any((args.node, args.python_impl, args.rust)):
        parser.error("select at least one implementation")

    implementations: list[tuple[str, list[str], dict[str, str]]] = []
    base_env = os.environ.copy()
    if args.node:
        implementations.append(("node", ["node", str(args.node.resolve())], base_env))
    if args.python_impl:
        python_env = base_env.copy()
        python_source = ROOT / "implementations" / "python" / "src"
        python_env["PYTHONPATH"] = os.pathsep.join(filter(None, [str(python_source), python_env.get("PYTHONPATH")]))
        implementations.append(("python", [sys.executable, "-m", "holocubic_cli_python"], python_env))
    if args.rust:
        implementations.append(("rust", [str(args.rust.resolve())], base_env))

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host = f"127.0.0.1:{server.server_port}"
        outputs = [run_implementation(name, command, host, env) for name, command, env in implementations]
    finally:
        server.shutdown()
        server.server_close()
        thread.join()

    comparable_fields = [
        "api_version",
        "route_base",
        "root_path",
        "chunk_size",
        "max_file_size",
        "max_code_bytes",
        "run_app_id",
        "run_app_main",
        "capabilities",
    ]
    reference = {field: outputs[0][field] for field in comparable_fields}
    for output in outputs[1:]:
        candidate = {field: output[field] for field in comparable_fields}
        if candidate != reference:
            raise AssertionError(f"implementation output differs from reference\n{reference}\n{candidate}")
    print(f"Bootstrap conformance passed for {len(outputs)} implementation(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
