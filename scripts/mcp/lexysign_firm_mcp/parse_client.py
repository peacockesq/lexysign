from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

import httpx

from .config import FirmConfig
from .errors import FirmMcpError
from .pdfutil import parse_pages
from .placeholders import pointer
from .redact import public_error

KNOWN_NATIVE_CODES = {
    "foreign_document",
    "other_tenant",
    "payload_modified",
    "document_terminal",
    "document_expired",
    "duplicate_send",
    "approval_missing",
    "approval_unconfigured",
    "approval_expired",
    "approval_mismatch",
    "reservation_unprovisioned",
    "foreign_contact",
    "invalid_origin",
    "missing_signers",
    "insufficient_quota",
    "not_completed",
    "missing_url",
    "invalid_session",
    "uncertain",
}


def _pointer_id(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return str(value.get("objectId") or value.get("id") or "")
    return str(getattr(value, "id", "") or "")


class ParseClient:
    def __init__(self, config: FirmConfig, transport: httpx.BaseTransport | None = None) -> None:
        self.config = config
        self._transport = transport
        self._client = httpx.Client(
            base_url=config.parse_base_url,
            timeout=config.http_timeout_seconds,
            transport=transport,
            follow_redirects=False,
            trust_env=False,
            headers={
                "X-Parse-Application-Id": config.parse_app_id,
                "X-Parse-Session-Token": config.session_token,
            },
        )

    def close(self) -> None:
        self._client.close()

    def _parse_host_ok(self, parsed) -> bool:
        allowed = urlparse(self.config.parse_base_url)
        return parsed.scheme == allowed.scheme and parsed.netloc == allowed.netloc

    def _storage_ok(self, parsed) -> bool:
        if parsed.scheme != "https" or parsed.username or parsed.password:
            return False
        origin = f"https://{parsed.netloc}"
        return origin in self.config.object_storage_origins

    def _validate_capability_url(self, url: str) -> None:
        parsed = urlparse(str(url))
        if parsed.username or parsed.password or parsed.fragment:
            raise FirmMcpError("invalid_origin", public_error("invalid_origin"))
        if self._parse_host_ok(parsed):
            if "/files/" not in parsed.path:
                raise FirmMcpError("invalid_origin", public_error("invalid_origin"))
            return
        if self._storage_ok(parsed):
            return
        raise FirmMcpError("invalid_origin", public_error("invalid_origin"))

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if path.startswith("http://") or path.startswith("https://"):
            parsed = urlparse(path)
            if not self._parse_host_ok(parsed):
                raise FirmMcpError("invalid_origin", public_error("invalid_origin"))
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise FirmMcpError("send_timeout", "Parse request timed out") from exc
        except httpx.HTTPError as exc:
            raise FirmMcpError("send_timeout", "Parse transport failed") from exc
        return response

    def _raise_parse(self, response: httpx.Response) -> None:
        if response.status_code == 209 or (
            response.status_code in {400, 401} and "session" in response.text.lower()
        ):
            raise FirmMcpError("invalid_session", public_error("invalid_session"))
        payload: dict[str, Any]
        try:
            payload = response.json()
        except Exception:
            payload = {}
        code = payload.get("code")
        message = str(payload.get("error") or payload.get("message") or "")
        prefix = message.split(":", 1)[0].strip()
        if code == 209:
            raise FirmMcpError("invalid_session", public_error("invalid_session"))
        if prefix in KNOWN_NATIVE_CODES:
            mapped = "uncertain_send" if prefix == "uncertain" else prefix
            if mapped == "insufficient_quota" or "limit reached" in message.lower() or "subscription" in message.lower():
                raise FirmMcpError("insufficient_quota" if "subscription" in message.lower() or "limit" in message.lower() else mapped, public_error(mapped))
            raise FirmMcpError(mapped, public_error(mapped))
        if code == 137:
            raise FirmMcpError("duplicate_send", public_error("duplicate_send"))
        if code == 119:
            if "subscription" in message.lower() or "limit" in message.lower():
                raise FirmMcpError("insufficient_quota", public_error("insufficient_quota"))
            raise FirmMcpError("forbidden", public_error("forbidden"))
        raise FirmMcpError("invalid_config", public_error("invalid_config"))

    def _json(self, response: httpx.Response) -> Any:
        if response.status_code == 209 or (
            response.status_code in {400, 401} and "session" in response.text.lower()
        ):
            raise FirmMcpError("invalid_session", public_error("invalid_session"))
        if response.status_code >= 400:
            self._raise_parse(response)
        if not response.content:
            return {}
        return response.json()

    def users_me(self) -> dict:
        return self._json(self.request("GET", "/users/me"))

    def query_class(self, class_name: str, where: dict, **params: Any) -> list[dict]:
        allowed = {
            "contracts_Users",
            "contracts_Document",
            "contracts_Contactbook",
        }
        if class_name not in allowed:
            raise FirmMcpError("invalid_config", public_error("invalid_config"))
        query = {"where": json.dumps(where, separators=(",", ":"))}
        for key, value in params.items():
            if value is not None:
                query[key] = str(value)
        payload = self._json(self.request("GET", f"/classes/{class_name}", params=query))
        return list(payload.get("results") or [])

    def get_object(self, class_name: str, object_id: str, include: str | None = None) -> dict | None:
        params = {}
        if include:
            params["include"] = include
        response = self.request("GET", f"/classes/{class_name}/{object_id}", params=params)
        if response.status_code == 404:
            return None
        return self._json(response)

    def upload_pdf(self, filename: str, data: bytes) -> str:
        response = self.request(
            "POST",
            f"/files/{filename}",
            content=data,
            headers={"Content-Type": "application/pdf"},
        )
        payload = self._json(response)
        url = payload.get("url")
        if not isinstance(url, str) or not url:
            raise FirmMcpError("invalid_config", public_error("invalid_config"))
        return url

    def _binary_get(self, url: str) -> bytes:
        self._validate_capability_url(url)
        try:
            with httpx.Client(
                timeout=self.config.http_timeout_seconds,
                transport=self._transport,
                follow_redirects=False,
                trust_env=False,
                headers={},
            ) as client:
                response = client.get(url)
        except httpx.TimeoutException as exc:
            raise FirmMcpError("not_completed", public_error("not_completed")) from exc
        except httpx.HTTPError as exc:
            raise FirmMcpError("not_completed", public_error("not_completed")) from exc
        if response.status_code != 200:
            raise FirmMcpError("not_completed", public_error("not_completed"))
        blocked = {"location", "x-accel-redirect", "x-sendfile"}
        if any(name.lower() in blocked for name in response.headers.keys()):
            raise FirmMcpError("invalid_origin", public_error("invalid_origin"))
        data = response.content or b""
        if len(data) > self.config.max_pdf_bytes:
            raise FirmMcpError("too_large", public_error("too_large"))
        if not data.startswith(b"%PDF-"):
            raise FirmMcpError("not_pdf", public_error("not_pdf"))
        parse_pages(data, max_pages=self.config.page_limit)
        return data

    def acquire_document_bytes(self, document_id: str, kind: str) -> bytes:
        if kind not in {"source", "signed", "certificate"}:
            raise FirmMcpError("invalid_config", public_error("invalid_config"))
        result = self.cloud("lexysignFirmAcquireFile", {"documentId": document_id, "kind": kind})
        if not isinstance(result, dict):
            raise FirmMcpError("not_completed", public_error("not_completed"))
        url = result.get("url")
        if not isinstance(url, str) or not url:
            raise FirmMcpError("not_completed", public_error("not_completed"))
        return self._binary_get(url)

    def download_bytes(self, url: str) -> bytes:
        raise FirmMcpError("invalid_origin", public_error("invalid_origin"))

    def cloud(self, name: str, params: dict) -> Any:
        allowed = {
            "createdocumentfromapp",
            "savecontact",
            "lexysignFirmSendInvitations",
            "lexysignFirmAcquireFile",
            "generatecertificate",
        }
        if name not in allowed:
            raise FirmMcpError("invalid_config", public_error("invalid_config"))
        payload = self._json(self.request("POST", f"/functions/{name}", json=params))
        if isinstance(payload, dict) and "result" in payload:
            return payload["result"]
        return payload

    def owner_document_where(self) -> dict:
        return {
            "CreatedBy": pointer("_User", self.config.principal_user_id),
            "ExtUserPtr": pointer("contracts_Users", self.config.principal_extuser_id),
            "IsArchive": {"$ne": True},
            "Type": {"$ne": "Folder"},
        }

    def tenant_id_of(self, document: dict) -> str:
        ext = document.get("ExtUserPtr") or {}
        return _pointer_id(ext.get("TenantId") if isinstance(ext, dict) else None)
