from __future__ import annotations

import argparse
import json
import sys

from .approval import issue_approval
from .config import load_config
from .errors import FirmMcpError


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="lexysign-mcp-approve",
        description="Operator ceremony: bind an approval to a prepare_send manifest. MCP tools cannot do this.",
    )
    parser.add_argument("--config", help="Path to firm MCP JSON config (or LEXYSIGN_MCP_CONFIG)")
    parser.add_argument("--manifest-id", required=True)
    parser.add_argument("--operator", default="owner")
    parser.add_argument(
        "--i-approve-this-manifest",
        action="store_true",
        help="Required explicit operator confirmation. Not an MCP tool argument.",
    )
    args = parser.parse_args(argv)
    if not args.i_approve_this_manifest:
        print("refusing: pass --i-approve-this-manifest after reviewing the manifest", file=sys.stderr)
        return 2
    try:
        config = load_config(args.config)
        approval = issue_approval(config, args.manifest_id, args.operator)
    except FirmMcpError as exc:
        print(f"lexysign_mcp:{exc.code}: {exc.detail}", file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, "approval_id": approval["approval_id"], "expires_at": approval["expires_at"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
