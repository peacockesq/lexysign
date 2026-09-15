from __future__ import annotations

import json
import logging
import sys
from typing import Any

from mcp.server.mcpserver import MCPServer

from . import TOOL_NAMES
from .config import load_config
from .errors import FirmMcpError
from .jsonutil import strict_json_loads
from .parse_client import ParseClient
from .redact import public_error, public_text
from . import service

logging.basicConfig(stream=sys.stderr, level=logging.WARNING, format="lexysign-mcp %(levelname)s %(message)s")
log = logging.getLogger("lexysign_firm_mcp")

server = MCPServer("lexysign-firm", instructions="LexySign firm document adapter. Local stdio MCP only.")
_CLIENT: ParseClient | None = None


def _client() -> ParseClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = ParseClient(load_config())
    return _CLIENT


def _ok(payload: dict[str, Any]) -> str:
    return public_text(payload)


def _fail(exc: FirmMcpError) -> str:
    log.warning("tool_error %s", exc.code)
    return public_text({"ok": False, "error": exc.code, "message": public_error(exc.code)})


@server.tool(name="firm_health", description="Authenticated LexySign identity and health for the configured firm principal.")
def firm_health() -> str:
    try:
        return _ok(service.firm_health(_client(), _client().config))
    except FirmMcpError as exc:
        return _fail(exc)


@server.tool(name="list_documents", description="Bounded paginated list of documents owned by the configured firm principal only.")
def list_documents(skip: int = 0, limit: int = 20) -> str:
    try:
        return _ok(service.list_documents(_client(), _client().config, skip=skip, limit=limit))
    except FirmMcpError as exc:
        return _fail(exc)


@server.tool(
    name="create_draft",
    description="Create a draft from a local PDF using explicit signer roles and page/rectangle field coordinates. Tag parsing is unsupported.",
)
def create_draft(
    pdf_path: str,
    title: str,
    signers_json: str,
    send_in_order: bool = False,
    time_to_complete_days: int = 15,
    parse_tags: bool = False,
    note: str = "",
) -> str:
    try:
        signers = strict_json_loads(signers_json)
        if not isinstance(signers, list):
            raise FirmMcpError("bad_bounds", "signers_json must be a JSON list")
        return _ok(
            service.create_draft(
                _client(),
                _client().config,
                pdf_path=pdf_path,
                title=title,
                signers=signers,
                send_in_order=send_in_order,
                time_to_complete_days=time_to_complete_days,
                parse_tags=parse_tags,
                note=note,
            )
        )
    except json.JSONDecodeError:
        return _fail(FirmMcpError("bad_bounds", "signers_json is not valid JSON"))
    except FirmMcpError as exc:
        return _fail(exc)


@server.tool(
    name="prepare_send",
    description="Build an immutable expiring send manifest and preview. Does not send mail and cannot mint approvals.",
)
def prepare_send(document_id: str, send_mode: str = "email") -> str:
    try:
        return _ok(service.prepare_send(_client(), _client().config, document_id=document_id, send_mode=send_mode))
    except FirmMcpError as exc:
        return _fail(exc)


@server.tool(
    name="send_invitations",
    description="Send or activate invitations only with a separately operator-issued approval bound to a prepare_send manifest.",
)
def send_invitations(manifest_id: str, approval_id: str) -> str:
    try:
        return _ok(
            service.send_invitations(
                _client(),
                _client().config,
                manifest_id=manifest_id,
                approval_id=approval_id,
            )
        )
    except FirmMcpError as exc:
        return _fail(exc)


@server.tool(name="document_status", description="Read lifecycle status and audit summary for a firm-owned document.")
def document_status(document_id: str) -> str:
    try:
        return _ok(service.document_status(_client(), _client().config, document_id=document_id))
    except FirmMcpError as exc:
        return _fail(exc)


@server.tool(
    name="download_signed",
    description="Download the completed signed PDF and certificate into the configured download root and return local paths plus hashes.",
)
def download_signed(document_id: str) -> str:
    try:
        return _ok(service.download_signed(_client(), _client().config, document_id=document_id))
    except FirmMcpError as exc:
        return _fail(exc)


def registered_tool_names() -> tuple[str, ...]:
    return TOOL_NAMES


async def run() -> None:
    await server.run_stdio_async()
