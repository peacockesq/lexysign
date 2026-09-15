from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from .config import FirmConfig
from .errors import FirmMcpError
from .jsonutil import canonical_dumps


def _path(config: FirmConfig, document_id: str) -> Path:
    directory = config.state_dir / "ledger"
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{document_id}.json"


def _lock(path: Path):
    lock_path = path.with_suffix(".lock")
    fh = open(lock_path, "a+", encoding="utf-8")
    try:
        import fcntl

        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
    except Exception:
        pass
    return fh


def read_entry(config: FirmConfig, document_id: str, manifest_hash: str | None = None) -> dict[str, Any] | None:
    path = _path(config, document_id)
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


BLOCKING_STATES = {
    "accepted",
    "accepted_partial",
    "activated_manual",
    "in_flight",
    "uncertain",
    "partial_failure",
    "failed",
}


def begin(config: FirmConfig, document_id: str, manifest_hash: str) -> dict[str, Any]:
    path = _path(config, document_id)
    lock = _lock(path)
    try:
        existing = read_entry(config, document_id)
        if existing:
            state = existing.get("state")
            if state in {"failed_before_provider"}:
                pass
            elif state in BLOCKING_STATES:
                if state in {"in_flight", "uncertain", "partial_failure", "failed"}:
                    raise FirmMcpError("uncertain_send", "previous send is uncertain; refusing retry")
                raise FirmMcpError("duplicate_send", "document was already sent")
            else:
                raise FirmMcpError("duplicate_send", "send already recorded")
        entry = {"document_id": document_id, "manifest_hash": manifest_hash, "state": "in_flight"}
        path.write_bytes(canonical_dumps(entry).encode("utf-8"))
        os.chmod(path, 0o600)
        return entry
    finally:
        lock.close()


def finish(config: FirmConfig, document_id: str, manifest_hash: str, state: str, extra: dict[str, Any] | None = None) -> None:
    path = _path(config, document_id)
    lock = _lock(path)
    try:
        entry = {"document_id": document_id, "manifest_hash": manifest_hash, "state": state}
        if extra:
            entry.update(extra)
        path.write_bytes(canonical_dumps(entry).encode("utf-8"))
        os.chmod(path, 0o600)
    finally:
        lock.close()
