LexySign firm MCP V1 native provisioning gates

This document is the residual activation gate. The MCP worker does not enroll
secrets, talk to live Mongo/Parse, send mail, or deploy.

Required before production activation of lexysignFirmSendInvitations

1. LEXYSIGN_FIRM_APPROVAL_SECRET
   High-entropy server secret used to verify the operator approval HMAC on the
   new native send endpoint only. Fail closed if unset. Parent enrolls after
   review. The MCP stdio process must not be given this secret; the operator
   approval CLI reads LEXYSIGN_FIRM_APPROVAL_SECRET_FILE separately.
   A local filesystem HMAC is a trusted-operator ceremony, not protection
   against a same-user administrator who can read the secret.

2. Unique indexes on class lexysign_FirmSendReservation
   See apps/OpenSignServer/migrationdb/createFirmSendReservationIndex.js.
   documentId unique, approvalId unique sparse. Query-then-save is not an
   atomic substitute. In-process locks are not cross-process proof.
   The native function fails closed with reservation_unprovisioned if the
   class/index cannot be written.

3. Protected files
   Existing GET /files middleware plus file JWT (getSignedUrl/presignedlocalUrl)
   remain in force. The adapter must call lexysignFirmAcquireFile, which
   derives source/signed/certificate URLs from the current owned document
   only. Do not allowlist arbitrary getsignedurl URLs. Object storage is
   allowed only when DO_BASEURL is an https origin matching the stored URL.

4. Billing
   Existing DocumentBeforesave recordESignUsage still consumes signer units
   on first SignedUrl transition. The firm send path checks entitlement for
   that signer count before activation and passes firmQuotaAlreadyReserved
   so sendMailv3 does not demand an extra unit after that consumption.
   Canceled subscription and insufficient quota remain denials.
   sendMailv3 {status:'error'} after a possible provider call is uncertain,
   not a safe retry. This is not exactly-once SMTP.

5. Scope honesty
   Existing legacy Parse APIs are NOT globally approval-gated. A same-user
   session that can call those APIs retains residual send capability outside
   this new endpoint. Do not market the MCP approval ceremony as a global
   repair of pre-existing Parse routes.

6. Not proven here
   Live Mongo uniqueness under concurrent Parse workers, real SMTP, real
   JWT/P12 signing, and production installation. Staging after parent review
   still needs two ordinary accounts/tenants, protected URL refresh, quota
   edge, partial provider timeout, and the external approval ceremony.
