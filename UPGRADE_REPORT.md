# LexySign upstream upgrade report — OpenSign v2.41.3

Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/upgrade`
Branch: `upgrade/opensign-v2.41.3`
Status at end of coding worker: local merge commit only. No push, PR, deploy, or `/opt` change.

## Starting / ending commits

- Starting HEAD (`origin/main`): `d4212d402325551cb9cb903038adfab76afe7b89`
- Upstream tag: `v2.41.3`
- Upstream tag SHA: `e5f2c5c0a9f65ec01d8a53e4bf3a390c7ade7bcd`
- Actual git merge-base(`HEAD`, `v2.41.3`) before merge: `b9a309fa36a17c1b8678d12b940de0d36c032935` (`Merge pull request #2143 from OpenSignLabs/staging`)
- Task-stated merge-base: `197c00dd79f8ceded909c2edb4560355fb0f8e07` (`Merge pull request #2142`). That commit is a first-parent ancestor of `b9a309fa`; git's merge-base with the fetched tag is `b9a309fa`. The merge used the real merge-base.
- Ending SHA: see “Staging merge and CI follow-up” below. Upstream merge commit remains `4393ae23ab67d4af15dde3c0909d4a678504f825` (parents `d4212d402325551cb9cb903038adfab76afe7b89` and `e5f2c5c0a9f65ec01d8a53e4bf3a390c7ade7bcd`).

Do not treat `apps/OpenSign/package.json` / `apps/OpenSignServer/package.json` `version: 2.37.0` as provenance. Upstream tag `v2.41.3` itself still carries that stale metadata. `apps/OpenSign/public/version.txt` was updated by upstream.

## Inventory (against merge-base `b9a309fa`)

LexySign-only commits on `origin/main`: 21 (branding/signing defaults, staged deploy, Caddy/network fixes, mobile UI, runtime Supabase injection).

Custom files added vs merge-base (preserved; not in upstream):
- Auth: `apps/OpenSign/src/auth/supabaseAuth.js`, `apps/OpenSignServer/cloud/parsefunction/loginWithSupabase.js`
- Billing: `apps/OpenSign/src/pages/Billing.jsx`, `apps/OpenSignServer/billing/*`, `apps/OpenSignServer/cloud/customRoute/billing.js`
- Docker/runtime: `apps/OpenSign/Dockerfile.lexysign`, `apps/OpenSign/docker-entrypoint.lexysign.sh`, `apps/OpenSignServer/Dockerfile.lexysign`
- Branding assets: `apps/OpenSign/public/lexysign-logo.png`, `branding/*`
- Deploy/CI/docs: `deploy/lexysign/*`, `.github/workflows/lexysign-*.yml`, `docs/lexysign-*.md`, `ops/lexysign-wig-loop.json`, `tools/opensign-placement/*`

Upstream-only adds taken in: `server.cjs`, `serve.json`, `createDocumentFromApp.js`, `sendSystemMail.js`, `ScrollPdfContext.jsx`, `CanvasGuidelines.jsx`, `acroFieldExtractor.js`, `workflowUtils.js`, four Parse migrations, `images/na_sign.png`, `createNormalizedEmailUnqiue.js`.

Overlapping paths (both sides modified; required real reconciliation, not file copy):
`deleteFileUrl.js`, `docxtopdf.js`, `main.js`, `declinedocument.js`, `generateCertificatebydocId.js`, `PDF.js`, `sendMailv3.js`, `sendMailWithAttachment.js`, `index.js`, `package.json`, `package-lock.json`, `Utils.js`, `BulkSendUi.jsx`, `EditTemplate.jsx`, `PdfHeader.jsx`, `RecipientList.jsx`, `RenderAllPdfPage.jsx`, `SignerListPlace.jsx`, `WidgetsValueModal.jsx`, `Form.jsx`, `Login.jsx`, `PdfRequestFiles.jsx`, `PlaceHolderSign.jsx`, `Preferences.jsx`, `SignyourselfPdf.jsx`, `TemplatePlaceholder.jsx`, `DocumentsReport.jsx`, `TemplatesReport.jsx`, `signature.css`.

## Conflicts and resolution

Content conflicts (7). No `-X ours/theirs` and no reset.

1. `apps/OpenSignServer/package.json`
   Keep upstream dependency/override bumps (`ws@^8.21.0`, parse-server `^8.6.84`, npm overrides) and retain LexySign `stripe@^22.1.1`.
2. `apps/OpenSignServer/package-lock.json`
   Took upstream lockfile, then `npm install --package-lock-only` so `stripe@^22.1.1` (resolved `stripe@22.6.2`) is in the lock. Not a hand-merged lockfile.
3. `apps/OpenSignServer/cloud/parsefunction/declinedocument.js`
   Upstream moved sending to `sendSystemMail.js` and dropped axios/master-key headers. Kept that structure and re-applied `brandColor` / `brandEmailLogo`.
4. `apps/OpenSignServer/cloud/parsefunction/sendMailv3.js`
   Upstream dropped unused `axios`. Kept LexySign entitlement import + `assertCanUseESignUnits` + `EMAIL_FOOTER_HTML`.
5. `apps/OpenSign/src/components/pdf/PdfHeader.jsx`
   Kept mobile a11y/layout (`width: 100%`, real `<button>`s, `aria-label="Back"`, `min-w-0`). Took upstream `isViewerSigner` / `finishLabel` guards (`isViewerSigner` is hardcoded `false` in OSS).
6. `apps/OpenSign/src/components/pdf/SignerListPlace.jsx`
   Kept `min-w-0`; took upstream RecipientList JSX wrapping.
7. `apps/OpenSign/src/pages/SignyourselfPdf.jsx`
   Kept `md:min-w-[14rem]`; took upstream `className="max-h-screen"`.

Post-merge repairs (auto-merge artifacts, not conflict markers):
- `docxtopdf.js`: both sides added `uploadedSizeBytes`; removed the duplicate `const` and kept `??`.
- `sendSystemMail.js` (new upstream mailer used by decline/PDF): replaced OpenSign™ complaint footer with `process.env.EMAIL_FOOTER_HTML || ''` so the existing mail-footer contract follows the refactor.

Logo move: git recorded `apps/OpenSignServer/logo.png -> apps/OpenSignServer/images/logo.png`. Blob hash `488b3a8fe68c16357d96f21ac220696086b8fad4` matches `origin/main` custom logo, not upstream `b7241b8a…`. `GenerateCertificate.js` reads `./images/logo.png` (line 22). No leftover `apps/OpenSignServer/logo.png`. Dockerfiles copy the whole server tree, so the new path is included. `images/na_sign.png` added from upstream.

`deploy/` and `.github/` are identical to `origin/main`. Shared Caddy routes (doc-v2, uts-api, Apiary Foundry) remain.

## Preserved custom contract evidence

- Supabase bridge: `apps/OpenSign/src/auth/supabaseAuth.js`; Login `apps/OpenSign/src/pages/Login.jsx:121-128`; server `apps/OpenSignServer/cloud/main.js:56,131`; `loginWithSupabase.js`. Runtime env: `apps/OpenSign/index.html` (`runtime-env.js`), `docker-entrypoint.lexysign.sh`.
- Billing / entitlements: `billing/entitlements.js`, `billing/stripeClient.js`, `cloud/customRoute/billing.js`; `customApp.js` `/billing`; `index.js:15,172` Stripe webhook before `express.json`; `sendMailv3.js` `assertCanUseESignUnits`; `DocumentBeforesave.js` `recordESignUsage`; client `/billing` route in `App.jsx`.
- DOCX/LibreOffice: `Dockerfile.lexysign` still installs libreoffice; `docxtopdf.js` keeps size-based timeout + LexySign support strings; single `uploadedSizeBytes` binding.
- Branding: `Utils.js:20-24` `appName`/`brandColor`/`brandEmailLogo`; PDF/certificate `eSignName = 'LexySign'` (`PDF.js:42`, `generateCertificatebydocId.js:11`); client Utils appName LexySign.
- Drawn signatures: `WidgetsValueModal.jsx:76-77, 519-523, 586-591` (`REACT_APP_FORCE_DRAWN_SIGNATURES !== "false"`).
- Mobile/a11y: `PdfHeader.jsx:197-207`; sidebar min-widths in Signyourself/PlaceHolder/PdfRequest/TemplatePlaceholder; `signature.css` `#navbar { overflow: visible }`.
- Local storage S3 guard: `deleteFileUrl.js:29-42,57-60` plus upstream `/files/` check at line 77. `index.js:195` uses `req.path?.includes('/files/')`.
- Public admin lock: `AddAdmin.js:100`.
- Signed PDF identity: LexySign name/contact on certificate and PDF signing placeholders.
- Caddy: `deploy/lexysign/Caddyfile` still has doc-v2, uts-api, Apiary Foundry blocks.

## Tests actually executed

Host: Linux aarch64 (Raspberry Pi), Node v22.23.2, npm 12.0.2. Root `npm test` is the known placeholder (`echo "Error: no test specified" && exit 1`) and was not treated as a pass.

1. `node --check` on server contract files (`index.js`, `Utils.js`, `cloud/main.js`, `customApp.js`, `billing.js`, `docxtopdf.js`, `deleteFileUrl.js`, `declinedocument.js`, `sendMailv3.js`, `sendSystemMail.js`, `loginWithSupabase.js`, `AddAdmin.js`, `DocumentBeforesave.js`, `entitlements.js`, `stripeClient.js`, `spec/lexysignContracts.test.js`): syntax ok.
2. `cd apps/OpenSignServer && node --test spec/lexysignContracts.test.js`

```
# tests 11
# suites 2
# pass 11
# fail 0
# duration_ms 4512.428047
```

Covers billing helpers (`getPeriodKey`, `subscriptionIsActive`, monthly limit 1000, Stripe secret required) and source contracts (Supabase cloud fn, billing webhook, S3 guard, certificate/logo path, DOCX size binding, email footer, AddAdmin lock).

3. `cd apps/OpenSign && node --test src/lexysignContracts.node.test.js`

```
# tests 5
# suites 1
# pass 5
# fail 0
# duration_ms 875.591695
```

4. Client node:test files originally lived under `src/**/*.node.test.js` (Vitest default discovery). They were moved to `apps/OpenSign/test-node/*.test.mjs` in the follow-up; receipts below are the original runs.

Also added Vitest files (`src/auth/supabaseAuth.test.js`, `src/constant/lexysignContracts.test.js`) for GitHub CI `apps/OpenSign` `npm test` (`vitest run`). They were not executed on this shared ARM host (no full client `npm install`). CI now runs them; treat local Vitest as pending until that GitHub job.

Not run locally (not called passed):
- `apps/OpenSign` Vitest (`npm test`).
- `apps/OpenSignServer` jasmine/`mongodb-runner` integration (`npm test` starts Mongo).
- Vite production build (`NODE_OPTIONS=--max-old-space-size=8192`).
- Docker image builds / compose / browser smoke.

`git diff --check`: clean.

## Staging merge and CI follow-up

Merge-base of production-main/tag work remains `b9a309fa36a17c1b8678d12b940de0d36c032935`.
Merge-base with `origin/staging` before the staging merge: `637cd865c4e30671e86e9da12538540dad424be4`.

`origin/staging` `22ea252f555df04e299e423b63653d97ffb48341` was merged into this branch as `c38469ea493392f45daeb8d3eb9b0fc5667d3980` (parents `aa40aba673441eef68236f43153742c9cd2cd174` and `22ea252f555df04e299e423b63653d97ffb48341`). After that merge, `origin/staging`, `origin/main`, and tag `v2.41.3` are all ancestors.

Staging unique files vs that merge-base were only:
- `.github/workflows/lexysign-deploy.yml` — quote-style path globs; production-only Caddy copy/reload; connect `$NETWORK_NAME` plus `${UTS_INGESTION_NETWORK:-infra_default}`. Older than production-main: no deploy timeouts, no edge compose profile, still baked `VITE_SUPABASE_*` build-args, skipped staging Caddy reload entirely.
- `deploy/lexysign/Caddyfile` — added `uts-api.peacockesq.com`. Production-main already has that route plus doc-v2 and Apiary Foundry.

Conflicts (2). Targeted keep-main, not blanket `--ours`:
- Kept production-main `.github/workflows/lexysign-deploy.yml` (runtime-env, 35m timeout, sequential image pulls with timeout, `COMPOSE_PROFILES=edge`, extra Caddy networks including docassemble-lexy-v2). Another worker owns further deploy-workflow/release-helper fixes; this file is the main equivalent after resolution.
- Kept production-main `deploy/lexysign/Caddyfile` (uts-api + doc-v2 + Apiary). Staging uts-api is a subset.

Preserved production-main Docker runtime-env loader (`apps/OpenSign/docker-entrypoint.lexysign.sh`, `index.html` `runtime-env.js`, `Dockerfile.lexysign` ENTRYPOINT) and `deploy/lexysign/docker-compose.runtime.yml` — staging did not touch those files.

### Test runner segregation

- Node contract tests: `apps/OpenSign/test-node/*.test.mjs` (`npm run test:node`) and `apps/OpenSignServer/spec/lexysignContracts.test.js` (`npm run test:node`). Jasmine still only loads `spec/**/*[sS]pec.js`, so server node:test files are not Jasmine specs.
- Vitest: `apps/OpenSign/src/**/*.{test,spec}.{js,jsx,ts,tsx}` with exclude of `**/*.node.test.js` and `test-node/**`. Remaining Vitest suites: `src/auth/supabaseAuth.test.js`, `src/constant/lexysignContracts.test.js`.
- Local re-run after the move: client `node --test test-node/*.test.mjs` 8 pass; server `node --test spec/lexysignContracts.test.js` 11 pass.
- Local Vitest: pending (no client npm install on ARM). GitHub CI job `client-tests` runs `npm ci` + `npm run test:node` + `npm test`.
- Server Jasmine/`mongodb-runner`: still pending (needs Mongo). Not added to this CI.

### CI (`.github/workflows/lexysign-ci.yml` only)

- `static-checks`: fetch-depth 0; syntax checks; secret scan fail-closed (base SHA must exist; `git diff` failure exits 1; deleted paths skipped via `--diff-filter=ACMRT` plus missing-file continue; match reports filename only, not the secret line).
- `server-node-tests`: Node 22, `npm ci --omit=dev`, `npm run test:node`.
- `client-tests`: Node 22, `npm ci`, node contract tests, Vitest.
- `docker-build`: unchanged intent, still no push.

Deploy workflow was not edited in this follow-up except the keep-main conflict resolution.

## Dependency / security notes

- Server lockfile regenerated from upstream v2.41.3 + `stripe@^22.1.1`. npm 12 reported install-scripts blocked for `@apollo/protobufjs@1.2.8`, `@firebase/util@1.15.2`, `core-js-pure@3.50.0`, `parse-server@8.6.87`. Docker/VPS installs should confirm native `sharp` and parse-server postinstall on the target arch.
- Upstream bumps of note: `parse-server` `^8.6.40` → `^8.6.84`, `parse` `^8.6.0`, `nodemailer` `^9.0.1`, `mailgun.js` `^13.0.0`, `mongodb` `^7.2.0`, `sharp` `^0.35.3`, plus npm `overrides` (tar, undici, protobufjs, lodash, body-parser, etc.).
- First full `npm install` in `apps/OpenSignServer` was killed on timeout; `node_modules/` is local/untracked. Do not treat that tree as a verified production install.
- New Parse migrations under `apps/OpenSignServer/databases/migrations/` must be applied by the parent deploy path, not this worker.

## Remaining risks (updated)

- Runtime behavior of parse-server 8.6.x, mailer majors, and workflow/`createdocumentfromapp` is untested in Docker/browser.
- `isViewerSigner` is an OSS stub (`false`).
- `sendSystemMail` does not consume e-sign units (only `sendMailv3` does).
- Certificate PDF now also requires `./images/na_sign.png` at process cwd.
- GitHub CI Vitest / docker-build / secret-scan jobs are pending until parent pushes. Local ARM did not run client `npm ci` or image builds.
- Server Jasmine still pending (Mongo).
- Parent still owns shared proxy/Caddy safety, production/staging restarts, DB/client records, and watching PR/CI.

## Verdict

READY_FOR_PARENT_TEST

True upstream merge plus staging history are on this branch. Staging ancestry is `22ea252f5`. Custom contracts re-checked after the staging merge. Parent should fast-forward the integration branch and watch GitHub CI (node tests, Vitest, docker-build, fail-closed secret scan). No local push.
