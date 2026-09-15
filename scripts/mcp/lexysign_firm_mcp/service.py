from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from .approval import verify_approval
from .auth import assert_owned_document, verify_identity
from .config import FirmConfig
from .errors import FirmMcpError
from .ledger import begin as ledger_begin
from .ledger import finish as ledger_finish
from .manifest import load_manifest, write_manifest
from .parse_client import ParseClient, _pointer_id
from .pdfutil import (
    parse_pages,
    read_pdf_bytes,
    resolve_allowed_file,
    safe_filename,
    sha256_bytes,
    write_private_exclusive,
)
from .placeholders import build_placeholders, pointer
from .redact import public_error

TERMINAL_CODES = ("completed", "declined", "archived")


def _status(document: dict) -> str:
    if document.get("IsArchive"):
        return "archived"
    if document.get("IsCompleted"):
        return "completed"
    if document.get("IsDeclined"):
        return "declined"
    expiry = document.get("ExpiryDate") or {}
    iso = expiry.get("iso") if isinstance(expiry, dict) else expiry
    if iso:
        try:
            when = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
            if when.tzinfo is None:
                when = when.replace(tzinfo=timezone.utc)
            if when <= datetime.now(timezone.utc):
                return "expired"
        except ValueError:
            pass
    if document.get("SignedUrl"):
        return "sent"
    return "draft"


def _public_doc(document: dict) -> dict[str, Any]:
    return {
        "object_id": document.get("objectId"),
        "title": document.get("Name"),
        "status": _status(document),
        "updated_at": document.get("updatedAt"),
        "is_completed": bool(document.get("IsCompleted")),
        "is_declined": bool(document.get("IsDeclined")),
        "send_in_order": bool(document.get("SendinOrder")),
        "signer_count": len(document.get("Signers") or []),
    }


def _load_owned(client: ParseClient, config: FirmConfig, document_id: str) -> dict:
    document = client.get_object(
        "contracts_Document",
        document_id,
        include="ExtUserPtr,ExtUserPtr.TenantId,CreatedBy,Signers,Placeholders,AuditTrail.UserPtr",
    )
    return assert_owned_document(document, config)


def _expiry_iso(document: dict) -> str:
    expiry = document.get("ExpiryDate") or {}
    iso = expiry.get("iso") if isinstance(expiry, dict) else expiry
    return str(iso or "")


def _rendered_subject(document: dict, identity: dict) -> str:
    sender = document.get("SenderName") or identity.get("name") or identity.get("email") or ""
    return f'{sender} has requested you to sign "{document.get("Name")}"'


def _canonical_placeholders(placeholders: list) -> list[dict[str, Any]]:
    out = []
    for item in placeholders or []:
        fields = []
        for page in item.get("placeHolder") or []:
            for pos in page.get("pos") or []:
                fields.append(
                    {
                        "page": int(page.get("pageNumber") or 0),
                        "type": str(pos.get("type") or ""),
                        "x": float(pos.get("xPosition") or 0),
                        "y": float(pos.get("yPosition") or 0),
                        "width": float(pos.get("Width") or 0),
                        "height": float(pos.get("Height") or 0),
                        "key": int(pos.get("key") or 0),
                    }
                )
        out.append(
            {
                "signerObjId": str(item.get("signerObjId") or _pointer_id(item.get("signerPtr"))),
                "role": str(item.get("Role") or item.get("role") or ""),
                "className": str((item.get("signerPtr") or {}).get("className") or "contracts_Contactbook"),
                "fields": fields,
            }
        )
    return out


def _validate_contact(contact: dict | None, config: FirmConfig) -> dict:
    if not contact or not contact.get("objectId"):
        raise FirmMcpError("foreign_contact", public_error("foreign_contact"))
    class_name = str(contact.get("className") or "contracts_Contactbook")
    if class_name not in {"contracts_Contactbook", "Pointer"}:
        raise FirmMcpError("foreign_contact", public_error("foreign_contact"))
    if contact.get("IsDeleted") is True:
        raise FirmMcpError("foreign_contact", public_error("foreign_contact"))
    created = _pointer_id(contact.get("CreatedBy"))
    tenant = _pointer_id(contact.get("TenantId"))
    if created != config.principal_user_id:
        raise FirmMcpError("foreign_contact", public_error("foreign_contact"))
    if tenant != config.tenant_id:
        raise FirmMcpError("foreign_contact", public_error("foreign_contact"))
    return contact


def _fetch_contact(client: ParseClient, config: FirmConfig, object_id: str) -> dict:
    row = client.get_object("contracts_Contactbook", object_id)
    return _validate_contact(row, config)


def firm_health(client: ParseClient, config: FirmConfig) -> dict[str, Any]:
    identity = verify_identity(client, config)
    return {
        "ok": True,
        "product": "LexySign",
        "tenant_id": identity["tenant_id"],
        "principal_user_id": identity["user_id"],
        "extuser_id": identity["extuser_id"],
        "email": identity["email"],
        "parse_ok": True,
    }


def list_documents(client: ParseClient, config: FirmConfig, skip: int = 0, limit: int = 20) -> dict[str, Any]:
    verify_identity(client, config)
    limit = max(1, min(int(limit or 20), config.page_limit))
    skip = max(0, int(skip or 0))
    rows = client.query_class(
        "contracts_Document",
        client.owner_document_where(),
        include="ExtUserPtr,ExtUserPtr.TenantId,CreatedBy,Signers",
        order="-updatedAt",
        skip=str(skip),
        limit=str(limit),
        keys="Name,updatedAt,IsCompleted,IsDeclined,IsArchive,ExpiryDate,SendinOrder,Signers,ExtUserPtr,CreatedBy,SignedUrl",
    )
    owned = []
    for row in rows:
        try:
            assert_owned_document(row, config)
        except FirmMcpError:
            continue
        owned.append(_public_doc(row))
    return {"ok": True, "documents": owned, "skip": skip, "limit": limit, "has_more": len(rows) == limit}


def _ensure_contact(client: ParseClient, config: FirmConfig, signer: dict) -> dict:
    email = str(signer.get("email") or "").lower().replace(" ", "")
    name = str(signer.get("name") or email)
    if not email or "@" not in email:
        raise FirmMcpError("bad_bounds", "signer email is required")
    existing = client.query_class(
        "contracts_Contactbook",
        {
            "Email": email,
            "CreatedBy": pointer("_User", config.principal_user_id),
            "TenantId": pointer("partners_Tenant", config.tenant_id),
            "IsDeleted": {"$ne": True},
        },
        limit="1",
    )
    if existing:
        return _fetch_contact(client, config, existing[0]["objectId"])
    try:
        created = client.cloud(
            "savecontact",
            {
                "name": name,
                "email": email,
                "phone": signer.get("phone") or "",
                "tenantId": config.tenant_id,
            },
        )
        if isinstance(created, dict) and created.get("objectId"):
            return _fetch_contact(client, config, created["objectId"])
    except FirmMcpError:
        existing = client.query_class(
            "contracts_Contactbook",
            {
                "Email": email,
                "CreatedBy": pointer("_User", config.principal_user_id),
                "TenantId": pointer("partners_Tenant", config.tenant_id),
                "IsDeleted": {"$ne": True},
            },
            limit="1",
        )
        if existing:
            return _fetch_contact(client, config, existing[0]["objectId"])
        raise
    raise FirmMcpError("invalid_config", public_error("invalid_config"))


def create_draft(
    client: ParseClient,
    config: FirmConfig,
    *,
    pdf_path: str,
    title: str,
    signers: list[dict],
    send_in_order: bool = False,
    time_to_complete_days: int = 15,
    parse_tags: bool = False,
    note: str = "",
) -> dict[str, Any]:
    if parse_tags:
        raise FirmMcpError(
            "tag_parse_unsupported",
            "PDF tag/prefill parsing is not supported in v1; pass explicit page/rectangle coordinates",
        )
    verify_identity(client, config)
    path = resolve_allowed_file(pdf_path, config.allowed_pdf_roots)
    data = read_pdf_bytes(path, config.max_pdf_bytes)
    pages = parse_pages(data, max_pages=config.page_limit)
    file_hash = sha256_bytes(data)
    contacts = [_ensure_contact(client, config, signer) for signer in signers]
    placeholders = build_placeholders(signers=signers, contacts=contacts, pages=pages)
    url = client.upload_pdf(safe_filename(path.name), data)
    document = {
        "Name": (title or path.stem)[:250],
        "URL": url,
        "Note": (note or "")[:200],
        "ExtUserPtr": pointer("contracts_Users", config.principal_extuser_id),
        "CreatedBy": pointer("_User", config.principal_user_id),
        "Signers": [pointer("contracts_Contactbook", item["objectId"]) for item in contacts],
        "Placeholders": placeholders,
        "SendinOrder": bool(send_in_order),
        "SentToOthers": False,
        "TimeToCompleteDays": int(time_to_complete_days or 15),
        "IsEnableOTP": False,
        "AutomaticReminders": False,
        "NotifyOnSignatures": False,
    }
    created = client.cloud("createdocumentfromapp", {"document": document})
    object_id = created.get("objectId") if isinstance(created, dict) else None
    if not object_id:
        raise FirmMcpError("invalid_config", public_error("invalid_config"))
    return {
        "ok": True,
        "document_id": object_id,
        "title": document["Name"],
        "file_hash": file_hash,
        "page_count": len(pages),
        "signer_count": len(contacts),
        "source_pdf_unchanged": True,
    }


def _current_binding(document: dict, identity: dict, pdf_hash: str, send_mode: str) -> dict[str, Any]:
    signers = document.get("Signers") or []
    placeholders = document.get("Placeholders") or []
    recipients = []
    for index, signer in enumerate(signers):
        contact_id = str(signer.get("objectId") or "")
        placeholder = next(
            (
                item
                for item in placeholders
                if str(item.get("signerObjId") or _pointer_id(item.get("signerPtr"))) == contact_id
            ),
            {},
        )
        recipients.append(
            {
                "email": str(signer.get("Email") or signer.get("email") or "").lower().replace(" ", ""),
                "name": signer.get("Name") or "",
                "contact_id": contact_id,
                "order": index + 1,
                "role": str(placeholder.get("Role") or placeholder.get("role") or "signer"),
                "className": str(signer.get("className") or "contracts_Contactbook"),
            }
        )
    return {
        "title": document.get("Name"),
        "fileUrl": str(document.get("URL") or ""),
        "fileHash": pdf_hash,
        "recipients": recipients,
        "order": "sequential" if document.get("SendinOrder") else "parallel",
        "expiry": _expiry_iso(document),
        "timeToCompleteDays": int(document.get("TimeToCompleteDays") or 15),
        "subject": _rendered_subject(document, identity),
        "sendMode": "manual" if send_mode == "manual" else "email",
        "placeholders": placeholders,
        "documentUpdatedAt": document.get("updatedAt") or "",
    }


def prepare_send(
    client: ParseClient,
    config: FirmConfig,
    *,
    document_id: str,
    send_mode: str = "email",
) -> dict[str, Any]:
    identity = verify_identity(client, config)
    document = _load_owned(client, config, document_id)
    status = _status(document)
    if status in TERMINAL_CODES or status == "expired":
        raise FirmMcpError("document_terminal" if status != "expired" else "document_expired", f"cannot prepare a {status} document")
    signers = document.get("Signers") or []
    if not signers:
        raise FirmMcpError("bad_bounds", "document has no recipients")
    placeholders = document.get("Placeholders") or []
    if not placeholders:
        raise FirmMcpError("payload_modified", "document has empty signer fields")
    for signer in signers:
        class_name = str(signer.get("className") or "contracts_Contactbook")
        if class_name in {"contracts_Contactbook", "Pointer", ""}:
            _validate_contact(signer, config)
    pdf_bytes = client.acquire_document_bytes(document_id, "source")
    file_hash = sha256_bytes(pdf_bytes)
    parse_pages(pdf_bytes, max_pages=config.page_limit)
    expected = _current_binding(document, identity, file_hash, send_mode)
    recipients = expected["recipients"]
    manifest = write_manifest(
        config,
        {
            "document_id": document_id,
            "title": expected["title"],
            "file_url": expected["fileUrl"],
            "file_hash": file_hash,
            "recipients": recipients,
            "order": expected["order"],
            "expiry": expected["expiry"],
            "time_to_complete_days": expected["timeToCompleteDays"],
            "send_mode": expected["sendMode"],
            "subject": expected["subject"],
            "placeholders": _canonical_placeholders(placeholders),
            "expected": expected,
        },
    )
    return {
        "ok": True,
        "manifest_id": manifest["manifest_id"],
        "manifest_hash": manifest["manifest_hash"],
        "expires_at": manifest["expires_at"],
        "preview": {
            "title": manifest["title"],
            "document_id": document_id,
            "file_hash": manifest["file_hash"],
            "recipients": recipients,
            "order": manifest["order"],
            "expiry": manifest["expiry"],
            "subject": manifest["subject"],
            "send_mode": manifest["send_mode"],
        },
        "approval_required": True,
        "approval_tool_available": False,
    }


def _assert_fresh(manifest: dict[str, Any]) -> None:
    if int(manifest.get("expires_at") or 0) < int(time.time()):
        raise FirmMcpError("approval_expired", public_error("approval_expired"))


def _compare_current(document: dict, manifest: dict[str, Any], identity: dict, pdf_hash: str) -> None:
    expected = manifest.get("expected") or {}
    current = _current_binding(document, identity, pdf_hash, manifest.get("send_mode") or "email")
    for key in ("title", "fileUrl", "fileHash", "order", "expiry", "timeToCompleteDays", "subject", "sendMode"):
        if current.get(key) != expected.get(key):
            raise FirmMcpError("payload_modified", public_error("payload_modified"))
    if current.get("recipients") != expected.get("recipients"):
        raise FirmMcpError("payload_modified", public_error("payload_modified"))
    if _canonical_placeholders(current.get("placeholders") or []) != _canonical_placeholders(expected.get("placeholders") or []):
        raise FirmMcpError("payload_modified", public_error("payload_modified"))
    if document.get("Name") != manifest["title"] or document.get("URL") != manifest["file_url"]:
        raise FirmMcpError("payload_modified", public_error("payload_modified"))


def _store_manual_artifacts(config: FirmConfig, document_id: str, artifacts: list[dict]) -> str:
    if not artifacts:
        raise FirmMcpError("invalid_config", "manual links were not generated")
    directory = config.state_dir / "manual_links"
    directory.mkdir(parents=True, exist_ok=True)
    handle = f"ml-{document_id}"
    path = directory / f"{handle}.json"
    from .jsonutil import canonical_dumps

    write_private_exclusive(path, canonical_dumps({"document_id": document_id, "artifacts": artifacts}).encode("utf-8"), config.state_dir)
    return handle


def send_invitations(
    client: ParseClient,
    config: FirmConfig,
    *,
    manifest_id: str,
    approval_id: str,
) -> dict[str, Any]:
    identity = verify_identity(client, config)
    if not approval_id:
        raise FirmMcpError("approval_missing", public_error("approval_missing"))
    manifest = load_manifest(config, manifest_id)
    approval = verify_approval(config, approval_id, manifest)
    _assert_fresh(manifest)
    if int(approval.get("expires_at") or 0) < int(time.time()):
        raise FirmMcpError("approval_expired", public_error("approval_expired"))
    document = _load_owned(client, config, manifest["document_id"])
    status = _status(document)
    if status == "expired":
        raise FirmMcpError("document_expired", public_error("document_expired"))
    if status in TERMINAL_CODES:
        raise FirmMcpError("document_terminal", public_error("document_terminal"))
    for signer in document.get("Signers") or []:
        class_name = str(signer.get("className") or "contracts_Contactbook")
        if class_name in {"contracts_Contactbook", "Pointer", ""}:
            _validate_contact(signer, config)
    pdf_bytes = client.acquire_document_bytes(manifest["document_id"], "source")
    pdf_hash = sha256_bytes(pdf_bytes)
    manifest = load_manifest(config, manifest_id)
    approval = verify_approval(config, approval_id, manifest)
    _assert_fresh(manifest)
    document = _load_owned(client, config, manifest["document_id"])
    status = _status(document)
    if status == "expired":
        raise FirmMcpError("document_expired", public_error("document_expired"))
    if status in TERMINAL_CODES:
        raise FirmMcpError("document_terminal", public_error("document_terminal"))
    _compare_current(document, manifest, identity, pdf_hash)
    ledger_begin(config, manifest["document_id"], manifest["manifest_hash"])
    try:
        result = client.cloud(
            "lexysignFirmSendInvitations",
            {
                "documentId": manifest["document_id"],
                "sendMode": manifest["send_mode"],
                "expected": manifest["expected"],
                "approval": approval["native_token"],
            },
        )
    except FirmMcpError as exc:
        if exc.code in {"send_timeout", "uncertain_send"}:
            ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "uncertain")
            raise FirmMcpError("uncertain_send", public_error("uncertain_send")) from exc
        if exc.code in {
            "payload_modified",
            "document_terminal",
            "document_expired",
            "approval_missing",
            "approval_expired",
            "approval_mismatch",
            "approval_unconfigured",
            "foreign_contact",
            "insufficient_quota",
            "forbidden",
            "missing_signers",
            "invalid_origin",
        }:
            ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "failed_before_provider", {"error": exc.code})
            raise
        if exc.code == "duplicate_send":
            ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "accepted")
            raise
        ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "uncertain", {"error": exc.code})
        raise FirmMcpError("uncertain_send", public_error("uncertain_send")) from exc
    native_status = result.get("status") if isinstance(result, dict) else ""
    if native_status == "uncertain":
        ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "uncertain")
        raise FirmMcpError("uncertain_send", public_error("uncertain_send"))
    if native_status in {"already_dispatched"}:
        ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "accepted")
        raise FirmMcpError("duplicate_send", public_error("duplicate_send"))
    state = "activated_manual" if native_status == "activated_manual" else "accepted"
    if native_status == "partial_failure":
        state = "accepted_partial"
    if native_status in {"smtp_error", "uncertain"}:
        state = "uncertain"
        ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "uncertain")
        raise FirmMcpError("uncertain_send", public_error("uncertain_send"))
    ledger_finish(
        config,
        manifest["document_id"],
        manifest["manifest_hash"],
        state,
        {"native_status": native_status, "smtp_accepted": bool(result.get("smtp_accepted")), "delivered": False},
    )
    recipients = []
    for item in result.get("recipients") or []:
        recipients.append(
            {
                "email": item.get("email"),
                "smtp_accepted": bool(item.get("smtp_accepted")),
                "delivery": item.get("delivery"),
            }
        )
    payload = {
        "ok": True,
        "document_id": manifest["document_id"],
        "native_status": native_status,
        "smtp_accepted": bool(result.get("smtp_accepted")),
        "delivered": False,
        "recipients": recipients,
    }
    if manifest["send_mode"] == "manual":
        artifacts = result.get("manual_artifacts") or []
        if not artifacts:
            payload["manual_links"] = "unsupported"
        else:
            handle = _store_manual_artifacts(config, manifest["document_id"], artifacts)
            payload["manual_links"] = "stored_privately"
            payload["manual_artifact"] = handle
    return payload


def document_status(client: ParseClient, config: FirmConfig, document_id: str) -> dict[str, Any]:
    verify_identity(client, config)
    document = _load_owned(client, config, document_id)
    trail = []
    for item in document.get("AuditTrail") or []:
        user = item.get("UserPtr") or {}
        trail.append(
            {
                "activity": item.get("Activity"),
                "email": user.get("Email") or "",
                "signed_on": item.get("SignedOn"),
            }
        )
    return {
        "ok": True,
        **_public_doc(document),
        "expiry": (document.get("ExpiryDate") or {}).get("iso") if isinstance(document.get("ExpiryDate"), dict) else document.get("ExpiryDate"),
        "audit": trail,
        "has_certificate": bool(document.get("CertificateUrl")),
        "has_signed_pdf": bool(document.get("SignedUrl")),
    }


def download_signed(client: ParseClient, config: FirmConfig, document_id: str) -> dict[str, Any]:
    verify_identity(client, config)
    document = _load_owned(client, config, document_id)
    if _status(document) != "completed":
        raise FirmMcpError("not_completed", public_error("not_completed"))
    pdf_bytes = client.acquire_document_bytes(document_id, "signed")
    write_private_exclusive(config.download_root / f"{document_id}-signed.pdf", pdf_bytes, config.download_root)
    pdf_path = (config.download_root / f"{document_id}-signed.pdf").resolve()
    result = {
        "ok": True,
        "document_id": document_id,
        "signed_pdf_path": str(pdf_path),
        "signed_pdf_sha256": sha256_bytes(pdf_bytes),
        "audit": document_status(client, config, document_id)["audit"],
    }
    if document.get("CertificateUrl"):
        cert_bytes = client.acquire_document_bytes(document_id, "certificate")
        cert_path = write_private_exclusive(
            config.download_root / f"{document_id}-certificate.pdf", cert_bytes, config.download_root
        )
        result["certificate_path"] = str(cert_path)
        result["certificate_sha256"] = sha256_bytes(cert_bytes)
    else:
        try:
            generated = client.cloud("generatecertificate", {"docId": document_id})
            cert_url = generated.get("CertificateUrl") if isinstance(generated, dict) else None
            if cert_url:
                cert_bytes = client.acquire_document_bytes(document_id, "certificate")
                cert_path = write_private_exclusive(
                    config.download_root / f"{document_id}-certificate.pdf", cert_bytes, config.download_root
                )
                result["certificate_path"] = str(cert_path)
                result["certificate_sha256"] = sha256_bytes(cert_bytes)
            else:
                result["certificate_path"] = None
        except FirmMcpError:
            result["certificate_path"] = None
    return result
