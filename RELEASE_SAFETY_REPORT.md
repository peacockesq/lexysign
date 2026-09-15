# LexySign app-only release safety report

Branch: `fix/lexysign-safe-app-release` (from `origin/main` `d4212d402325551cb9cb903038adfab76afe7b89`)
Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/release`
Caddyfile sha256 (unchanged): `1fa6cf56f250ab2f8afbb71a5166e9db5255e690471610e8c333972db5b2a005`

## What changed

App deploy no longer stages, copies, reloads, removes, or rewires shared Caddy. It no longer uses `--remove-orphans` or `COMPOSE_PROFILES=edge`. Compose mutation is `pull server`, `pull client`, then `up -d --no-deps --force-recreate server client`. Mongo and volumes are not targeted.

Images are built from this workflow SHA with `org.opencontainers.image.revision=${{ github.sha }}` and deployed as the pinned `prod-<sha12>` / `staging-<sha12>` tag. Mismatched `image_tag` overrides are rejected. Host `.env` remains the secret source; client runtime-env.js is still produced by `docker-entrypoint.lexysign.sh` from `VITE_SUPABASE_*`. No frontend secret build-args.

Staging mail is fail-closed: only `mailpit` or `lexysign-staging-mailpit` on port `1025` with SMTP enabled. SES, empty, missing, default, localhost, and other hosts are refused. No reroute and no allowlist bypass.

Staging requires a real backup manifest with existing non-empty mongo dump and files archive before container replacement. Rollback metadata is client/server only. Image swap is not schema rollback.

Runtime smoke treats homepage 5xx/unreachable as failure. `/api/billing/status` must be unauthenticated 401. 5xx is backend death. 200 is not success.

## Verification

- Executable tests: 38 passed, 0 failed (`python3 deploy/lexysign/tests/test_app_release.py`)
- `bash -n deploy/lexysign/lexysign-app-release.sh`
- `python3 -m py_compile` on helper and tests
- YAML parse of `.github/workflows/lexysign-deploy.yml` via PyYAML
- `git diff --check` clean

Tests that prove behavior (fake `docker`/`curl`/`timeout`; no Docker daemon, SSH, or network):

1. smtp_fail_ses_host
2. smtp_fail_ses_default_alias
3. smtp_fail_missing_host
4. smtp_fail_empty_host
5. smtp_fail_unlisted_gmail_no_allowlist_bypass
6. smtp_fail_localhost_not_identity
7. smtp_fail_wrong_port
8. smtp_fail_disabled_sink
9. smtp_pass_mailpit
10. smtp_pass_lexysign_staging_mailpit
11. input_reject_mismatched_image_tag
12. input_reject_floating_tag
13. input_reject_bad_target
14. backup_missing_fails
15. backup_empty_archive_fails
16. backup_image_swap_schema_claim_fails
17. backup_valid_passes
18. docker_guard_refuses_caddy
19. docker_guard_refuses_remove_orphans
20. docker_guard_refuses_mongo_up
21. docker_guard_refuses_up_without_no_deps
22. docker_guard_allows_app_up
23. smoke_http_accepts_401_not_5xx
24. smoke_http_home_5xx_is_failure
25. smoke_http_billing_5xx_is_failure
26. smoke_http_billing_200_not_unconditional_success
27. release_staging_success_does_not_touch_caddy_or_mongo
28. release_staging_ses_fails_before_compose_up
29. release_staging_missing_backup_fails_before_mutation
30. release_missing_env_fails
31. release_pull_failure_propagates
32. release_up_failure_propagates
33. release_image_mismatch_after_up_fails
34. release_production_allows_ses_without_staging_sink
35. release_command_via_bash_wrapper
36. workflow_yaml_parses_and_stays_app_only
37. caddyfile_bytes_unchanged
38. helper_source_does_not_stage_caddyfile

## Limitations

- Local tests never talk to a real Docker daemon, SSH, GHCR, or public URL.
- This change does not provision the staging mail sink or take backups.
- Staging host `.env` still has Amazon SES until an operator replaces it; the helper will refuse staging deploy until that is done.
- Shared Caddy/edge is intentionally out of scope. Do not run a shared-edge release as part of this app upgrade.
- Application modules / Dockerfiles / Caddyfiles were not edited (v2.41.3 merge is another worker).
- Production SES is allowed. Production backup is documented, not a hard gate.
- `.rollback-meta.json` is target-only image metadata. Parse startup migrations can mutate Mongo; restoring the backup archives is the schema/data rollback path.
- No SMTP credentials were changed.

## Operator prep before live staging replacement

Cain/operator must do this on the host; the helper will not invent a sink or archives.

1. Run a local SMTP sink whose identity is exactly `mailpit` or `lexysign-staging-mailpit`, port `1025`.
2. Set staging `/opt/lexysign-staging/deploy/lexysign/.env`: `SMTP_HOST` to that identity, `SMTP_PORT=1025`, `SMTP_ENABLE=true`. Remove `email-smtp.us-east-1.amazonaws.com`.
3. `mongodump` staging Mongo and archive the staging files volume (non-empty files).
4. Write `/opt/lexysign-staging/deploy/lexysign/.backup-manifest.json` with `environment: staging`, `created_at`, absolute `mongo_dump` and `files_backup` paths, and `image_swap_reverts_schema: false`.
5. Leave host `.env` secrets in place. Do not inject `VITE_SUPABASE_*` as image build-args.

If step 1–4 are missing, staging app release exits 22 or 23 and does not recreate client/server.

## Status

READY_FOR_PARENT_TEST

Live synthetic signing on staging will remain fail-closed until the sink and backup manifest exist. That is intended.
