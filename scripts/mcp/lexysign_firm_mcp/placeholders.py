from __future__ import annotations

from .errors import FirmMcpError
from .pdfutil import validate_rect

ALLOWED_FIELD_TYPES = {
    "signature",
    "initials",
    "stamp",
    "name",
    "email",
    "date",
    "text",
    "checkbox",
    "company",
    "job title",
}
BLOCK_COLORS = (
    "#93a3db",
    "#e6c3db",
    "#c0e3bc",
    "#bce3db",
    "#b8ccdb",
    "#ceb8db",
)


def pointer(class_name: str, object_id: str) -> dict:
    return {"__type": "Pointer", "className": class_name, "objectId": object_id}


def build_placeholders(*, signers: list[dict], contacts: list[dict], pages: list[dict]) -> list[dict]:
    if not signers:
        raise FirmMcpError("bad_bounds", "at least one signer is required")
    page_by_no = {int(item["page"]): item for item in pages}
    placeholders = []
    widget_key = 1
    for index, signer in enumerate(signers):
        fields = signer.get("fields")
        if not isinstance(fields, list) or not fields:
            raise FirmMcpError("bad_bounds", "each signer needs explicit field coordinates")
        role = str(signer.get("role") or "signer")
        if role == "prefill":
            raise FirmMcpError("tag_parse_unsupported", "prefill/tag parsing is not supported; pass explicit coordinates")
        contact = contacts[index]
        grouped: dict[int, list[dict]] = {}
        for field in fields:
            field_type = str(field.get("type") or "")
            if field_type not in ALLOWED_FIELD_TYPES:
                raise FirmMcpError("bad_bounds", f"unsupported field type {field_type}")
            try:
                page_no = int(field["page"])
            except (KeyError, TypeError, ValueError) as exc:
                raise FirmMcpError("bad_bounds", "field page is required") from exc
            page = page_by_no.get(page_no)
            if page is None:
                raise FirmMcpError("bad_bounds", f"page {page_no} is not in the PDF")
            validate_rect(page, field)
            pos = {
                "xPosition": float(field["x"]),
                "yPosition": float(field["y"]),
                "Width": float(field["width"]),
                "Height": float(field["height"]),
                "isStamp": field_type == "stamp",
                "key": widget_key,
                "scale": 1,
                "zIndex": 1,
                "type": field_type,
                "options": {
                    "name": str(field.get("label") or field_type),
                    "status": "required" if field.get("required", True) else "optional",
                    "required": bool(field.get("required", True)),
                    "defaultValue": "",
                    "hint": "",
                },
            }
            grouped.setdefault(page_no, []).append(pos)
            widget_key += 1
        placeholders.append(
            {
                "Id": str(signer.get("id") or f"s{index + 1}"),
                "Role": role,
                "blockColor": BLOCK_COLORS[index % len(BLOCK_COLORS)],
                "signerPtr": pointer("contracts_Contactbook", contact["objectId"]),
                "signerObjId": contact["objectId"],
                "placeHolder": [{"pageNumber": page_no, "pos": pos_list} for page_no, pos_list in grouped.items()],
            }
        )
    return placeholders
