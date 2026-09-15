# LexySign parity regression suite

Branch: test/lexysign-parity-regressions
Initial harness: a075e3e789fe516e8b693082579e6d45f8bf40b6
Corrected harness: 06cbaf74f30365a596460c4d17fbb783ef4b7bc9
Isolated source merge (not for parent cherry-pick): 83769037abd28b44838f7e16d9602a28a3d07732
  parents: 06cbaf74f + aa40aba673441eef68236f43153742c9cd2cd174

Tests-only commit SHA is the commit after this merge that contains only tests/parity and this report.

## Invocation

    node --test tests/parity/*.test.mjs

No package.json change, no npm install, no Docker, no network, no public login.
Do not track TAP in git.

v2.41.3-adapted baseline: 42 tests, 40 pass, 2 fail (RED gates). About 4s.

## Extracted / stubbed versus native

Loader rewrites ESM including multiline imports. Missing import specifiers throw. No {} fallback.

declinedocument now imports ./sendSystemMail.js. Tests stub that default export and assert sendSystemMail({ params }) recipient/from/extUserId/subject/html. Query.notEqualTo('IsCompleted', true) is honored by the Parse stub, matching upgraded Query.get behavior.

handleImageResize was removed upstream. Replacement is Utils.handleWidgetResize (Placeholder.jsx onResizeStop). Same unscaled page-space invariant; scale argument folded into containerScale.

PlaceHolderSign save/close/reopen still extracted from source. Reopened documents are original draft + full save PUT payload + DocumentBeforesave stamps (DocSentAt). SentToOthers is never omitted.

Native still not claimed: React UI, Parse/Mongo, Stripe, LibreOffice, live Supabase, pointer-drawn PDF raster.
Browser follow-up: tests/parity/browser/interrupted-send.parent.md

## RED business gates (do not flip)

1. Ink fit — convertBase64ToImg sparse 80x20 on 800x200 pad fills 10% of 50pt widget height. Gate: >= 50%.
2. Interrupted send — persisted SignedUrl+SentToOthers+DocSentAt after Next, close without Send, reopen locks document-signed-alert-8. Gate: first invitation must remain recoverable.

Completed-envelope decline is no longer RED on v2.41.3: notEqualTo(IsCompleted) makes Query.get throw OBJECT_NOT_FOUND; owner mail is not sent.

## Passing invariants added for send-state design

- True sent / completed / declined / expired reopen is not editable.
- Send failure does not roll back the PUT; persisted sent flags still forbid editing.
- Stopped-before-modal already has dispatch flags persisted (current Next behavior).

## Parent integration

Cherry-pick the tests-only commit, not the aa40aba source merge.
Optional: "test:parity": "node --test tests/parity/*.test.mjs"
Not pushed.
