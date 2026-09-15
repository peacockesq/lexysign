from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

import httpx

from .config import FirmConfig
from .errors import FirmMcpError
from .placeholders import pointer


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
        self._client = httpx.Client(
            base_url=config.parse_base_url,
            timeout=config.http_timeout_seconds,
            transport=transport,
            follow_redirects=False,
            headers={
                "X-Parse-Application-Id": config.parse_app_id,
                "X-Parse-Session-Token": config.session_token,
            },
        )

    def close(self) -> None:
        self._client.close()

    def _url_ok(self, url: str) -> None:
        parsed = urlparse(str(url))
        allowed = urlparse(self.config.parse_base_url)
        if parsed.scheme not in {"http", "https"}:
            raise FirmMcpError("invalid_config", "refusing non-http URL")
        if parsed.netloc != allowed.netloc:
            raise FirmMcpError("invalid_config", "refusing host outside configured Parse base")

    def request(self, method: str, path: str, **kwargs: Any) -> httpx.Response:
        if path.startswith("http://") or path.startswith("https://"):
            self._url_ok(path)
        try:
            response = self._client.request(method, path, **kwargs)
        except httpx.TimeoutException as exc:
            raise FirmMcpError("send_timeout", "Parse request timed out") from exc
        except httpx.HTTPError as exc:
            raise FirmMcpError("send_timeout", "Parse transport failed") from exc
        return response

    def _json(self, response: httpx.Response) -> Any:
        if response.status_code == 209 or (
            response.status_code in {400, 401} and "session" in response.text.lower()
        ):
            raise FirmMcpError("invalid_session", "Parse session was refused")
        if response.status_code >= 400:
            try:
                payload = response.json()
            except Exception:
                payload = {"error": response.text[:200]}
            code = payload.get("code")
            message = payload.get("error") or payload.get("message") or "Parse request failed"
            if code == 209:
                raise FirmMcpError("invalid_session", str(message))
            raise FirmMcpError("invalid_config", str(message))
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
            raise FirmMcpError("invalid_config", "class is not allowed")
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
            raise FirmMcpError("invalid_config", "file upload did not return a URL")
        return url

    def download_bytes(self, url: str) -> bytes:
        self._url_ok(url)
        try:
            response = self._client.get(url)
        except httpx.TimeoutException as exc:
            raise FirmMcpError("send_timeout", "file download timed out") from exc
        if response.status_code >= 400:
            raise FirmMcpError("not_completed", "signed file could not be downloaded")
        return response.content

    def cloud(self, name: str, params: dict) -> Any:
        allowed = {
            "createdocumentfromapp",
            "savecontact",
            "lexysignFirmSendInvitations",
            "generatecertificate",
        }
        if name not in allowed:
            raise FirmMcpError("invalid_config", "cloud function is not allowed")
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
