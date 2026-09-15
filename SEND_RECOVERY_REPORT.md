# Send-state recovery — first invitation after Next/close

Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/send-recovery`
Branch: `fix/lexysign-first-invitation-recovery`
Base: `36d8771eeb828edb7ee267e1c3e912cb7782fd0d`
Ending SHA: `89a7a5623b547832380a3aa1708cc5494fea41ab`
No remote, SSH, push, deploy, or real email.

## What changed

Next (`saveDocumentDetails`) now writes a draft only: Name, Placeholders, Signers, SignatureType, and the prepared file URL. It does not set `SignedUrl`, `SentToOthers`, `ExpiryDate`, or `DocSentAt`, and it does not charge eSign usage.

Invitation freeze happens on explicit activation:

- CustomizeMail Send awaits optional `beforeSend` (PlaceHolderSign only) then `finalizeInvitation`
- Copy-link Share uses the same finalize path before a usable URL is copied or shown
- Owner-first sequential self-sign still skips owner mail; Sign Now finalizes before navigate

`DocumentBeforesave` is unchanged. Usage and `DocSentAt` still fire when `SignedUrl` first appears, which is now the activation PUT.

Reopen lock still keys off `SignedUrl`. Historical records that omit `SentToOthers` stay locked. Completed / declined / expired stay locked. This is not “remove the SignedUrl guard.”

## Tests

Command: `node --test tests/parity/*.test.mjs`

| | tests | pass | fail |
|---|---|---|---|
| Proven baseline at 36d8771ee | 42 | 40 | 2 |
| This lane | 55 | 54 | 1 |

The remaining failure is the unrelated ink-fit RED (`signature-ink-fit.test.mjs`). Cancellation/decline tests were not changed.

Characterization tests that expected `SentToOthers` on Next were rewritten because dispatch moved to `finalizeInvitation`, not because terminal no-edit assertions were weakened. True sent / completed / declined / expired still assert lock.

Covered here:

- Next: no send, no billing, in-memory URL updated
- Close without Send, reopen: geometry + URL retained, not locked
- Finalize failure: zero `sendEmailToSigners`, no sent-success UI, loader cleared
- Explicit Send: finalize PUT then email; provider error keeps flags and lock
- Repeat Send click suppressed
- Share and owner-first self-sign activate then lock
- Stale second tab: persisted `SignedUrl` refuses a second finalize and sends no mail

## Native / browser limitations

These tests extract source blocks and load `DocumentBeforesave` against a Parse stub. They are not:

- a React UI run
- live Parse/Mongo
- a real mail provider
- a browser Next → close → reopen → Send pass

Parent still needs browser + native Parse before release. Node 22 may warn that `draftDocumentPreparation.js` is typeless ESM; OpenSign `package.json` was not changed.

## Not solved (phase 2)

This patch does not give exactly-once mail.

- Crash after finalize PUT and before `sendEmailToSigners`: document is locked (`SignedUrl` set), invitations may never leave, and this client does not reset flags or retry.
- Two tabs that both read a draft before either writes can both pass the guard. Parse PUT is not conditional. Fail-closed only once `SignedUrl` is already persisted.
- No outbox, idempotency key, or durable per-recipient delivery intent.
- No bulk backfill of historical `SignedUrl` drafts.

Do not treat this as a delivery-retry or concurrent-tab design.

## Review-product follow-up (same worktree, later commit)

Same-tab Share-then-Send and same-tab failed-before-mail retry now use an in-memory activation receipt. Reload / other tabs still have no receipt and stay already-dispatched. Concurrent tabs and outbox exactly-once are still not claimed. Prefill Next no longer replaces `URL`; prepared output is `PreparedUrl`. See `REVIEW_PRODUCT_FIX_REPORT.md`.
