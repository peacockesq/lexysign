from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from lexysign_firm_mcp import ledger, service
from lexysign_firm_mcp.approval import issue_approval
from lexysign_firm_mcp.errors import FirmMcpError
from lexysign_firm_mcp.jsonutil import strict_json_loads
from lexysign_firm_mcp.parse_client import ParseClient
from lexysign_firm_mcp.pdfutil import validate_rect
from lexysign_firm_mcp.redact import public_text


def _approve(harness):
    prepared = service.prepare_send(harness["client"], harness["config"], document_id="doc-owned-draft")
    approval = issue_approval(harness["config"], prepared["manifest_id"], "owner")
    return prepared, approval


def test_b1_pdf_read_denial_fails_closed(harness, monkeypatch):
    def denied(document_id, kind):
        raise FirmMcpError("not_completed", "native raw-file middleware denied")

    monkeypatch.setattr(harness["client"], "acquire_document_bytes", denied)
    with pytest.raises(FirmMcpError) as raised:
        service.prepare_send(harness["client"], harness["config"], document_id="doc-owned-draft")
    assert raised.value.code == "not_completed"


def test_b1_arbitrary_download_bytes_rejected(harness):
    with pytest.raises(FirmMcpError) as raised:
        harness["client"].download_bytes(harness["store"].documents["doc-owned-draft"]["URL"])
    assert raised.value.code == "invalid_origin"


@pytest.mark.parametrize("change", ["order", "expiry", "days", "fields", "contact_id"])
def test_b2_post_approval_mutations_rejected(harness, change):
    prepared, approval = _approve(harness)
    document = harness["store"].documents["doc-owned-draft"]
    if change == "order":
        document["SendinOrder"] = not document.get("SendinOrder", False)
    if change == "expiry":
        document["ExpiryDate"] = {"__type": "Date", "iso": "2099-01-01T00:00:00.000Z"}
    if change == "days":
        document["TimeToCompleteDays"] = 90
    if change == "fields":
        document["Placeholders"] = []
    if change == "contact_id":
        document["Signers"][0]["objectId"] = "foreign-contact-substitution"
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id=approval["approval_id"],
        )
    assert raised.value.code in {"payload_modified", "foreign_contact"}


def test_b2_slow_deadline_rejected(harness, monkeypatch):
    cfg = replace(harness["config"], manifest_ttl_seconds=1, approval_ttl_seconds=1)
    harness["config"] = cfg
    prepared, approval = _approve(harness)
    original = harness["client"].acquire_document_bytes

    def slow(document_id, kind):
        import time

        time.sleep(max(0, prepared["expires_at"] + 1 - time.time()))
        return original(document_id, kind)

    monkeypatch.setattr(harness["client"], "acquire_document_bytes", slow)
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id=approval["approval_id"],
        )
    assert raised.value.code == "approval_expired"


def test_b3_new_manifest_cannot_bypass_uncertainty(harness):
    ledger.begin(harness["config"], "synthetic", "a" * 64)
    ledger.finish(harness["config"], "synthetic", "a" * 64, "uncertain")
    with pytest.raises(FirmMcpError) as raised:
        ledger.begin(harness["config"], "synthetic", "b" * 64)
    assert raised.value.code == "uncertain_send"


def test_b4_http_downgrade_and_redirect_rejected(harness):
    def transport(request):
        return httpx.Response(302, headers={"Location": "https://foreign.invalid/steal"}, content=b"not a PDF")

    cfg = replace(harness["config"], parse_base_url="https://files.example.invalid/parse")
    client = ParseClient(cfg, httpx.MockTransport(transport))
    try:
        with pytest.raises(FirmMcpError):
            client._binary_get("http://files.example.invalid/files/any-path?token=x")
        with pytest.raises(FirmMcpError):
            client._binary_get("https://files.example.invalid/files/any-path?token=x")
    finally:
        client.close()


def test_b4_certificate_symlink_refused(harness):
    victim = harness["tmp"] / "outside-download-root.pdf"
    victim.write_bytes(b"untouched")
    link = harness["config"].download_root / "doc-completed-certificate.pdf"
    link.symlink_to(victim)
    with pytest.raises(FirmMcpError) as raised:
        service.download_signed(harness["client"], harness["config"], "doc-completed")
    assert raised.value.code == "bad_path"
    assert victim.read_bytes() == b"untouched"


def test_b4_capability_token_redacted():
    capability = "https://files.example.invalid/parse/files/app/synthetic.pdf?token=FICTIONAL_JWT_SENTINEL"
    result = public_text({"ok": False, "error": "invalid_config", "message": "Upstream rejected " + capability})
    assert "FICTIONAL_JWT_SENTINEL" not in result


def test_b5_foreign_tenant_contact_rejected(harness):
    contact = harness["store"].contacts[0]
    contact["TenantId"] = {"__type": "Pointer", "className": "partners_Tenant", "objectId": "other-tenant"}
    result = service.create_draft(
        harness["client"],
        harness["config"],
        pdf_path=str(harness["pdf"]),
        title="Synthetic",
        signers=[{"email": contact["Email"], "fields": [{"type": "signature", "page": 1, "x": 1, "y": 1, "width": 20, "height": 20}]}],
    )
    created = harness["store"].documents[result["document_id"]]
    assert created["Signers"][0]["objectId"] != contact["objectId"]


def test_b8_nan_rectangle_rejected():
    with pytest.raises(FirmMcpError) as raised:
        validate_rect({"page": 1, "width": 612, "height": 792}, {"page": 1, "x": float("nan"), "y": 1, "width": 2, "height": 2})
    assert raised.value.code == "bad_bounds"


def test_b8_strict_json_rejects_nan():
    with pytest.raises(FirmMcpError):
        strict_json_loads("[NaN]")


def test_b8_manual_links_stored_privately(harness):
    prepared = service.prepare_send(
        harness["client"], harness["config"], document_id="doc-owned-draft", send_mode="manual"
    )
    approval = issue_approval(harness["config"], prepared["manifest_id"], "owner")
    sent = service.send_invitations(
        harness["client"],
        harness["config"],
        manifest_id=prepared["manifest_id"],
        approval_id=approval["approval_id"],
    )
    assert sent["manual_links"] == "stored_privately"
    assert "login/" not in json.dumps(sent)
    state = "\n".join(path.read_text(encoding="utf-8") for path in Path(harness["config"].state_dir).rglob("*.json"))
    assert "/login/" in state
