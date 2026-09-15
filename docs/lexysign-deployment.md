# LexySign Deployment Discipline

LexySign is live software. Do not patch the Hetzner working tree or running containers as the normal release path.

## Branch and environment model

| Branch/event | Environment | Public URL | Image tags | Server path |
| --- | --- | --- | --- | --- |
| PR to `staging` / `main` | CI only | n/a | local build only | n/a |
| Push to `staging` | staging | `https://sign-staging.lexyalgo.com` | `staging`, `staging-<sha>` | `/opt/lexysign-staging` |
| Push to `main` | production | `https://sign.lexyalgo.com` | `production`, `prod-<sha>` | `/opt/lexysign` |
| Manual workflow dispatch | selected | selected | selected/default | selected |

Current live product was cut from `lexysign-hetzner-prep`. Future durable work should land by PR into `staging`, smoke on staging, then PR/merge to `main` for production.

## Required GitHub environments

Create GitHub environments named `staging` and `production`.

Environment secrets:

- `LEXYSIGN_DEPLOY_SSH_KEY` — private deploy key for the Hetzner host.

Do not add frontend secrets as workflow build-args. `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` stay in the host `.env` and are consumed at container start by `docker-entrypoint.lexysign.sh`.

Environment variables:

- `LEXYSIGN_DEPLOY_HOST` — `37.27.49.209`.
- `LEXYSIGN_DEPLOY_USER` — `root` unless a non-root deploy user is provisioned.
- `LEXYSIGN_DEPLOY_PORT` — `22` unless SSH changes.

The server runtime secrets stay in `.env` on the VPS and must not be committed. GitHub does not receive frontend secret injection as Docker build-args; the client entrypoint still writes runtime-env.js from host `.env` `VITE_SUPABASE_*` values. SSH deploy credentials stay in the GitHub environment.

## VPS runtime files

Production:

- `/opt/lexysign/deploy/lexysign/.env`
- `/opt/lexysign/deploy/lexysign/docker-compose.runtime.yml`

Staging:

- `/opt/lexysign-staging/deploy/lexysign/.env`
- `/opt/lexysign-staging/deploy/lexysign/docker-compose.runtime.yml`

The deploy workflow refuses to deploy an environment if its `.env` is missing.

## Release gates

1. PR CI must pass:
   - server syntax checks;
   - container builds for client and server;
   - secret-pattern scan.
2. Merge to `staging`.
3. Confirm staging loads and auth/billing boundaries behave correctly.
4. Merge to `main`.
5. App deploy (see `docs/lexysign-app-release.md`) must show:
   - both images pushed to GHCR with `org.opencontainers.image.revision` equal to the workflow SHA and tags pinned to `prod-<sha12>` / `staging-<sha12>`;
   - Hetzner app-only `compose pull` / `up -d --no-deps server client` (no shared Caddy copy/reload/networks, no `--remove-orphans`, no Mongo recreate);
   - public URL returns a non-5xx response;
   - `/api/billing/status` returns the expected unauthenticated `401` boundary (5xx/unreachable is a failed deploy, not success).
   Shared Caddy/edge remains a separate explicit operation. Staging also requires a local SMTP sink and a real backup manifest before container replacement.

## Emergency break-glass

If a live hotfix is unavoidable, patch the server only to stop bleeding, then immediately back-port the exact change to GitHub and run the deploy workflow. Container-only fixes are undocumented debt, not a release.
