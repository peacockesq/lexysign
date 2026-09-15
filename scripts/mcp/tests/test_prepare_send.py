from __future__ import annotations

import json
from pathlib import Path

import pytest

from lexysign_firm_mcp.approval import issue_approval
from lexysign_firm_mcp.approve_cli import main as approve_main
from lexysign_firm_mcp.errors import FirmMcpError
from lexysign_firm_mcp import service


def test_prepare_requires_operator_cli_not_mcp_flag(harness):
    prepared = service.prepare_send(harness["client"], harness["config"], document_id="doc-owned-draft")
    assert prepared["ok"] is True
    assert prepared["approval_tool_available"] is False
    assert prepared["preview"]["file_hash"]
    assert prepared["preview"]["recipients"][0]["email"] == "client@example.com"
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id="",
        )
    assert raised.value.code == "approval_missing"
    assert approve_main(["--manifest-id", prepared["manifest_id"], "--config", str(harness["config_path"])]) == 2
    assert (
        approve_main(
            [
                "--manifest-id",
                prepared["manifest_id"],
                "--config",
                str(harness["config_path"]),
                "--i-approve-this-manifest",
            ]
        )
        == 0
    )


def test_modified_payload_and_expired_document_reject(harness):
    prepared = service.prepare_send(harness["client"], harness["config"], document_id="doc-owned-draft")
    approval = issue_approval(harness["config"], prepared["manifest_id"], "owner")
    harness["store"].documents["doc-owned-draft"]["Name"] = "Changed Title"
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id=approval["approval_id"],
        )
    assert raised.value.code == "payload_modified"
    with pytest.raises(FirmMcpError) as raised:
        service.prepare_send(harness["client"], harness["config"], document_id="doc-expired")
    assert raised.value.code == "document_expired"
    with pytest.raises(FirmMcpError) as raised:
        service.prepare_send(harness["client"], harness["config"], document_id="doc-completed")
    assert raised.value.code == "document_terminal"


def test_expired_approval_rejects(harness):
    prepared = service.prepare_send(harness["client"], harness["config"], document_id="doc-owned-draft")
    approval = issue_approval(harness["config"], prepared["manifest_id"], "owner")
    path = Path(harness["config"].state_dir) / "approvals" / f"{approval['approval_id']}.json"
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["expires_at"] = 1
    # Re-sign would be needed; stripping hmac simulates a broken/expired operator file after expiry check.
    payload["expires_at"] = 1
    from lexysign_firm_mcp.approval import _sign
    from lexysign_firm_mcp.manifest import canonical

    unsigned = {key: value for key, value in payload.items() if key not in {"hmac", "native_hmac"}}
    payload["hmac"] = _sign(harness["config"].approval_secret, unsigned)
    path.write_text(json.dumps(payload, sort_keys=True, separators=(",", ":")), encoding="utf-8")
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id=approval["approval_id"],
        )
    assert raised.value.code == "approval_expired"


def test_duplicate_and_uncertain_send_reject(harness):
    prepared = service.prepare_send(harness["client"], harness["config"], document_id="doc-owned-draft")
    approval = issue_approval(harness["config"], prepared["manifest_id"], "owner")
    sent = service.send_invitations(
        harness["client"],
        harness["config"],
        manifest_id=prepared["manifest_id"],
        approval_id=approval["approval_id"],
    )
    assert sent["ok"] is True
    assert sent["smtp_accepted"] is True
    assert sent["delivered"] is False
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id=approval["approval_id"],
        )
    assert raised.value.code == "duplicate_send"

    hang = service.prepare_send(harness["client"], harness["config"], document_id="doc-hang")
    hang_approval = issue_approval(harness["config"], hang["manifest_id"], "owner")
    harness["store"].send_mode_force = "uncertain"
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=hang["manifest_id"],
            approval_id=hang_approval["approval_id"],
        )
    assert raised.value.code == "uncertain_send"
    harness["store"].send_mode_force = None
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=hang["manifest_id"],
            approval_id=hang_approval["approval_id"],
        )
    assert raised.value.code == "uncertain_send"


def test_timeout_marks_uncertain(harness):
    prepared = service.prepare_send(harness["client"], harness["config"], document_id="doc-hang")
    approval = issue_approval(harness["config"], prepared["manifest_id"], "owner")
    harness["store"].hang = True
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id=approval["approval_id"],
        )
    assert raised.value.code in {"uncertain_send", "send_timeout"}
    with pytest.raises(FirmMcpError) as raised:
        service.send_invitations(
            harness["client"],
            harness["config"],
            manifest_id=prepared["manifest_id"],
            approval_id=approval["approval_id"],
        )
    assert raised.value.code == "uncertain_send"


def test_manual_mode_and_download(harness):
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
    downloaded = service.download_signed(harness["client"], harness["config"], "doc-completed")
    assert downloaded["signed_pdf_sha256"]
    assert Path(downloaded["signed_pdf_path"]).is_file()
    assert downloaded["signed_pdf_path"].startswith(str(harness["config"].download_root))
    with pytest.raises(FirmMcpError) as raised:
        service.download_signed(harness["client"], harness["config"], "doc-owned-sent")
    assert raised.value.code == "not_completed"
