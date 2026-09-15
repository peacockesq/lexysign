from __future__ import annotations

import json
import math
from typing import Any

from .errors import FirmMcpError


def _reject_constant(value: str) -> None:
    raise FirmMcpError("bad_bounds", "non-finite JSON number is not allowed")


def _finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise FirmMcpError("bad_bounds", "non-finite JSON number is not allowed")
    return number


def strict_json_loads(text: str) -> Any:
    try:
        payload = json.loads(text, parse_constant=_reject_constant, parse_float=_finite_float)
    except FirmMcpError:
        raise
    except json.JSONDecodeError as exc:
        raise FirmMcpError("bad_bounds", "JSON is not valid") from exc
    _reject_nonfinite(payload)
    return payload


def _reject_nonfinite(value: Any) -> None:
    if isinstance(value, float) and not math.isfinite(value):
        raise FirmMcpError("bad_bounds", "non-finite JSON number is not allowed")
    if isinstance(value, dict):
        for item in value.values():
            _reject_nonfinite(item)
    elif isinstance(value, list):
        for item in value:
            _reject_nonfinite(item)


def canonical_dumps(value: Any) -> str:
    try:
        return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False)
    except ValueError as exc:
        raise FirmMcpError("bad_bounds", "canonical JSON rejected a non-finite value") from exc
