from __future__ import annotations

import hashlib
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader

from .errors import FirmMcpError

PDF_MAGIC = b"%PDF-"


def resolve_allowed_file(path: str, roots: tuple[Path, ...]) -> Path:
    if not path or "\x00" in path:
        raise FirmMcpError("bad_path", "invalid PDF path")
    raw = Path(path)
    if not raw.is_absolute():
        raise FirmMcpError("bad_path", "PDF path must be absolute")
    try:
        resolved = raw.resolve(strict=True)
    except OSError as exc:
        raise FirmMcpError("bad_path", "PDF not found") from exc
    if not resolved.is_file():
        raise FirmMcpError("bad_path", "PDF path is not a file")
    for root in roots:
        try:
            root_res = root.resolve()
        except OSError as exc:
            raise FirmMcpError("bad_path", "allowed root is not usable") from exc
        try:
            resolved.relative_to(root_res)
            return resolved
        except ValueError:
            continue
    raise FirmMcpError("bad_path", "PDF path is outside allowed roots")


def read_pdf_bytes(path: Path, max_bytes: int) -> bytes:
    size = path.stat().st_size
    if size > max_bytes:
        raise FirmMcpError("too_large", f"PDF exceeds {max_bytes} bytes")
    data = path.read_bytes()
    if not data.startswith(PDF_MAGIC):
        raise FirmMcpError("not_pdf", "file is not a PDF")
    return data


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_pages(data: bytes) -> list[dict[str, float]]:
    try:
        reader = PdfReader(BytesIO(data), strict=False)
        pages = []
        for index, page in enumerate(reader.pages, start=1):
            box = page.mediabox
            width = float(box.width)
            height = float(box.height)
            if width <= 0 or height <= 0:
                raise FirmMcpError("not_pdf", f"page {index} has invalid MediaBox")
            pages.append({"page": index, "width": width, "height": height})
        if not pages:
            raise FirmMcpError("not_pdf", "PDF has no pages")
        return pages
    except FirmMcpError:
        raise
    except Exception as exc:
        raise FirmMcpError("not_pdf", "PDF could not be parsed") from exc


def validate_rect(page: dict[str, float], field: dict) -> None:
    try:
        page_no = int(field["page"])
        x = float(field["x"])
        y = float(field["y"])
        width = float(field["width"])
        height = float(field["height"])
    except (KeyError, TypeError, ValueError) as exc:
        raise FirmMcpError("bad_bounds", "field coordinates must be numeric") from exc
    if page_no != int(page["page"]):
        raise FirmMcpError("bad_bounds", "field page does not match PDF page")
    if width <= 0 or height <= 0:
        raise FirmMcpError("bad_bounds", "field width and height must be positive")
    if x < 0 or y < 0:
        raise FirmMcpError("bad_bounds", "field origin must be on the page")
    if x + width > page["width"] + 0.01 or y + height > page["height"] + 0.01:
        raise FirmMcpError("bad_bounds", "field rectangle exceeds page bounds")


def safe_filename(name: str) -> str:
    stem = "".join(ch if ch.isalnum() or ch in "._-" else "_" for ch in Path(name).name)
    if not stem.lower().endswith(".pdf"):
        stem = f"{stem or 'document'}.pdf"
    return stem[:80]
