# OpenSign client lockfile repair (npm 10.9.8 `npm ci`)

Branch: `fix/lexysign-client-lockfile`
Base SHA: `aa40aba673441eef68236f43153742c9cd2cd174`
CI: GitHub Actions `34966560020` (client Docker `RUN npm ci --no-audit --no-fund` on `node:22-bookworm-slim` / npm 10.9.8)

Product edit: `apps/OpenSign/package-lock.json` only.
`apps/OpenSign/package.json` was inspected and not changed.

## Failure reproduced

Host: Node v22.23.2, system npm 12.0.2.
Verifier: private install of npm 10.9.8 at `/tmp/npm-10.9.8-standalone` (no global npm changes).

Command (apps/OpenSign, before repair):

```
/tmp/npm-10.9.8-standalone/node_modules/.bin/npm ci --dry-run --ignore-scripts --no-audit --no-fund
```

Exit 1:

```
npm error code EUSAGE
npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.
npm error Invalid: lock file's @noble/hashes@1.4.0 does not satisfy @noble/hashes@2.4.0
npm error Missing: @noble/hashes@1.4.0 from lock file
```

npm 10.9.8 debug log (`idealTree`):

```
silly placeDep ROOT @noble/hashes@2.4.0 REPLACE for: @exodus/bytes@1.15.1 want: ^1.8.0 || ^2.0.0
silly placeDep node_modules/pkijs @noble/hashes@1.4.0 OK for: pkijs@3.4.0 want: 1.4.0
```

## Root cause

`pkijs@3.4.0` (root dependency pin `pkijs: ^3.4.0`) depends on exact `@noble/hashes@1.4.0`.
The previous lockfile hoisted that copy to `node_modules/@noble/hashes@1.4.0` and did not record a nested pkijs copy.

`jsdom@29.1.1` (devDependency) depends on `@exodus/bytes@1.15.1`, which declares an optional peer:

```
@noble/hashes: ^1.8.0 || ^2.0.0
```

npm 10.9.8's `npm ci` ideal tree installs that optional peer as current `@noble/hashes@2.4.0` at the root, then needs `@noble/hashes@1.4.0` nested under `pkijs`. The old lockfile had only root 1.4.0, so:

1. root lock 1.4.0 does not satisfy ideal 2.4.0
2. nested 1.4.0 is missing from the lockfile

This is an npm 10.9.8 lockfile-sync check, not a pkijs registry drift: `pkijs@3.4.0` still publishes `@noble/hashes: 1.4.0`.

### Override interaction

`apps/OpenSign/package.json` `overrides` are security/compat pins:

- `brace-expansion`, `tmp`, `react`, `react-dom`, `form-data`, `js-yaml`, `undici`, `fast-uri`, `nanoid`, `ws`, `protobufjs`

None of those overrides mention `@noble/hashes` or `pkijs`. They did not force 1.4.0 or 2.4.0.
`npm install --package-lock-only` with npm 10.9.8 did not rewrite override entries and left `package.json` unchanged.
The conflict is peer-vs-exact-dep placement (`@exodus/bytes` optional peer vs `pkijs` exact 1.4.0), not an override clash.

## Remediation

From `apps/OpenSign`, npm 10.9.8:

```
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

Result: 19 insertions, 4 deletions in `apps/OpenSign/package-lock.json`. No other lock entries changed. `package.json` hash unchanged.

## Before / after dependency nodes

Before:

- `node_modules/@noble/hashes` = 1.4.0
  - resolved `https://registry.npmjs.org/@noble/hashes/-/hashes-1.4.0.tgz`
  - integrity `sha512-V1JJ1WTRUqHHrOSh597hURcMqVKVGL/ea3kv0gSnEdsEZ0/+VyPghM1lMNGc00z7CIQorSvbKpuJkxvuHbvdbg==`
- no `node_modules/pkijs/node_modules/@noble/hashes`

After:

- `node_modules/@noble/hashes` = 2.4.0 (dev, optional, peer)
  - resolved `https://registry.npmjs.org/@noble/hashes/-/hashes-2.4.0.tgz`
  - integrity `sha512-X5XaVWZIBCT7HHZGm5I7ZQXDwLG+bGXuSrMQAW+7Zvl87h1kmc1ZB1VSRJcpUfoUrGQp4Fkoxm5kZ+Ms+aW+eA==`
- `node_modules/pkijs/node_modules/@noble/hashes` = 1.4.0
  - same resolved URL and integrity as the previous root 1.4.0 node
- `node_modules/pkijs` remains 3.4.0

Registry check (`npm view`):

- `@noble/hashes@2.4.0` dist.integrity matches the new root node
- `@noble/hashes@1.4.0` dist.integrity matches the nested pkijs node (unchanged)

pkijs still gets 1.4.0. Root 2.4.0 is the optional jsdom/`@exodus/bytes` peer, not a production pin change.

## Verification (npm 10.9.8)

`git diff --check` on the lockfile: clean (exit 0).

After repair, same dry-run:

```
/tmp/npm-10.9.8-standalone/node_modules/.bin/npm ci --dry-run --ignore-scripts --no-audit --no-fund
```

Exit 0. Dry-run plan includes both `add @noble/hashes 2.4.0` and `add @noble/hashes 1.4.0`.

Hashes before and after that dry-run (no file drift):

- `apps/OpenSign/package.json` `eff4b9707ace6219bc9780d64fb10c8829ac685966edeca09821d75c9eee2a6a`
- `apps/OpenSign/package-lock.json` `d58cbca7597a6bce52ae949a08d7fd9e38130413fb69a507b1afaaa7d37d181b`

Second `npm install --package-lock-only --ignore-scripts --no-audit --no-fund` with npm 10.9.8: "up to date", same lockfile hash. No `node_modules` installed.

## Outstanding gate

This worktree did not rerun the GitHub Docker client build. Parent must cherry-pick this commit and rerun the actual `node:22-bookworm-slim` client image `RUN npm ci --no-audit --no-fund` (CI 34966560020 class). Server Docker build already passed on the base SHA.
