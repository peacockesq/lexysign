# LexySign parity regression suite

Checkout: branch `test/lexysign-parity-regressions` at `d4212d402325551cb9cb903038adfab76afe7b89` (origin/main). Tests bind to this customized LexySign tree, not legacy opensign-test and not upstream package.json `2.37.0` / version.txt strings.

## Invocation

From the repo root (no package.json change; parent owns runner integration):

```
node --test tests/parity/*.test.mjs
```

Node 22 built-in test runner. No npm install, no Docker, no network, no public login.

Retained TAP: `tests/parity/LAST_RUN.txt`

Baseline of this commit: 35 tests, 32 pass, 3 fail (intentional RED), ~7s.

## What is behavioral vs static

Behavioral (executes real exported functions with stubs, no live DB/browser):

- `Utils.convertBase64ToImg` scale/center/no-upscale on the synthetic Alpha box (271x50) with an 800x200 draw canvas
- `Utils.onSaveSign` keeps widget Width/Height when storing draw ink
- `Utils.defaultWidthHeight` and `Utils.handleImageResize`
- `widgetUtils.createCustomPositionWidget` / `hasSignatureWidget`
- `declinedocument` missing docId, OTP session guard, successful decline without OTP
- `DocumentBeforesave` DocSentAt + e-sign usage on first SignedUrl
- `stripeClient.subscriptionIsActive` / `getMonthlyESignLimit` (default 1000)
- `entitlements.assertCanUseESignUnits` inactive + over-limit
- `supabaseAuth.persistSupabaseSession` / `signInWithPassword` (fetch stubbed to example.test)
- `docxtopdf` multer .docx filter, missing-file 400, `withTimeout`
- `loginWithSupabase` missing access token (no network)
- `billingBaseUrl()` from Billing.jsx

Static / source-bound contract checks (not claimed as runtime UI):

- PlaceHolderSign `saveDocumentDetails` PUT sets `SentToOthers: true` and `SignedUrl` before mail
- CustomizeMail Send vs close-without-send
- PdfRequestFiles `declineDoc` posts `functions/declinedoc`
- cloud `main.js` `loginWithSupabase` + `declinedoc`
- customApp `/docxtopdf` + `/billing`
- App.jsx `/billing`, Login.jsx supabase path, Form.jsx `/docxtopdf`
- LexySign DocumentId header / PDF eSignName
- PlaceholderCopy page-edge clamp (`targetPageWidth - widgetWidth - 10`)

## RED defects (do not flip expectations to green)

1. Signature ink occupancy — `tests/parity/signature-ink-fit.test.mjs`
   `Utils.convertBase64ToImg` (`apps/OpenSign/src/constant/Utils.js` ~1585-1619) scales the full draw canvas with `Math.min(maxWidth/imgW, maxHeight/imgH, 1)` and does not trim whitespace. Sparse 80x20 ink on an 800x200 pad occupies 7.4% of the synthetic Alpha 271x50 box. Reproduced against current LexySign source, not inferred from the legacy TEST baseline.

2. Sender interrupted-send lockout — `tests/parity/send-state-recovery.test.mjs`
   `PlaceHolderSign.jsx` `saveDocumentDetails` (~1081-1124) commits `SignedUrl` + `SentToOthers: true` then opens CustomizeMail. Close without Send navigates away (`CustomizeMail.jsx` ~25-32). Reopen classifies any `SignedUrl` as already dispatched (`PlaceHolderSign.jsx` ~271-309, `document-signed-alert-8`). `DocumentBeforesave.js` also stamps `DocSentAt` on first SignedUrl. First invitation is `sendEmailToSigners` / `sendmailv3`, which is not part of Next.

3. Decline of a completed envelope — `tests/parity/cancellation-decline.test.mjs`
   `declinedocument.js` does not inspect `IsCompleted`. The RED test expects a rejection; current code still sets `IsDeclined`. Source-supported race/invariant gap, not a live concurrent bypass.

## Current-code findings that pass (not claimed from opensign-test)

- Decline without OTP does not require `request.user`; OTP decline without session throws 209.
- After decline, signer view state still has `pdfUrl` (`PdfRequestFiles.jsx` sets URL before the declined branch). Viewing is not revoked; signing is gated.
- Custom contracts still present: supabase login, `/billing`, 1000 e-sign units, DOCX `/docxtopdf`, LexySign DocumentId branding.

## Not reproducible here / parent follow-up

Needs native browser (do not launch public logins or sign/send real mail):

- Chromium PlaceHolderSign: Next, close CustomizeMail without Send, reopen, confirm `document-signed-alert-8` and whether report resend/`sendmailv3` recovers the first invitation.
- Draw real pointer ink into the Alpha box on `fixtures/synthetic-signing-packet.pdf` and raster page 3 occupancy.
- Signer decline UI (`PdfDeclineModal`) and whether the old link still renders the PDF after `IsDeclined`.

Needs DB / Parse server (out of scope on this host):

- Concurrent decline vs last-signer `signPdf` / `updateDoc` completion.
- Live Stripe checkout, LibreOffice DOCX conversion, Supabase token exchange.

Synthetic field coordinates used: `tests/parity/fixtures/synthetic-field-layout.json` (Alpha/Beta boxes from the allowed trial manifest). Fixture PDF SHA-256 `31737a1808bd7cdc7e6cca5bdf6f8a85897da6ce7fe585c9dad7150d4ff475ca` was verified read-only; the PDF itself is not copied into this tree.

## Parent integration

Do not edit product, lock, deploy, or `.github` files from this worker. Optional later:

```
"test:parity": "node --test tests/parity/*.test.mjs"
```

Not pushed. Use `git rev-parse HEAD` on `test/lexysign-parity-regressions` for the local SHA.
