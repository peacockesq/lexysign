from __future__ import annotations

import argparse
import asyncio
import logging
import sys


def main() -> None:
    logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
    parser = argparse.ArgumentParser(prog="lexysign-firm-mcp", description="LexySign firm stdio MCP server")
    parser.parse_args()
    from .server import run

    asyncio.run(run())


if __name__ == "__main__":
    main()
