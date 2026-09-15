# LexySign app-only release

This is the fail-closed path for replacing LexySign **client and server** on a host that also serves other products through shared Caddy.

Shared-edge / Caddyfile / Caddy networks / Caddy reload is a **separate explicit operation**. App release must not do it.

## What the workflow does

1. Pins image tags to `prod-<sha12>` or `staging-<sha12>` from the workflow `github.sha`. Arbitrary `image_tag` overrides are rejected.
2. Builds client and server from this revision. Frontend secrets are **not** Docker build-args. Host `.env` still supplies `VITE_SUPABASE_*` for `docker-entrypoint.lexysign.sh` runtime-env.js.
3. Copies only `lexysign-app-release.py` to the host. It does not copy or overwrite `Caddyfile` or compose files.
4. Staging preflight fails unless SMTP is the explicit local sink `mailpit` or `lexysign-staging-mailpit` on port `1025` with `SMTP_ENABLE=true`. SES, empty, default, and any other host are refused. No silent reroute.
5. Staging preflight fails unless `.backup-manifest.json` points at existing non-empty `mongo_dump` and `files_backup` files.
6. Writes target-only `.rollback-meta.json` (client/server image ids and revisions). **Replacing those images does not reverse Parse startup migrations.**
7. `docker compose ... pull server` then `pull client`, then `up -d --no-deps --force-recreate server client`. No `--remove-orphans`, no Mongo recreate, no volume ops, no Caddy.
8. Verifies running images and `org.opencontainers.image.revision` match the workflow SHA.
9. HTTP smoke: `/` must be 2xx/3xx; `/api/billing/status` must be **401**. 5xx/unreachable is failure. Other billing codes are not success.

## Operator prep before staging app replacement

Cain/operator, not this helper, must:

1. Provision a local SMTP sink whose hostname is exactly `mailpit` or `lexysign-staging-mailpit`, SMTP port `1025`.
2. Point `/opt/lexysign-staging/deploy/lexysign/.env` at that sink (`SMTP_HOST`, `SMTP_PORT=1025`, `SMTP_ENABLE=true`). Remove Amazon SES from staging. Do not leave production mail credentials as the staging default.
3. Take a real mongodump of staging Mongo and an archive of the staging files volume. Empty files and `/dev/null` are rejected.
4. Write `/opt/lexysign-staging/deploy/lexysign/.backup-manifest.json`:

```json
{
  "environment": "staging",
  "created_at": "2026-09-15T00:00:00Z",
  "mongo_dump": "/opt/lexysign-staging/backups/<stamp>/mongo.archive",
  "files_backup": "/opt/lexysign-staging/backups/<stamp>/files.tgz",
  "image_swap_reverts_schema": false
}
```

5. Keep host `.env` secrets in place. Do not paste them into GitHub Actions build-args.

If the sink or backup manifest is missing, the helper exits with a clear error and does not mutate app containers.

## Rollback

- Client/server container image ids are in `.rollback-meta.json` for a **target-only** image retag/recreate.
- That is not schema DR. Parse can migrate Mongo on startup. Restore `mongo_dump` and `files_backup` to undo data/schema mutation. Do not treat image swap as a database rollback.

## Tests

```bash
bash deploy/lexysign/tests/run-tests.sh
```

Tests use a fake `docker`/`curl`/`timeout` environment. They do not talk to Docker, SSH, or the network.
