# LexySign V1: firm use through MCP

## Product identity

LexySign is one product and one codebase. The repository was renamed from `peacockesq/peacock-sign` to `peacockesq/lexysign`; history, issues and existing pull requests are retained. Peacock Law is a customer account, not a separate software fork. OpenSign remains the upstream project, with applicable license and attribution preserved.

## V1 acceptance

- Finish the reviewed invitation-expiry and clean-source-save corrections.
- Clear independent release-helper review before using the deployment path.
- Provide an authenticated firm-scoped MCP adapter for PDF draft preparation, explicit signer/field placement, send preview and separately approved sending, status, signed-PDF and audit/certificate retrieval.
- Bind the adapter to an ordinary configured account and tenant; no master-key or general administrator API exposure.
- Keep document preparation distinct from outbound delivery. Approval must bind the exact document and recipients, and changes invalidate it. Never sign for a client automatically.
- Reject foreign-owner/tenant requests, terminal/expired document mutations, unsafe local paths/remote downloads, malformed PDF coordinates, and stale/replayed approval. Unknown mail outcomes require reconciliation rather than blind resend.
- Exercise official MCP transport and real generated PDFs. Finish native staging/browser/signing/download tests with fictional fixtures and contained mail before declaring firm readiness.
- Retain the existing Supabase-to-Parse bridge, billing guards, original document fidelity, signature policies and auditable output.

## V2 — deferred, not a V1 release gate

Offer firms white-label document branding as subscription functionality. Store branding as tenant configuration, not customer-specific branches or duplicated repositories. Exact packaging, entitlements and broader custom-domain/email branding remain future product decisions. V1 does not require a white-label UI or new subscription plans.

## Release work

- Upgrade integration: #13.
- Product corrections and follow-up regressions: #14.
- Release-helper corrections: #15.
- Firm MCP: a separate reviewed additive change, integrated into the same release.

Open draft pull requests and passing unit tests alone do not establish deployment or real-client readiness. Preserve existing production data, secrets, shared routing and rollback handles. Test invitations remain contained; real client sending requires document-specific approval.
