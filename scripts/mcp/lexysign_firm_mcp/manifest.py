from __future__ import annotations

import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Any

from .config import FirmConfig
from .errors import FirmMcpError


def canonical(payload: dict[str, Any]) -> bytes:
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def manifest_hash(payload: dict[str, Any]) -> str:
    return hashlib.sha256(canonical(payload)).hexdigest()


def _dir(config: FirmConfig) -> Path:
    path = config.state_dir / "manifests"
    path.mkdir(parents=True, exist_ok=True)
    return path


def write_manifest(config: FirmConfig, body: dict[str, Any]) -> dict[str, Any]:
    now = int(time.time())
    payload = {
        **body,
        "manifest_id": str(uuid.uuid4()),
        "issued_at": now,
        "expires_at": now + config.manifest_ttl_seconds,
        "tenant_id": config.tenant_id,
        "principal_user_id": config.principal_user_id,
        "session_fingerprint": config.session_fingerprint,
    }
    payload["manifest_hash"] = manifest_hash(
        {key: value for key, value in payload.items() if key != "manifest_hash"}
    )
    path = _dir(config) / f"{payload['manifest_id']}.json"
    path.write_bytes(canonical(payload))
    path.chmod(0o600)
    return payload


def load_manifest(config: FirmConfig, manifest_id: str) -> dict[str, Any]:
    path = _dir(config) / f"{manifest_id}.json"
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise FirmMcpError("approval_missing", "manifest was not found") from exc
    stored = payload.get("manifest_hash")
    recomputed = manifest_hash({key: value for key, value in payload.items() if key != "manifest_hash"})
    if stored != recomputed:
        raise FirmMcpError("payload_modified", "manifest was altered")
    if int(payload.get("expires_at") or 0) < int(time.time()):
        raise FirmMcpError("approval_expired", "manifest has expired")
    if payload.get("tenant_id") != config.tenant_id:
        raise FirmMcpError("other_tenant", "manifest tenant does not match current config")
    if payload.get("session_fingerprint") != config.session_fingerprint:
        raise FirmMcpError("invalid_session", "manifest session no longer matches")
    return payload
