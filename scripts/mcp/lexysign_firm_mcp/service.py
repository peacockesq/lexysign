from __future__ import annotations

from datetime import datetime, timedelta, timezone
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
)
from .placeholders import build_placeholders, pointer

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
            "IsDeleted": {"$ne": True},
        },
        limit="1",
    )
    if existing:
        return existing[0]
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
            return created
    except FirmMcpError:
        existing = client.query_class(
            "contracts_Contactbook",
            {
                "Email": email,
                "CreatedBy": pointer("_User", config.principal_user_id),
                "IsDeleted": {"$ne": True},
            },
            limit="1",
        )
        if existing:
            return existing[0]
        raise
    raise FirmMcpError("invalid_config", "contact could not be created")


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
    pages = parse_pages(data)
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
        raise FirmMcpError("invalid_config", "draft was not created")
    return {
        "ok": True,
        "document_id": object_id,
        "title": document["Name"],
        "file_hash": file_hash,
        "page_count": len(pages),
        "signer_count": len(contacts),
        "source_pdf_unchanged": True,
    }


def prepare_send(
    client: ParseClient,
    config: FirmConfig,
    *,
    document_id: str,
    send_mode: str = "email",
) -> dict[str, Any]:
    verify_identity(client, config)
    document = _load_owned(client, config, document_id)
    status = _status(document)
    if status in TERMINAL_CODES or status == "expired":
        raise FirmMcpError("document_terminal" if status != "expired" else "document_expired", f"cannot prepare a {status} document")
    signers = document.get("Signers") or []
    recipients = []
    for index, signer in enumerate(signers):
        recipients.append(
            {
                "email": str(signer.get("Email") or signer.get("email") or "").lower(),
                "name": signer.get("Name") or "",
                "contact_id": signer.get("objectId"),
                "order": index + 1,
            }
        )
    if not recipients:
        raise FirmMcpError("bad_bounds", "document has no recipients")
    file_url = str(document.get("URL") or "")
    try:
        file_hash = sha256_bytes(client.download_bytes(file_url))
    except FirmMcpError:
        file_hash = sha256_bytes(str(file_url or "").encode("utf-8"))
    expiry = document.get("ExpiryDate") or {}
    expiry_iso = expiry.get("iso") if isinstance(expiry, dict) else expiry
    if not expiry_iso:
        days = int(document.get("TimeToCompleteDays") or 15)
        expiry_iso = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
    manifest = write_manifest(
        config,
        {
            "document_id": document_id,
            "title": document.get("Name"),
            "file_url": file_url,
            "file_hash": file_hash,
            "recipients": recipients,
            "order": "sequential" if document.get("SendinOrder") else "parallel",
            "expiry": expiry_iso,
            "send_mode": "manual" if send_mode == "manual" else "email",
            "subject": f'Please sign "{document.get("Name")}"',
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


def send_invitations(
    client: ParseClient,
    config: FirmConfig,
    *,
    manifest_id: str,
    approval_id: str,
) -> dict[str, Any]:
    verify_identity(client, config)
    if not approval_id:
        raise FirmMcpError("approval_missing", "operator-issued approval_id is required")
    manifest = load_manifest(config, manifest_id)
    verify_approval(config, approval_id, manifest)
    document = _load_owned(client, config, manifest["document_id"])
    status = _status(document)
    if status == "expired":
        raise FirmMcpError("document_expired", "document expired after approval")
    if status in TERMINAL_CODES:
        raise FirmMcpError("document_terminal", f"document is {status}")
    current_hash = sha256_bytes(str(document.get("URL") or "").encode("utf-8"))
    try:
        current_hash = sha256_bytes(client.download_bytes(str(document.get("URL") or "")))
    except FirmMcpError:
        pass
    if current_hash != manifest["file_hash"] or document.get("Name") != manifest["title"] or document.get("URL") != manifest["file_url"]:
        raise FirmMcpError("payload_modified", "document changed after approval")
    current_emails = [
        str(item.get("Email") or item.get("email") or "").lower() for item in (document.get("Signers") or [])
    ]
    approved_emails = [item["email"] for item in manifest["recipients"]]
    if current_emails != approved_emails:
        raise FirmMcpError("payload_modified", "recipients changed after approval")
    ledger_begin(config, manifest["document_id"], manifest["manifest_hash"])
    try:
        result = client.cloud(
            "lexysignFirmSendInvitations",
            {
                "documentId": manifest["document_id"],
                "sendMode": manifest["send_mode"],
                "expected": {
                    "title": manifest["title"],
                    "fileUrl": manifest["file_url"],
                    "recipients": manifest["recipients"],
                },
            },
        )
    except FirmMcpError as exc:
        if exc.code == "send_timeout":
            ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "uncertain")
            raise FirmMcpError("uncertain_send", "send timed out after dispatch; refusing retry") from exc
        ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "failed", {"error": exc.code})
        raise
    native_status = result.get("status") if isinstance(result, dict) else ""
    if native_status == "uncertain":
        ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "uncertain")
        raise FirmMcpError("uncertain_send", "native send reported an uncertain delivery")
    if native_status in {"already_dispatched"}:
        ledger_finish(config, manifest["document_id"], manifest["manifest_hash"], "accepted")
        raise FirmMcpError("duplicate_send", "document was already sent")
    state = "activated_manual" if native_status == "activated_manual" else "accepted"
    if native_status == "partial_failure":
        state = "accepted_partial"
    if native_status == "smtp_error":
        state = "failed"
    ledger_finish(
        config,
        manifest["document_id"],
        manifest["manifest_hash"],
        state,
        {"native_status": native_status, "smtp_accepted": bool(result.get("smtp_accepted")), "delivered": False},
    )
    if state == "failed":
        raise FirmMcpError("smtp_error", "SMTP did not accept the invitation mail")
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
        payload["manual_links"] = "stored_privately"
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
        raise FirmMcpError("not_completed", "only completed documents can be downloaded here")
    signed_url = document.get("SignedUrl") or document.get("URL")
    if not signed_url:
        raise FirmMcpError("not_completed", "signed PDF is missing")
    pdf_bytes = client.download_bytes(signed_url)
    config.download_root.mkdir(parents=True, exist_ok=True)
    pdf_path = (config.download_root / f"{document_id}-signed.pdf").resolve()
    pdf_path.relative_to(config.download_root.resolve())
    pdf_path.write_bytes(pdf_bytes)
    result = {
        "ok": True,
        "document_id": document_id,
        "signed_pdf_path": str(pdf_path),
        "signed_pdf_sha256": sha256_bytes(pdf_bytes),
        "audit": document_status(client, config, document_id)["audit"],
    }
    cert_url = document.get("CertificateUrl")
    if cert_url:
        cert_bytes = client.download_bytes(cert_url)
        cert_path = config.download_root / f"{document_id}-certificate.pdf"
        cert_path.write_bytes(cert_bytes)
        result["certificate_path"] = str(cert_path)
        result["certificate_sha256"] = sha256_bytes(cert_bytes)
    else:
        try:
            generated = client.cloud("generatecertificate", {"docId": document_id})
            cert_url = generated.get("CertificateUrl") if isinstance(generated, dict) else None
            if cert_url:
                cert_bytes = client.download_bytes(cert_url)
                cert_path = config.download_root / f"{document_id}-certificate.pdf"
                cert_path.write_bytes(cert_bytes)
                result["certificate_path"] = str(cert_path)
                result["certificate_sha256"] = sha256_bytes(cert_bytes)
        except FirmMcpError:
            result["certificate_path"] = None
    return result
