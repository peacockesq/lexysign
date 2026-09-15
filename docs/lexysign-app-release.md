# LexySign app-only release

This is the fail-closed path for replacing LexySign **client and server** on a host that also serves other products through shared Caddy.

Shared-edge / Caddyfile / Caddy networks / Caddy reload is a **separate explicit operation**. App release must not do it.

## What the workflow does

1. Pins image tags to `prod-<sha12>` or `staging-<sha12>` from the literal lowercase workflow SHA. Arbitrary `image_tag` overrides are rejected. Pulled image id + repo digest are resolved before `compose up`; a SHA-looking tag is not treated as immutable.
2. Builds client and server from this revision. Frontend secrets are **not** Docker build-args. Host `.env` still supplies `VITE_SUPABASE_*` for `docker-entrypoint.lexysign.sh` runtime-env.js.
3. Copies only `lexysign-app-release.py` to the host. It does not copy or overwrite `Caddyfile` or compose files.
4. Parses `docker compose config --format json` before mutation. Volume alias `lexysign-files` and network alias `lexysign` must resolve through top-level `name` to the target's actual volume/network. Server files mount must be the pair `lexysign-files` -> `/usr/src/app/files`. Staging aliases must not resolve to production names.
5. Staging mail is fail-closed on the **effective** compose server SMTP env, then on the live sink container: hostname `mailpit` or `lexysign-staging-mailpit`, port `1025`, shared app network, no relay/forwarding env. `.env` hostname allowlist alone is not enough.
6. Staging **and** production require a backup manifest before replacement. Archives must be distinct regular non-symlink files under `{deploy_path}/backups/`, with SHA-256 + byte-count readback, gzip streamed to EOF (CRC), native mongodump archive magic `6de29981` (invented `mdmp` is rejected), openable files tar, explicit `image_swap_reverts_schema: false`, timezone-aware ISO `created_at` within 24h, and source identity bound to the target project/mongo/volume/network. Non-empty junk is rejected. This is not a restore implementation.
7. Original rollback metadata and prior `.deploy.env` / HOST_URL are written once under `.release-history/` and not overwritten on retry. Preflight/pull failure leaves `.deploy.env` unchanged.
8. `pull server` then `pull client`, then `up -d --no-deps --force-recreate server client`. No `--remove-orphans`, no Mongo recreate, no Caddy.
9. Post-up containers must be running with the pulled image id/revision on every inspect. Healthchecks are required: `starting` may become `healthy` within 120s; `exited`/`dead`/wrong identity/`unhealthy` fail immediately. HTTP 200 is not a substitute.
10. HTTP smoke: curl nonzero is failure even if the body/code prints 200/401. `/api/billing/status` must be unauthenticated 401.

## Operator prep (staging and production)

Cain/operator, not this helper, must:

1. Staging only: provision Mailpit as `mailpit` or `lexysign-staging-mailpit` on the staging app network, SMTP `1025`, relay disabled. Point staging `.env` at that sink. Remove Amazon SES from staging. Effective compose env must resolve to the same sink.
2. Take a real `mongodump --archive --gzip` of the **target** mongo container and a gzip tar of the **target** files volume. Store them under `/opt/lexysign[-staging]/backups/<stamp>/`.
3. Write `/opt/lexysign-staging/deploy/lexysign/.backup-manifest.json` (production: `/opt/lexysign/deploy/lexysign/.backup-manifest.json`). Archives stay under `/opt/lexysign[-staging]/backups/<stamp>/`. Example staging:

```json
{
  "environment": "staging",
  "created_at": "2026-09-15T11:00:00Z",
  "image_swap_reverts_schema": false,
  "mongo_dump": "/opt/lexysign-staging/backups/<stamp>/mongo.archive.gz",
  "files_backup": "/opt/lexysign-staging/backups/<stamp>/files.tgz",
  "mongo_dump_sha256": "<sha256 of the gzip file>",
  "mongo_dump_bytes": 12345,
  "files_backup_sha256": "<sha256 of the tar.gz>",
  "files_backup_bytes": 12345,
  "source": {
    "project_name": "lexysign-staging",
    "mongo_container": "lexysign-staging-mongo",
    "files_volume": "lexysign-staging_lexysign-files",
    "network_name": "lexysign-staging_lexysign"
  }
}
```

Production uses `lexysign` / `lexysign-mongo` / `lexysign_lexysign-files` / `lexysign_lexysign`. `created_at` must be timezone-aware ISO-8601 and not older than 24 hours (5-minute future skew allowed). Image swap does not restore schema; native restore of those archives is a separate gate.

4. Keep host `.env` secrets in place. Do not inject `VITE_SUPABASE_*` as image build-args.

## Tests

```bash
bash deploy/lexysign/tests/run-tests.sh
```

Tests use a fake `docker`/`curl`/`timeout` environment and a temp-root path prefix. They do not talk to Docker, SSH, or the network, and they cannot turn off production identity checks.
