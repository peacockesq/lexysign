from __future__ import annotations

import re
from typing import Any

_SECRET_KEY = re.compile(
    r"(?i)(session|token|password|secret|authorization|master[_-]?key|cookie|signing[_-]?url|signPdf)"
)
_SECRET_VALUE = re.compile(
    r"(?i)(r:[A-Za-z0-9._-]{8,}|Bearer\s+\S+|X-Parse-Session-Token\s*[:=]\s*\S+)"
)
_SIGNING_PATH = re.compile(r"(?i)/login/[A-Za-z0-9+/=]+")


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
        return _SIGNING_PATH.sub("/login/[redacted]", text)
    return value


def public_text(payload: Any) -> str:
    import json

    return json.dumps(redact(payload), separators=(",", ":"), ensure_ascii=False)
