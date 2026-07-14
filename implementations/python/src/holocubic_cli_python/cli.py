import argparse
import json
import os
import sys
from collections.abc import Sequence

from . import __version__
from .client import fetch_info


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="cubic-py", description="Experimental Python HoloCubic CLI")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    parser.add_argument("--host", help="device host or DevTools URL")
    parser.add_argument("--timeout", type=int, default=60_000, metavar="MILLISECONDS")
    parser.add_argument("--json", action="store_true", dest="as_json")
    subcommands = parser.add_subparsers(dest="command", required=True)
    subcommands.add_parser("info", help="show device capabilities and transfer limits")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    host = args.host or os.environ.get("CUBIC_HOST")
    if not host:
        parser.error("a device target is required through --host or CUBIC_HOST")

    try:
        info = fetch_info(host, args.timeout)
    except (ValueError, RuntimeError) as error:
        print(f"cubic-py: {error}", file=sys.stderr)
        return 1

    if args.as_json:
        print(json.dumps(info, ensure_ascii=False, separators=(",", ":")))
    else:
        print(f"URL:        {info['url']}")
        print(f"Version:    {info['version'] or 'unknown'}")
        print(f"API:        v{info['api_version']}")
        print(f"Root:       {info['root_path']}")
        print(f"Chunk size: {info['chunk_size']} bytes")
        print(f"Max file:   {info['max_file_size']} bytes")
    return 0
