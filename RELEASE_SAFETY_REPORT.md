# LexySign app-only release safety report

Branch: `fix/lexysign-safe-app-release` (from `origin/main` `d4212d402325551cb9cb903038adfab76afe7b89`)
Initial commit (preserved): `b4ee6309816a04370e923461d1d3eba8d013085e`
Previous: `339378564ddfd03ee1cc80f49eb9da1809012a9a`
Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/release`
Caddyfile sha256 (unchanged): `1fa6cf56f250ab2f8afbb71a5166e9db5255e690471610e8c333972db5b2a005`

## This revision (native-format correction)

Parent streamed a real staging `mongodump --db=lexysign --archive --gzip`: exit 0, decompressed header hex `6de29981`, 20126 bytes. The invented `mdmp` fixture was wrong.

1. Native mongo archive magic is `6de29981`. `mdmp` gzip payloads are rejected. `_verify_mongo_gzip` streams the 4-byte header then drains gzip to EOF in 1MiB chunks so truncated tails and CRC-corrupt trailers fail. It does not `read_bytes()` the whole backup.
2. Compose config must match the rendered shape: `networks.lexysign.name`, `volumes['lexysign-files'].name`, server volume pair `lexysign-files` -> `/usr/src/app/files`, networks `{'lexysign': null}`. Aliases are resolved through top-level names. Staging alias -> production volume/network is refused. Wrong target, duplicate files mounts, and mongo alias routing another target are refused. Production maps `lexysign_lexysign-files` / `lexysign_lexysign` remain valid.
3. Client and server both have healthchecks. Post-up inspect retries `starting` -> `healthy` for 120s. Image id/revision are checked every iteration. `exited`/`dead`/wrong identity/`unhealthy` fail immediately. HTTP 200 is not a health substitute.
4. Manifest path in docs is `/opt/lexysign[-staging]/deploy/lexysign/.backup-manifest.json`. Archives remain under `/opt/lexysign[-staging]/backups/`.

## Verification

- Executable tests: 71 passed, 0 failed
- `bash -n deploy/lexysign/lexysign-app-release.sh`
- `python3 -m py_compile` on helper and tests
- YAML parse of deploy workflow
- `git diff --check` clean

Fakes used the parent-observed mongo header and real-shaped compose JSON. They do not prove live Hetzner restore, live Mailpit, or a real `docker compose config` on the host.

## Operator prep contract

Before staging or production app replacement:

1. Staging Mailpit `mailpit` or `lexysign-staging-mailpit` on `lexysign-staging_lexysign`, SMTP 1025, relay off. Remove SES from staging.
2. `mongodump --archive --gzip` of the target mongo DB and a gzip tar of the target files volume under `/opt/lexysign[-staging]/backups/<stamp>/`.
3. Manifest at `/opt/lexysign-staging/deploy/lexysign/.backup-manifest.json` or `/opt/lexysign/deploy/lexysign/.backup-manifest.json` with aware ISO `created_at` <= 24h, `image_swap_reverts_schema: false`, sha256/bytes, source identities, and gzip that is a native archive (magic `6de29981`), not `mdmp`.
4. Host `.env` stays on the host.

Image swap is not schema rollback. Parent still runs native backup validation and read-only rendered compose before any release.

## Status

READY_FOR_PARENT_NATIVE_CHECK
