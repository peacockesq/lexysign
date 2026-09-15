from __future__ import annotations

import hashlib
import math
import os
import stat
from io import BytesIO
from pathlib import Path

from pypdf import PdfReader

from .errors import FirmMcpError

PDF_MAGIC = b"%PDF-"
MAX_PAGES_DEFAULT = 50


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


def parse_pages(data: bytes, max_pages: int = MAX_PAGES_DEFAULT) -> list[dict[str, float]]:
    if not data.startswith(PDF_MAGIC):
        raise FirmMcpError("not_pdf", "file is not a PDF")
    try:
        reader = PdfReader(BytesIO(data), strict=False)
        if len(reader.pages) > max_pages:
            raise FirmMcpError("bad_bounds", f"PDF exceeds {max_pages} pages")
        pages = []
        for index, page in enumerate(reader.pages, start=1):
            box = page.mediabox
            width = float(box.width)
            height = float(box.height)
            if not math.isfinite(width) or not math.isfinite(height) or width <= 0 or height <= 0:
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
    if not all(math.isfinite(value) for value in (x, y, width, height, float(page["width"]), float(page["height"]))):
        raise FirmMcpError("bad_bounds", "field coordinates must be finite")
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


def ensure_private_dir(path: Path, root: Path) -> Path:
    root_res = root.resolve()
    path.mkdir(parents=True, exist_ok=True)
    current = path
    while True:
        try:
            info = current.lstat()
        except OSError as exc:
            raise FirmMcpError("bad_path", "download directory is not usable") from exc
        if stat.S_ISLNK(info.st_mode):
            raise FirmMcpError("bad_path", "download directory must not be a symlink")
        if not stat.S_ISDIR(info.st_mode):
            raise FirmMcpError("bad_path", "download directory is not a directory")
        os.chmod(current, 0o700)
        if current.resolve() == root_res:
            break
        if current.parent == current:
            raise FirmMcpError("bad_path", "download directory escapes root")
        current = current.parent
    return path


def write_private_exclusive(path: Path, data: bytes, root: Path) -> Path:
    root_res = root.resolve()
    ensure_private_dir(path.parent, root)
    try:
        path.relative_to(root_res)
    except ValueError as exc:
        raise FirmMcpError("bad_path", "download path escapes root") from exc
    if path.exists() or path.is_symlink():
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise FirmMcpError("bad_path", "refusing to overwrite a symlink")
        if not stat.S_ISREG(info.st_mode):
            raise FirmMcpError("bad_path", "refusing to overwrite a non-file")
        os.remove(path)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(str(path), flags, 0o600)
    try:
        os.write(fd, data)
        os.fchmod(fd, 0o600)
    finally:
        os.close(fd)
    return path
