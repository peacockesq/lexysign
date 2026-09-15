# LexySign parity regression suite

Checkout: branch test/lexysign-parity-regressions. Initial harness commit a075e3e789fe516e8b693082579e6d45f8bf40b6 is preserved. This file describes the corrected suite after parent review.

## Invocation

From the repo root (no package.json change):

    node --test tests/parity/*.test.mjs

Node 22 built-in test runner. No npm install, no Docker, no network, no public login.
Do not track TAP in git (whitespace noise). Redirect locally if needed:

    node --test tests/parity/*.test.mjs > /tmp/lexysign-parity.tap

Corrected baseline: 40 tests, 37 pass, 3 fail (RED business gates). About 3s.

## Extracted / stubbed versus native limits

Loader (tests/parity/helpers/load-source-module.mjs): strips ESM imports and runs the file in vm. Every import specifier must be listed in stubs or load throws (no silent {}). Used for OpenSignServer cloud functions, billing, supabaseAuth, Utils.js, widgetUtils, docxtopdf.

Not a second module ecosystem. JSX pages are not vm-loaded. PlaceHolderSign / CustomizeMail paths execute the exact source text of saveDocumentDetails, handleCloseSendmailModal, and the SignedUrl reopen block with captured closure mocks (axios, setState, Date). That is not a handwritten copy of the algorithm.

Native limits (not claimed):
- Full React PlaceHolderSign / PdfRequestFiles UI
- Parse/Mongo, Stripe, LibreOffice, live Supabase
- Real pointer-drawn ink on a PDF raster

Parent browser steps: tests/parity/browser/interrupted-send.parent.md

## Behavioral versus static

Behavioral:
- Utils.convertBase64ToImg with a pixel canvas and registered source rasters (drawImage copies ink pixels)
- Utils.onSaveSign, defaultWidthHeight, handleImageResize
- widgetUtils.createCustomPositionWidget / hasSignatureWidget
- Extracted saveDocumentDetails PUT, CustomizeMail close, reopen lock block
- declinedocument with a full ExtUserPtr/signer shape; owner mail side effect
- DocumentBeforesave DocSentAt + usage
- billing entitlements, supabase session/password grant, docxtopdf filter/timeout, loginWithSupabase missing token

Static (labeled, not claimed as UI runtime):
- Source order of SentToOthers vs sendmailv3
- PdfRequestFiles setPdfUrl before declined branch; declinedoc POST fields
- cloud main / customApp / App.jsx / Login.jsx / Form.jsx / DocumentId branding
- PlaceholderCopy clamp formula

Harness validation (tests/parity/harness-sensitivity.test.mjs, not a product fix):
- Missing stub throws
- Wiping convertBase64ToImg draw path fails the draw assertion
- In-memory trim-and-fill of convertBase64ToImg makes occupancy height-fill >= 50%
- In-memory reopen that does not lock SignedUrl-only makes the send-state RED pass

## RED business gates (do not flip to green)

1. Ink fit policy — signature-ink-fit.test.mjs
   convertBase64ToImg output pixels for an 80x20 ink on an 800x200 pad fill 10% of the 50pt Alpha widget height. Gate: height fill >= 50% after trim/fit. No-upscale/aspect on filled sources are separate passing invariants.

2. Interrupted send — send-state-recovery.test.mjs
   Extracted Next PUT sets SignedUrl + SentToOthers, extracted mail close navigates without send, extracted reopen sets document-signed-alert-8. Gate: that lock must not happen.

3. Completed-envelope decline — cancellation-decline.test.mjs
   declinedocument still sets IsDeclined on IsCompleted=true. Gate: must reject. Fixtures now include ExtUserPtr.Name and signerPtr so sendDeclineMail does not TypeError.

## Parent integration

Optional later: "test:parity": "node --test tests/parity/*.test.mjs"

Not pushed. Initial commit a075e3e789fe516e8b693082579e6d45f8bf40b6 plus one corrective commit on this branch.
