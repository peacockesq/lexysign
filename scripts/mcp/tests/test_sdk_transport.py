from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from lexysign_firm_mcp import TOOL_NAMES

ROOT = Path(__file__).resolve().parents[1]


def test_sdk_initialize_list_and_tools(harness):
    env = os.environ.copy()
    env["LEXYSIGN_MCP_CONFIG"] = str(harness["config_path"])
    env["PYTHONPATH"] = str(ROOT) + os.pathsep + env.get("PYTHONPATH", "")
    python = sys.executable
    params = StdioServerParameters(
        command=python,
        args=["-u", "-m", "lexysign_firm_mcp"],
        env=env,
        cwd=str(ROOT),
    )

    async def exercise():
        async with asyncio.timeout(20):
            async with stdio_client(params) as (read, write):
                async with ClientSession(read, write) as session:
                    initialized = await session.initialize()
                    info = initialized.model_dump(by_alias=True)
                    assert info["serverInfo"]["name"] == "lexysign-firm"
                    tools = await session.list_tools()
                    names = [item.name for item in tools.tools]
                    assert set(names) == set(TOOL_NAMES)
                    assert "approve" not in names
                    assert "sign_for_client" not in names
                    health = await session.call_tool("firm_health", {})
                    payload = json.loads(health.content[0].text)
                    assert payload["ok"] is True
                    listed = await session.call_tool("list_documents", {"skip": 0, "limit": 20})
                    listed_payload = json.loads(listed.content[0].text)
                    ids = {item["object_id"] for item in listed_payload["documents"]}
                    assert "doc-foreign" not in ids
                    foreign = await session.call_tool("document_status", {"document_id": "doc-foreign"})
                    foreign_payload = json.loads(foreign.content[0].text)
                    assert foreign_payload["ok"] is False
                    assert foreign_payload["error"] == "foreign_document"
                    created = await session.call_tool(
                        "create_draft",
                        {
                            "pdf_path": str(harness["pdf"]),
                            "title": "SDK Draft",
                            "signers_json": json.dumps(
                                [
                                    {
                                        "name": "Client One",
                                        "email": "client@example.com",
                                        "role": "client",
                                        "fields": [
                                            {
                                                "type": "signature",
                                                "page": 1,
                                                "x": 72,
                                                "y": 120,
                                                "width": 180,
                                                "height": 38,
                                            }
                                        ],
                                    }
                                ]
                            ),
                        },
                    )
                    created_payload = json.loads(created.content[0].text)
                    assert created_payload["ok"] is True
                    prepared = await session.call_tool(
                        "prepare_send", {"document_id": created_payload["document_id"]}
                    )
                    prepared_payload = json.loads(prepared.content[0].text)
                    assert prepared_payload["ok"] is True
                    denied = await session.call_tool(
                        "send_invitations",
                        {"manifest_id": prepared_payload["manifest_id"], "approval_id": "not-issued"},
                    )
                    denied_payload = json.loads(denied.content[0].text)
                    assert denied_payload["error"] == "approval_missing"
                    return {
                        "server": info["serverInfo"]["name"],
                        "tools": names,
                        "health": payload["ok"],
                        "created": created_payload["document_id"],
                    }

    result = asyncio.run(exercise())
    evidence = Path("/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/mcp-v1-evidence")
    evidence.mkdir(parents=True, exist_ok=True)
    (evidence / "sdk-transport.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    assert result["server"] == "lexysign-firm"
    assert len(result["tools"]) == 7
