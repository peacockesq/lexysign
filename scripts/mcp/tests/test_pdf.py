from __future__ import annotations

from lexysign_firm_mcp.errors import FirmMcpError
from lexysign_firm_mcp.pdfutil import parse_pages, read_pdf_bytes, resolve_allowed_file, sha256_bytes, validate_rect
from lexysign_firm_mcp.placeholders import build_placeholders

from tests.conftest import make_pdf
from tests.fake_parse import LETTER_PDF


def test_real_pypdf_parse_and_bounds(tmp_path):
    pdf = make_pdf(tmp_path / "ok.pdf", pages=2, width=612, height=792)
    data = read_pdf_bytes(pdf, 25 * 1024 * 1024)
    assert data.startswith(b"%PDF-")
    pages = parse_pages(data)
    assert len(pages) == 2
    assert pages[0]["width"] == 612
    assert pages[0]["height"] == 792
    validate_rect(pages[0], {"page": 1, "x": 72, "y": 72, "width": 180, "height": 38})
    digest = sha256_bytes(data)
    assert len(digest) == 64
    assert pdf.read_bytes() == data


def test_rejects_bad_magic_and_oversize(tmp_path):
    bad = tmp_path / "nope.txt"
    bad.write_bytes(b"not a pdf")
    try:
        read_pdf_bytes(bad, 1000)
        raise AssertionError("expected not_pdf")
    except FirmMcpError as exc:
        assert exc.code == "not_pdf"
    big = tmp_path / "big.pdf"
    big.write_bytes(b"%PDF-" + b"x" * 50)
    try:
        read_pdf_bytes(big, 10)
        raise AssertionError("expected too_large")
    except FirmMcpError as exc:
        assert exc.code == "too_large"


def test_path_traversal_and_symlink(tmp_path):
    root = tmp_path / "root"
    root.mkdir()
    outside = tmp_path / "outside.pdf"
    make_pdf(outside)
    try:
        resolve_allowed_file(str(outside), (root,))
        raise AssertionError("expected bad_path")
    except FirmMcpError as exc:
        assert exc.code == "bad_path"
    try:
        resolve_allowed_file(str(root / ".." / "outside.pdf"), (root,))
        raise AssertionError("expected bad_path")
    except FirmMcpError as exc:
        assert exc.code == "bad_path"
    target = tmp_path / "escaped.pdf"
    make_pdf(target)
    link = root / "link.pdf"
    link.symlink_to(target)
    try:
        resolve_allowed_file(str(link), (root,))
        raise AssertionError("expected symlink escape")
    except FirmMcpError as exc:
        assert exc.code == "bad_path"


def test_out_of_page_bounds(tmp_path):
    pdf = make_pdf(tmp_path / "page.pdf")
    pages = parse_pages(read_pdf_bytes(pdf, 10_000_000))
    try:
        validate_rect(pages[0], {"page": 1, "x": 600, "y": 10, "width": 40, "height": 40})
        raise AssertionError("expected bad_bounds")
    except FirmMcpError as exc:
        assert exc.code == "bad_bounds"
    try:
        validate_rect(pages[0], {"page": 9, "x": 1, "y": 1, "width": 10, "height": 10})
        raise AssertionError("expected bad_bounds")
    except FirmMcpError as exc:
        assert exc.code == "bad_bounds"


def test_explicit_placeholders_only():
    pages = [{"page": 1, "width": 612, "height": 792}]
    signers = [
        {
            "name": "Client",
            "email": "client@example.com",
            "role": "client",
            "fields": [{"type": "signature", "page": 1, "x": 72, "y": 100, "width": 180, "height": 38}],
        }
    ]
    contacts = [{"objectId": "contact-1"}]
    built = build_placeholders(signers=signers, contacts=contacts, pages=pages)
    assert built[0]["Role"] == "client"
    assert built[0]["placeHolder"][0]["pos"][0]["Width"] == 180
    try:
        build_placeholders(
            signers=[{"name": "x", "email": "a@b.c", "role": "prefill", "fields": signers[0]["fields"]}],
            contacts=contacts,
            pages=pages,
        )
        raise AssertionError("expected unsupported")
    except FirmMcpError as exc:
        assert exc.code == "tag_parse_unsupported"


def test_handwritten_pdf_magic_is_real():
    pages = parse_pages(LETTER_PDF)
    assert pages[0]["width"] == 612
