from __future__ import annotations

import json
from pathlib import Path

import pytest
from pypdf import PdfWriter

from lexysign_firm_mcp.config import load_config
from lexysign_firm_mcp.parse_client import ParseClient

from tests.fake_parse import PRINCIPAL, start_fake_parse


def make_pdf(path: Path, pages: int = 1, width: float = 612, height: float = 792) -> Path:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width, height)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        writer.write(handle)
    return path


@pytest.fixture
def fake_parse():
    server, base, store = start_fake_parse()
    try:
        yield server, base, store
    finally:
        server.shutdown()
        server.server_close()


@pytest.fixture
def harness(tmp_path, fake_parse):
    _server, base, store = fake_parse
    pdf_root = tmp_path / "pdfs"
    download = tmp_path / "out"
    state = tmp_path / "state"
    pdf_root.mkdir()
    download.mkdir()
    state.mkdir()
    token = tmp_path / "session"
    secret = tmp_path / "approval.secret"
    token.write_text(PRINCIPAL["token"], encoding="utf-8")
    secret.write_text("operator-approval-secret", encoding="utf-8")
    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "parse_base_url": base,
                "parse_app_id": "opensign",
                "tenant_id": PRINCIPAL["tenant"],
                "principal_user_id": PRINCIPAL["user"],
                "principal_extuser_id": PRINCIPAL["ext"],
                "session_token_file": str(token),
                "approval_secret_file": str(secret),
                "allowed_pdf_roots": [str(pdf_root)],
                "download_root": str(download),
                "state_dir": str(state),
                "public_origin": "https://sign.lexyalgo.com",
                "http_timeout_seconds": 0.6,
                "manifest_ttl_seconds": 3600,
                "approval_ttl_seconds": 3600,
            }
        ),
        encoding="utf-8",
    )
    config = load_config(config_path)
    client = ParseClient(config)
    pdf = make_pdf(pdf_root / "retainer.pdf", pages=2)
    try:
        yield {
            "config": config,
            "config_path": config_path,
            "client": client,
            "store": store,
            "base": base,
            "pdf": pdf,
            "pdf_root": pdf_root,
            "tmp": tmp_path,
        }
    finally:
        client.close()
