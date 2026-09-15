# Signature ink-fit report

Branch: fix/lexysign-signature-ink-fit
Parent: 36d8771eeb828edb7ee267e1c3e912cb7782fd0d
Scope: Utils.convertBase64ToImg + signature-vs-stamp callsite, parity ink tests, Chromium synthetic proof.
Not production-ready. No remote push. Send-state RED gate was not edited.

## Pre-fix characterization (obsolete 10% baseline)

Parent rerun `node --test tests/parity/*.test.mjs` on this worktree before the change:

- 42 tests, 40 pass, 2 fail
- Ink-fit RED: sparse 80x20 ink on an 800x200 pad, fitted into the 271x50 signature widget, occupied 10.0% of widget height (5px). Product scaled the full bitmap including empty pad (`Math.min(w/imgW, h/imgH, 1)`).
- Other fail (untouched): send-state reopen lock (`document-signed-alert-8`).

Same sparse source into 150x50 under the old full-image scale, measured later in Chromium: 4px CSS ink height (8% of 50pt). Width-limited: scale = min(150/800, 50/200, 1) = 0.1875; 20 * 0.1875 = 3.75px.

## Policy after the fix

Drawn `signature`, `initials`, and `draw` widgets:

1. Load handlers are set before `img.src`. Load timeout 8s.
2. Reject invalid widget dims, empty src, load failure, source dim > 4096, widget CSS > 2048, canvas px > 8192, blank/no-ink.
3. Scan pixels on a measure canvas. Alpha 0 does not count (leftover RGB ignored). Conservative near-white (min channel >= 250 and chroma <= 8) is treated as upload background. Dark, colored, and antialiased ink are kept. Light yellow (255,255,40) is kept.
4. Crop to ink bbox plus 2px safety pad, clamped to the bitmap.
5. Conditional scale, aspect preserved, no distortion:
   - If cropped area / source area < 0.5 (massive empty pad), scale cropped ink to fit the widget (upscale allowed).
   - Otherwise keep historical no-upscale (`scale <= 1`) so a filled source smaller than the widget stays native.
6. Center in the original widget rectangle. Widget Width/Height/position are not rewritten. Output is PNG at `(devicePixelRatio || 1) * 2`.

`stamp`, `image`, unknown, and omitted types keep full-bitmap no-upscale. The PDF embed callsite now passes `widget.type`.

A separate `src/utils` module was not added: `Utils.js` already imports the `../utils` barrel, which the parity loader stubs. A new import would not execute under `loadUtilsModule` without editing that loader (out of scope).

## Node parity after the fix

    node --test tests/parity/*.test.mjs

- 49 tests, 48 pass, 1 fail
- Ink occupancy gate now passes (>= 50% of 50pt). Characterization asserts the intended occupancy, not the old 10%.
- Remaining fail is the send-state invitation-recovery RED (PlaceHolderSign). Not this change.

New coverage: 150x50 >= 25px ink height, stamp/omitted no-trim, leftover transparent RGB, white-bg + yellow ink, edge stroke, blank/white-only/missing src/invalid dims/oversized source.

## Chromium synthetic proof

Python playwright is not installed (`python3 -m playwright` missing). Did not install browsers or run the client build.

Used already-installed `/usr/bin/chromium` (Chromium 152.0.7977.82, HeadlessChrome/152.0.0.0), dpr=1, pxRatio=2.

Synthetic source only: 800x200 transparent canvas, black 80x20 rect at (360,90). Exact product `convertBase64ToImg` extracted from Utils.js.

| case | CSS ink height | height fill of 50pt | notes |
| --- | --- | --- | --- |
| before, 150x50 (old full-image scale) | 4px | 8% | pre-fix analog |
| after, signature 150x50 | 37px | 74% | >= 25px; width-limited by 84x24 padded crop into 150x50 |
| after, signature 271x50 | 43.5px | 87% | >= 50% policy |
| stamp 150x50 | 4px | 8% | stamp semantics preserved |

150x50 is width-limited after the 2px pad (crop 84x24, aspect 3.5 vs widget 3.0), so height does not slam to 50px. No axis stretching.

Evidence:

- tests/parity/browser/ink-fit-before.png (PNG 300x100)
- tests/parity/browser/ink-fit-after.png (PNG 300x100)
- tests/parity/browser/ink-fit-proof.json
- tests/parity/browser/run-ink-fit-proof.mjs
- tests/parity/browser/ink-fit-proof.html (generated page used for dump-dom)

## Limitations

- Not production-ready. No full-app PDF native staging (parent-owned).
- Node rasters are stubbed; Chromium proof is synthetic rectangles, not a live sign-pad stroke or uploaded photo.
- Very pale gray ink with all channels >= 250 and low chroma can be treated as background.
- Sources larger than 4096px on a side are rejected rather than downsampled.
- Omitted widgetType does not trim (stamp-safe default). Callers that need signature fitting must pass type; the embed path does.
- Send-state RED remains.
