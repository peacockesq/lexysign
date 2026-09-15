from __future__ import annotations

import json

import pytest

from lexysign_firm_mcp.config import load_config
from lexysign_firm_mcp.errors import FirmMcpError
from lexysign_firm_mcp.parse_client import ParseClient
from lexysign_firm_mcp import service

from tests.fake_parse import FOREIGN, PRINCIPAL


def _signers():
    return [
        {
            "name": "Client One",
            "email": "client@example.com",
            "role": "client",
            "fields": [{"type": "signature", "page": 1, "x": 72, "y": 100, "width": 180, "height": 38}],
        }
    ]


def test_health_and_foreign_session(harness, tmp_path):
    healthy = service.firm_health(harness["client"], harness["config"])
    assert healthy["ok"] is True
    assert healthy["tenant_id"] == PRINCIPAL["tenant"]
    token = tmp_path / "foreign"
    token.write_text(FOREIGN["token"], encoding="utf-8")
    cfg = json.loads(harness["config_path"].read_text())
    cfg["session_token_file"] = str(token)
    foreign_path = tmp_path / "foreign.json"
    foreign_path.write_text(json.dumps(cfg), encoding="utf-8")
    foreign_config = load_config(foreign_path)
    client = ParseClient(foreign_config)
    try:
        with pytest.raises(FirmMcpError) as raised:
            service.firm_health(client, foreign_config)
        assert raised.value.code == "foreign_principal"
    finally:
        client.close()
    missing = tmp_path / "missing"
    missing.write_text("r:nope", encoding="utf-8")
    cfg["session_token_file"] = str(missing)
    bad_path = tmp_path / "bad.json"
    bad_path.write_text(json.dumps(cfg), encoding="utf-8")
    bad_config = load_config(bad_path)
    bad_client = ParseClient(bad_config)
    try:
        with pytest.raises(FirmMcpError) as raised:
            service.firm_health(bad_client, bad_config)
        assert raised.value.code == "invalid_session"
    finally:
        bad_client.close()


def test_list_excludes_foreign_and_signer_only(harness):
    listed = service.list_documents(harness["client"], harness["config"], skip=0, limit=50)
    ids = {item["object_id"] for item in listed["documents"]}
    assert "doc-owned-draft" in ids
    assert "doc-foreign" not in ids
    assert "doc-signer-only" not in ids
    with pytest.raises(FirmMcpError) as raised:
        service.document_status(harness["client"], harness["config"], "doc-foreign")
    assert raised.value.code == "foreign_document"
    with pytest.raises(FirmMcpError) as raised:
        service.document_status(harness["client"], harness["config"], "doc-signer-only")
    assert raised.value.code == "foreign_document"


def test_create_draft_and_tag_parse_rejected(harness, tmp_path):
    created = service.create_draft(
        harness["client"],
        harness["config"],
        pdf_path=str(harness["pdf"]),
        title="Retainer",
        signers=_signers(),
    )
    assert created["ok"] is True
    assert created["source_pdf_unchanged"] is True
    assert created["page_count"] == 2
    assert harness["pdf"].read_bytes().startswith(b"%PDF-")
    with pytest.raises(FirmMcpError) as raised:
        service.create_draft(
            harness["client"],
            harness["config"],
            pdf_path=str(harness["pdf"]),
            title="Tagged",
            signers=_signers(),
            parse_tags=True,
        )
    assert raised.value.code == "tag_parse_unsupported"
    outside = tmp_path / "escape.pdf"
    outside.write_bytes(harness["pdf"].read_bytes())
    with pytest.raises(FirmMcpError) as raised:
        service.create_draft(
            harness["client"],
            harness["config"],
            pdf_path=str(outside),
            title="Nope",
            signers=_signers(),
        )
    assert raised.value.code == "bad_path"
    with pytest.raises(FirmMcpError) as raised:
        service.create_draft(
            harness["client"],
            harness["config"],
            pdf_path=str(harness["pdf"]),
            title="Bad field",
            signers=[
                {
                    "name": "Client One",
                    "email": "client@example.com",
                    "role": "client",
                    "fields": [{"type": "signature", "page": 1, "x": 700, "y": 10, "width": 20, "height": 20}],
                }
            ],
        )
    assert raised.value.code == "bad_bounds"
