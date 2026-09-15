# Review-product fix report — F1 and F2

Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/review-product`
Branch: `fix/lexysign-review-product`
Base: `80ba54c6ba747789081c767f0798dca18d62c3a7`
Independent review evidence (read-only, unchanged): `/home/trixie/lexysign-independent-80ba54-d2okJJ/REVIEW.md`
No SSH, push, deploy, production data, or external mail.

## F1 — same-draft activation receipt

Copy-link and Send in the same Next modal both called `finalizeInvitation`. The first write set `SignedUrl`; the second hit `already-dispatched` before any mail.

Fix: after a successful activation PUT in this tab, bind an in-memory receipt `{documentId, signedUrl}`. `evaluateFinalizeGuard` accepts a matching receipt as already-activated (skip PUT). Historical/unknown `SignedUrl` without this tab's receipt still fails closed. Share and Sign-Now no longer swallow `already-dispatched`.

CustomizeMail is unchanged: legacy callers without `beforeSend` still send; `sendingRef` still drops duplicate clicks; session check still runs on every finalize; billing still fires only on the first `SignedUrl` write.

### What is idempotent

- First explicit Send / Share / owner-first self-sign in a tab writes `SignedUrl` once.
- Later Send / Share / self-sign in that same tab with a matching receipt does not PUT again (Share-then-Send mails; failed-before-mail retry can mail).
- Repeat Send while in-flight is suppressed.
- Next / close remain a draft (no `SignedUrl`, no billing).

### What is not idempotent / not claimed

- Concurrent tabs that both read a draft before either writes can both PUT.
- Reload or another tab has no receipt: persisted `SignedUrl` is `already-dispatched`, no mail.
- No outbox, no per-recipient delivery key, not exactly-once mail.
- Completed / declined still reject even with a receipt.

## F2 — clean URL vs PreparedUrl

Next embedded prefill and wrote that PDF as `URL`. Reopen loaded that baked PDF, so later edits stacked on burned-in text.

No existing `PreparedUrl` / original-URL field was found. Draft Next now writes `PreparedUrl` only and leaves `URL` as the clean editable source. Reopen/preview/edit load `editableSourceUrl` (`URL`), never `PreparedUrl`. Finalize `SignedUrl` is `PreparedUrl || URL` (legacy drafts without `PreparedUrl` still activate from `URL`). Autosave may still update `URL` when the user replaces/rotates the source PDF (`isUploadPdf`). Historical sent `SignedUrl` values are not reset or migrated.

PdfRequestFiles still shows `SignedUrl` after send (prepared output) and `URL` otherwise. Signer view is unchanged.

## Tests

Command: `node --test tests/parity/*.test.mjs`

| | tests | pass | fail |
|---|---|---|---|
| Candidate 80ba54c6b | 62 | 62 | 0 |
| This lane | 69 | 69 | 0 |

All 62 existing tests remain. Characterizations that expected Next to replace `URL` now expect `PreparedUrl` plus unchanged `URL`. New regressions: same-tab Share-then-Send (1 activation PUT, 1 mail); same-tab failed-before-mail retry; historical Share without receipt copies nothing; real pdf-lib 1.17.1 embed from clean source after change/move/remove (pdftotext: corrected value only; removed text absent).

pdf-lib / fontkit are resolved from `apps/OpenSign/node_modules`, `apps/OpenSignServer/node_modules`, `LEXYSIGN_REVIEW_DEPS`, or the local independent-review deps directory. Not a global install. Parity CI now `npm ci` from the OpenSign lockfile and installs `poppler-utils` so `pdftotext` runs. Local run used the independent-review `pdf-lib` 1.17.1 read-only and system NotoMono; production Times CDN path is stubbed as in the review probe.

## Limitations

Not a React UI run, live Parse/Mongo, real mail provider, or browser Next → Copy-link → Send pass. Not concurrent-tab / outbox exactly-once. Prefill probe is source-extracted preparation + full Utils + real pdf-lib, synthetic upload. Drafts created on 80ba54 that already baked prefill into `URL` are not migrated.

F3–F5 (deploy helper) are out of this lane.
