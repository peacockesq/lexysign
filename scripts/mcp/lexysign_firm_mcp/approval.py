from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

from .config import FirmConfig
from .errors import FirmMcpError
from .jsonutil import canonical_dumps
from .manifest import load_manifest


def _dir(config: FirmConfig) -> Path:
    path = config.state_dir / "approvals"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sign(secret: str, payload: dict[str, Any]) -> str:
    return hmac.new(secret.encode("utf-8"), canonical_dumps(payload).encode("utf-8"), hashlib.sha256).hexdigest()


def native_approval_secret() -> str:
    env = os.environ.get("LEXYSIGN_FIRM_APPROVAL_SECRET", "").strip()
    if env:
        return env
    path = os.environ.get("LEXYSIGN_FIRM_APPROVAL_SECRET_FILE", "").strip()
    if not path:
        raise FirmMcpError("approval_unconfigured", "native approval secret is not configured")
    try:
        value = Path(path).expanduser().read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise FirmMcpError("approval_unconfigured", "native approval secret file cannot be read") from exc
    if not value:
        raise FirmMcpError("approval_unconfigured", "native approval secret file is empty")
    return value


def native_approval_payload(manifest: dict[str, Any], approval: dict[str, Any]) -> dict[str, Any]:
    return {
        "approval_id": approval["approval_id"],
        "document_id": manifest["document_id"],
        "expires_at": int(approval["expires_at"]),
        "issued_at": int(approval["issued_at"]),
        "manifest_hash": manifest["manifest_hash"],
        "operator": str(approval.get("operator") or ""),
        "expected": manifest["expected"],
    }


def issue_approval(config: FirmConfig, manifest_id: str, operator: str) -> dict[str, Any]:
    """Operator CLI only. Never imported by MCP tool handlers."""
    manifest = load_manifest(config, manifest_id)
    native_secret = native_approval_secret()
    now = int(time.time())
    body = {
        "approval_id": str(uuid.uuid4()),
        "manifest_id": manifest["manifest_id"],
        "manifest_hash": manifest["manifest_hash"],
        "document_id": manifest["document_id"],
        "file_hash": manifest["file_hash"],
        "expected": manifest["expected"],
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
    native = {
        "approval_id": body["approval_id"],
        "document_id": body["document_id"],
        "expires_at": body["expires_at"],
        "issued_at": body["issued_at"],
        "manifest_hash": body["manifest_hash"],
        "operator": operator,
        "expected": manifest["expected"],
    }
    body["native_hmac"] = _sign(native_secret, native)
    path = _dir(config) / f"{body['approval_id']}.json"
    path.write_bytes(canonical_dumps(body).encode("utf-8"))
    path.chmod(0o600)
    return body


def verify_approval(config: FirmConfig, approval_id: str, manifest: dict[str, Any]) -> dict[str, Any]:
    path = _dir(config) / f"{approval_id}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FirmMcpError("approval_missing", "operator approval was not found") from exc
    given = payload.get("hmac")
    expected = _sign(config.approval_secret, {key: value for key, value in payload.items() if key not in {"hmac", "native_hmac"}})
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
        raise FirmMcpError("payload_modified", "approval signing order no longer match")
    if payload.get("expected") != manifest.get("expected"):
        raise FirmMcpError("payload_modified", "approval canonical expected no longer matches")
    native_secret = native_approval_secret()
    native = native_approval_payload(manifest, payload)
    native_given = str(payload.get("native_hmac") or "")
    native_expected = _sign(native_secret, native)
    if not native_given or not hmac.compare_digest(native_given, native_expected):
        raise FirmMcpError("approval_mismatch", "native approval signature is invalid")
    payload["native_token"] = {
        "approval_id": payload["approval_id"],
        "document_id": payload["document_id"],
        "expires_at": int(payload["expires_at"]),
        "issued_at": int(payload["issued_at"]),
        "manifest_hash": payload["manifest_hash"],
        "operator": str(payload.get("operator") or ""),
        "expected": manifest["expected"],
        "hmac": native_given,
    }
    return payload
