from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_server_cannot_mint_approvals():
    source = (ROOT / "lexysign_firm_mcp" / "server.py").read_text(encoding="utf-8")
    assert "issue_approval" not in source
    assert "approve_cli" not in source
