from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse

from .errors import FirmMcpError

MAX_PDF_BYTES_DEFAULT = 25 * 1024 * 1024
MAX_PAGE_LIMIT = 50
ALLOWED_SCHEMES = {"http", "https"}


def _read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as exc:
        raise FirmMcpError("invalid_config", "config file not found") from exc
    except json.JSONDecodeError as exc:
        raise FirmMcpError("invalid_config", "config is not JSON") from exc
    if not isinstance(data, dict):
        raise FirmMcpError("invalid_config", "config must be an object")
    return data


def _require_str(data: dict, key: str) -> str:
    value = data.get(key)
    if not isinstance(value, str) or not value.strip():
        raise FirmMcpError("invalid_config", f"{key} is required")
    return value.strip()


def _read_secret_file(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise FirmMcpError("invalid_config", f"cannot read {path.name}") from exc
    if not value:
        raise FirmMcpError("invalid_config", f"{path.name} is empty")
    return value


def _validate_base_url(url: str) -> str:
    parsed = urlparse(url)
    if parsed.scheme not in ALLOWED_SCHEMES or not parsed.netloc:
        raise FirmMcpError("invalid_config", "parse_base_url must be an http(s) origin+path")
    if parsed.username or parsed.password:
        raise FirmMcpError("invalid_config", "parse_base_url must not contain credentials")
    if parsed.query or parsed.fragment:
        raise FirmMcpError("invalid_config", "parse_base_url must not contain query or fragment")
    return url.rstrip("/")


@dataclass(frozen=True)
class FirmConfig:
    parse_base_url: str
    parse_app_id: str
    tenant_id: str
    principal_user_id: str
    principal_extuser_id: str
    session_token: str
    approval_secret: str
    allowed_pdf_roots: tuple[Path, ...]
    download_root: Path
    state_dir: Path
    public_origin: str
    max_pdf_bytes: int
    manifest_ttl_seconds: int
    approval_ttl_seconds: int
    http_timeout_seconds: float
    page_limit: int

    @property
    def session_fingerprint(self) -> str:
        import hashlib

        return hashlib.sha256(self.session_token.encode("utf-8")).hexdigest()[:16]


def load_config(path: str | os.PathLike[str] | None = None) -> FirmConfig:
    config_path = Path(path or os.environ.get("LEXYSIGN_MCP_CONFIG", "")).expanduser()
    if not str(config_path):
        raise FirmMcpError("invalid_config", "LEXYSIGN_MCP_CONFIG is required")
    data = _read_json(config_path)
    base = _validate_base_url(_require_str(data, "parse_base_url"))
    public_origin = _validate_base_url(_require_str(data, "public_origin"))
    token_file = Path(_require_str(data, "session_token_file")).expanduser()
    secret_file = Path(_require_str(data, "approval_secret_file")).expanduser()
    roots_raw = data.get("allowed_pdf_roots")
    if not isinstance(roots_raw, list) or not roots_raw:
        raise FirmMcpError("invalid_config", "allowed_pdf_roots must be a non-empty list")
    roots = tuple(Path(str(item)).expanduser() for item in roots_raw)
    download_root = Path(_require_str(data, "download_root")).expanduser()
    state_dir = Path(_require_str(data, "state_dir")).expanduser()
    max_pdf_bytes = int(data.get("max_pdf_bytes") or MAX_PDF_BYTES_DEFAULT)
    page_limit = int(data.get("page_limit") or MAX_PAGE_LIMIT)
    if page_limit < 1 or page_limit > MAX_PAGE_LIMIT:
        page_limit = MAX_PAGE_LIMIT
    return FirmConfig(
        parse_base_url=base,
        parse_app_id=_require_str(data, "parse_app_id"),
        tenant_id=_require_str(data, "tenant_id"),
        principal_user_id=_require_str(data, "principal_user_id"),
        principal_extuser_id=_require_str(data, "principal_extuser_id"),
        session_token=_read_secret_file(token_file),
        approval_secret=_read_secret_file(secret_file),
        allowed_pdf_roots=roots,
        download_root=download_root,
        state_dir=state_dir,
        public_origin=public_origin,
        max_pdf_bytes=max_pdf_bytes,
        manifest_ttl_seconds=int(data.get("manifest_ttl_seconds") or 3600),
        approval_ttl_seconds=int(data.get("approval_ttl_seconds") or 1800),
        http_timeout_seconds=float(data.get("http_timeout_seconds") or 30),
        page_limit=page_limit,
    )
