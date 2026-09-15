LexySign firm MCP V1

Local stdio adapter so Hermes/Cain can list, draft, prepare, send (with owner approval), status-check, and download firm-owned LexySign documents. One product: LexySign. Peacock Law is a customer tenant. White-label is deferred to v2.

This is not a public API, not an OpenAPI client, and not a sign-for-client tool. It talks to existing native Parse endpoints plus one new cloud function that still needs independent review before production activation.

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
3. Put a high-entropy approval HMAC secret in approval_secret_file.
4. Restrict allowed_pdf_roots and download_root.
5. Point Hermes at the server using examples/hermes-cain-mcp.sample.json. Do not commit secrets. This worker does not write live Hermes config.

Install and run

python3 -m venv scripts/mcp/.venv
scripts/mcp/.venv/bin/pip install -r scripts/mcp/requirements.txt
LEXYSIGN_MCP_CONFIG=/path/to/lexysign-mcp.json scripts/mcp/.venv/bin/python -m lexysign_firm_mcp

Stdout is MCP only. Diagnostics go to stderr. Tokens and signing URLs are not printed.

Owner approval ceremony

prepare_send writes a private manifest under state_dir/manifests.
MCP cannot approve it.

scripts/mcp/.venv/bin/python -m lexysign_firm_mcp.approve_cli \
  --config /path/to/lexysign-mcp.json \
  --manifest-id <id> \
  --i-approve-this-manifest

That command is the operator ceremony. send_invitations then needs the printed approval_id. Changed PDF/URL, recipients, title, tenant, or session, and expired manifest/approval/document, all invalidate the approval.

Send behavior

send_invitations calls native cloud function lexysignFirmSendInvitations. It does not call sendmailv3 itself. SMTP accepted is not delivered. Timeouts after dispatch are recorded as uncertain and are not retried. Duplicates fail closed. Manual send_mode activates the document without mail; capability links stay private, not in tool output.

Native change (review before activation)

New module apps/OpenSignServer/cloud/parsefunction/lexysignFirmSendInvitations.js
Registered in apps/OpenSignServer/cloud/main.js as lexysignFirmSendInvitations.
Enforces current owner, tenant, and lifecycle, then uses existing sendmailv3 / SignedUrl activation.
Does not change signing semantics or the release helper. Do not deploy until independently reviewed.

Tests

cd scripts/mcp
.venv/bin/pytest
Tests use a loopback fake Parse. They do not contact live network, mail, or clients.

Limits

- Loopback fake Parse is not production proof
- Native function is source-registered and guard-tested; not live-activated here
- No claim that existing Parse endpoints were hardened globally
- White-label deferred
