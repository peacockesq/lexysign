from __future__ import annotations

from .config import FirmConfig
from .errors import FirmMcpError
from .parse_client import ParseClient, _pointer_id
from .placeholders import pointer


def verify_identity(client: ParseClient, config: FirmConfig) -> dict:
    if not config.session_token:
        raise FirmMcpError("missing_session", "session token is missing")
    me = client.users_me()
    user_id = str(me.get("objectId") or "")
    if user_id != config.principal_user_id:
        raise FirmMcpError("foreign_principal", "session user is not the configured principal")
    users = client.query_class(
        "contracts_Users",
        {
            "UserId": pointer("_User", user_id),
            "objectId": config.principal_extuser_id,
        },
        include="TenantId,UserId",
        limit="1",
    )
    if not users:
        raise FirmMcpError("foreign_principal", "contracts_Users linkage was not found")
    ext = users[0]
    tenant_id = _pointer_id(ext.get("TenantId"))
    if tenant_id != config.tenant_id:
        raise FirmMcpError("other_tenant", "session tenant does not match configured tenant")
    return {
        "user_id": user_id,
        "email": me.get("email") or ext.get("Email") or "",
        "extuser_id": ext.get("objectId"),
        "tenant_id": tenant_id,
        "name": ext.get("Name") or "",
    }


def assert_owned_document(document: dict | None, config: FirmConfig) -> dict:
    if not document:
        raise FirmMcpError("foreign_document", "document was not found for this principal")
    created = _pointer_id(document.get("CreatedBy"))
    ext = _pointer_id(document.get("ExtUserPtr"))
    tenant = _pointer_id((document.get("ExtUserPtr") or {}).get("TenantId") if isinstance(document.get("ExtUserPtr"), dict) else None)
    if created != config.principal_user_id or ext != config.principal_extuser_id:
        raise FirmMcpError("foreign_document", "document is not firm-owned by the configured principal")
    if tenant and tenant != config.tenant_id:
        raise FirmMcpError("other_tenant", "document belongs to another tenant")
    signers = document.get("Signers") or []
    signer_ids = {_pointer_id(item) for item in signers}
    if created != config.principal_user_id and config.principal_extuser_id in signer_ids:
        raise FirmMcpError("signer_only_denied", "signer-only document access is not allowed")
    return document
