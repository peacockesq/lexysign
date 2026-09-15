LexySign firm MCP V1

Local stdio adapter so Hermes/Cain can list, draft, prepare, send (with owner approval), status-check, and download firm-owned LexySign documents. One product: LexySign. Peacock Law is a customer tenant. White-label is deferred to v2.

This is not a public API, not an OpenAPI client, and not a sign-for-client tool. It talks to existing native Parse endpoints plus two new cloud functions that still need independent review before production activation.

Tools (7)

- firm_health: session users/me plus contracts_Users/TenantId linkage for the configured principal only
- list_documents: bounded pagination of firm-owned documents; owner and tenant filters applied in the adapter
- create_draft: local PDF + explicit signer roles and page/rectangle fields
- prepare_send: immutable expiring manifest and preview (hash, recipients, order, subject, expiry)
- send_invitations: requires a separately operator-issued approval_id; cannot mint approvals
- document_status: lifecycle and audit summary
- download_signed: completed signed PDF and certificate written under download_root with sha256

Tag/prefill parsing is unsupported. Pass explicit coordinates. Source PDF bytes are uploaded as-is (no flatten).

Not provided

- sign-for-client
- arbitrary Parse class/URL/admin passthrough
- caller-selected owner, tenant, pointers, or base URL
- MCP-minted approvals or approve=true
- branding/subscription features

Auth and config

Ordinary Parse session token (never master key) from session_token_file. Trusted fixed parse_base_url, parse_app_id, tenant_id, principal_user_id, principal_extuser_id. The adapter verifies users/me then contracts_Users TenantId. Invalid, missing, or foreign sessions are refused. Other-tenant and signer-only documents are refused even if upstream ACL is lax. getDocument.js is not used as authorization.

Enrollment (Cain, not this worker)

1. Create a private config JSON outside git (see examples/config.sample.json).
2. Put the Parse session token in a 0600 file referenced by session_token_file.
3. Put a high-entropy local operator HMAC secret in approval_secret_file (MCP ceremony only).
4. Put a separate high-entropy native approval secret in LEXYSIGN_FIRM_APPROVAL_SECRET_FILE. Do not put this secret in ordinary MCP config. Parent enrolls LEXYSIGN_FIRM_APPROVAL_SECRET on the Parse host after review.
5. Restrict allowed_pdf_roots and download_root. object_storage_origins is empty unless an https object-storage origin is explicitly trusted.
6. Point Hermes at the server using examples/hermes-cain-mcp.sample.json. Do not commit secrets. This worker does not write live Hermes config.

A local filesystem HMAC is a trusted-operator ceremony. It is not protection against a same-user administrator who can read the secret. Existing legacy Parse APIs are not globally approval-gated.

Install and run (from repository root)

python3 -m venv scripts/mcp/.venv
scripts/mcp/.venv/bin/pip install -r scripts/mcp/requirements.lock
LEXYSIGN_MCP_CONFIG=/path/to/lexysign-mcp.json scripts/mcp/.venv/bin/lexysign-firm-mcp

requirements.lock pins third-party dependencies, setuptools/wheel, and the local package at ./scripts/mcp. Run those commands from the repository root. Do not install an editable Git URL.

Stdout is MCP only. Diagnostics go to stderr. Tokens and signing URLs are not printed.

Owner approval ceremony

prepare_send writes a private manifest under state_dir/manifests.
MCP cannot approve it.

LEXYSIGN_FIRM_APPROVAL_SECRET_FILE=/path/to/native-approval-secret \
scripts/mcp/.venv/bin/lexysign-mcp-approve \
  --config /path/to/lexysign-mcp.json \
  --manifest-id <id> \
  --i-approve-this-manifest

That command is the operator ceremony. send_invitations then needs the printed approval_id. The native send endpoint verifies the same HMAC with LEXYSIGN_FIRM_APPROVAL_SECRET and consumes it with the durable reservation. No MCP tool can mint approval.

Changed PDF bytes, URL, contact IDs, roles, fields, order, expiry, completion-days, subject, tenant, or session, and expired manifest/approval/document, all invalidate the approval.

Send behavior

send_invitations calls native cloud function lexysignFirmSendInvitations. It does not call sendmailv3 itself. SMTP accepted is not delivered. Provider timeouts/resets swallowed by sendMailv3 are uncertain and are not retried. This is not exactly-once SMTP. Duplicates fail closed at document/send-generation scope. Manual send_mode activates the document without mail; capability links are written under state_dir/manual_links and only a private handle is returned.

Protected files

Approval and send require the actual current PDF bytes. There is no URL-hash fallback. lexysignFirmAcquireFile renews a short-lived capability for the current owned document's source, signed, or certificate URL only. Raw GET /files without a file JWT remains unauthorized. Binary downloads use a credential-free client.

Native change (review before activation)

New modules:
- apps/OpenSignServer/cloud/parsefunction/lexysignFirmSendInvitations.js
- apps/OpenSignServer/cloud/parsefunction/lexysignFirmAcquireFile.js
Registered in apps/OpenSignServer/cloud/main.js.
Provisioning gates: docs/lexysign-firm-mcp-provisioning.md
Do not deploy until independently reviewed. Do not run the reservation index helper against live Mongo from this worker.

Tests

cd scripts/mcp
.venv/bin/pytest
From apps/OpenSignServer: node --test spec/lexysignFirmMcp.test.js spec/lexysignFirmSend.native.test.js
Tests use a loopback fake Parse and an offline native VM. They do not contact live network, mail, or clients.

Limits

- Loopback fake Parse is not production proof
- Native VM exercises actual function control flow with synthetic DB/SMTP boundaries
- Unique reservation requires the provisioned Mongo index; that is a residual gate
- No claim that existing Parse endpoints were hardened globally
- White-label deferred
