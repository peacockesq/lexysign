from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from pathlib import Path
from typing import Any

from .config import FirmConfig
from .errors import FirmMcpError
from .manifest import canonical, load_manifest


def _dir(config: FirmConfig) -> Path:
    path = config.state_dir / "approvals"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sign(secret: str, payload: dict[str, Any]) -> str:
    return hmac.new(secret.encode("utf-8"), canonical(payload), hashlib.sha256).hexdigest()


def issue_approval(config: FirmConfig, manifest_id: str, operator: str) -> dict[str, Any]:
    """Operator CLI only. Never imported by MCP tool handlers."""
    manifest = load_manifest(config, manifest_id)
    now = int(time.time())
    body = {
        "approval_id": str(uuid.uuid4()),
        "manifest_id": manifest["manifest_id"],
        "manifest_hash": manifest["manifest_hash"],
        "document_id": manifest["document_id"],
        "file_hash": manifest["file_hash"],
        "recipients": manifest["recipients"],
        "title": manifest["title"],
        "order": manifest["order"],
        "expiry": manifest["expiry"],
        "tenant_id": manifest["tenant_id"],
        "session_fingerprint": manifest["session_fingerprint"],
        "issued_at": now,
        "expires_at": now + config.approval_ttl_seconds,
        "operator": operator,
    }
    body["hmac"] = _sign(config.approval_secret, {key: value for key, value in body.items() if key != "hmac"})
    path = _dir(config) / f"{body['approval_id']}.json"
    path.write_bytes(canonical(body))
    path.chmod(0o600)
    return body


def verify_approval(config: FirmConfig, approval_id: str, manifest: dict[str, Any]) -> dict[str, Any]:
    path = _dir(config) / f"{approval_id}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FirmMcpError("approval_missing", "operator approval was not found") from exc
    given = payload.get("hmac")
    expected = _sign(config.approval_secret, {key: value for key, value in payload.items() if key != "hmac"})
    if not given or not hmac.compare_digest(str(given), expected):
        raise FirmMcpError("approval_mismatch", "approval signature is invalid")
    if int(payload.get("expires_at") or 0) < int(time.time()):
        raise FirmMcpError("approval_expired", "operator approval has expired")
    checks = (
        ("manifest_id", manifest["manifest_id"]),
        ("manifest_hash", manifest["manifest_hash"]),
        ("document_id", manifest["document_id"]),
        ("file_hash", manifest["file_hash"]),
        ("title", manifest["title"]),
        ("expiry", manifest["expiry"]),
        ("tenant_id", config.tenant_id),
        ("session_fingerprint", config.session_fingerprint),
    )
    for key, value in checks:
        if payload.get(key) != value:
            raise FirmMcpError("payload_modified", f"approval no longer matches {key}")
    if payload.get("recipients") != manifest.get("recipients"):
        raise FirmMcpError("payload_modified", "approval recipients no longer match")
    if payload.get("order") != manifest.get("order"):
        raise FirmMcpError("payload_modified", "approval signing order no longer matches")
    return payload
