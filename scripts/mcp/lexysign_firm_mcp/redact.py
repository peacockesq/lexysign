from __future__ import annotations

import re
from typing import Any

_SECRET_KEY = re.compile(
    r"(?i)(session|token|password|secret|authorization|master[_-]?key|cookie|signing[_-]?url|signPdf|hmac)"
)
_SECRET_VALUE = re.compile(
    r"(?i)(r:[A-Za-z0-9._-]{8,}|Bearer\s+\S+|X-Parse-Session-Token\s*[:=]\s*\S+|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+)"
)
_SIGNING_PATH = re.compile(r"(?i)/login/[A-Za-z0-9+/=]+")
_QUERY_TOKEN = re.compile(r"(?i)([?&](?:token|sessionToken|apiKey|key)=)[^&\s]+")
_CAPABILITY_URL = re.compile(r"(?i)https?://[^\s\"']+\?(?:[^\s\"']*token=)[^\s\"']+")


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if _SECRET_KEY.search(str(key)):
                out[key] = "[redacted]"
            else:
                out[key] = redact(item)
        return out
    if isinstance(value, list):
        return [redact(item) for item in value]
    if isinstance(value, str):
        text = _SECRET_VALUE.sub("[redacted]", value)
        text = _QUERY_TOKEN.sub(r"\1[redacted]", text)
        text = _CAPABILITY_URL.sub("[redacted-url]", text)
        return _SIGNING_PATH.sub("/login/[redacted]", text)
    return value


def public_text(payload: Any) -> str:
    import json

    return json.dumps(redact(payload), separators=(",", ":"), ensure_ascii=False)


def public_error(code: str) -> str:
    return {
        "invalid_session": "Parse session was refused",
        "foreign_document": "document is not available to this principal",
        "other_tenant": "document belongs to another tenant",
        "payload_modified": "approved payload no longer matches",
        "document_terminal": "document is no longer sendable",
        "document_expired": "document is expired",
        "duplicate_send": "document was already sent",
        "uncertain_send": "previous send is uncertain; refusing retry",
        "approval_missing": "operator approval is required",
        "approval_expired": "operator approval has expired",
        "approval_mismatch": "operator approval is invalid",
        "approval_unconfigured": "native approval is not configured",
        "reservation_unprovisioned": "native send reservation is not provisioned",
        "foreign_contact": "signer contact is not usable",
        "invalid_origin": "file origin is not trusted",
        "not_completed": "signed file is not available",
        "not_pdf": "downloaded bytes are not a valid PDF",
        "too_large": "payload exceeds the configured size limit",
        "smtp_error": "invitation mail was not accepted",
        "insufficient_quota": "paid entitlement was refused",
        "missing_signers": "document has no signers",
        "bad_bounds": "field or JSON bounds are invalid",
        "bad_path": "path is not allowed",
        "forbidden": "operation was refused",
        "invalid_config": "request was refused",
    }.get(code, "request was refused")
