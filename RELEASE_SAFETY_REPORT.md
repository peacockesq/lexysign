# LexySign app-only release safety report

Branch: `fix/lexysign-safe-app-release` (from `origin/main` `d4212d402325551cb9cb903038adfab76afe7b89`)
Initial commit (preserved): `b4ee6309816a04370e923461d1d3eba8d013085e`
Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/release`
Caddyfile sha256 (unchanged): `1fa6cf56f250ab2f8afbb71a5166e9db5255e690471610e8c333972db5b2a005`

## Corrections in this revision

Parent review gaps closed in code + negative tests. `LEXYSIGN_APP_RELEASE_TEST` bypass removed. Tests inject `LEXYSIGN_DEPLOY_ROOT` plus fake PATH/login tokens; production container/URL/project/network identities stay mandatory.

1. Backup: explicit `image_swap_reverts_schema: false`, timezone-aware ISO `created_at` with 24h freshness / 5min future skew, source project/mongo/volume/network identity, SHA-256 + byte readback, regular non-symlink files under `{deploy_path}/backups/`, gzip+`mdmp` mongo header, openable files tar. Required for staging **and** production. Junk/truncation/hash mismatch/wrong target/stale/future rejected. Not a restore implementation.
2. Running containers: require Running, not restarting/dead/exited; health=healthy when a healthcheck exists. Pulled image id + repo digest + revision/environment labels are checked **before** `compose up`. Post-up `Image` must match the pulled candidate id.
3. Compose `config --format json` is parsed before mutation (stdout not logged). Server/client names, pinned image, Mongo URI, files mount, no privileged/host/docker.sock/shared-edge mounts. Current target inspect must keep the mount/network contract.
4. Staging SMTP uses effective compose server env, then inspects the live sink container (running, port 1025, app network, relay env empty). SES override and Mailpit relay are refused. Inspect-only; no network mutations.
5. SHA is not case-folded. Missing registry login fails. The old test env flag cannot skip production path checks.
6. `.release-history/original-rollback.json`, `original.deploy.env`, and `original.host_url` are write-once. Attempt ledger files are additive. Preflight/pull failure leaves `.deploy.env` unchanged.
7. curl nonzero exit is failure even if 200/401 was printed.

## Verification

- Executable tests: 57 passed, 0 failed (`python3 deploy/lexysign/tests/test_app_release.py`)
- `bash -n deploy/lexysign/lexysign-app-release.sh`
- `python3 -m py_compile` on helper and tests
- YAML parse of `.github/workflows/lexysign-deploy.yml` via PyYAML
- `git diff --check` clean

## Remaining gaps (not overclaimed)

- Fakes do not prove live Mailpit/Mongo/volume identity on Hetzner. Parent still provisions the sink and takes real archives.
- Archive checks are magic/header/tar-open + hash readback, not a restore drill.
- Compose config validation uses the rendered JSON from `docker compose config`; it does not rewrite shared compose.
- Production SES remains allowed; staging SES is not.
- No SSH, deploy, GHCR pull, or public URL was exercised here.

## Operator prep contract

Before **staging or production** app replacement:

1. Staging: Mailpit container named `mailpit` or `lexysign-staging-mailpit`, SMTP 1025, on `lexysign-staging_lexysign`, relay disabled. Staging `.env` and effective compose SMTP must match. Remove SES from staging.
2. `mongodump --archive --gzip` of the target mongo container and gzip tar of the target files volume, stored under `/opt/lexysign[-staging]/backups/<stamp>/` as regular files (no symlinks).
3. Manifest at `{deploy}/.backup-manifest.json` with environment, aware ISO `created_at` <= 24h, `image_swap_reverts_schema: false`, absolute paths, sha256/bytes for both archives, and `source` matching that target's project/mongo/volume/network names.
4. Host `.env` secrets stay on the host. No frontend secret build-args.

If those are missing, the helper exits 22/23 and does not recreate client/server. Image swap is not schema rollback; restore of the archives is a separate native gate.

## Status

READY_FOR_PARENT_TEST
