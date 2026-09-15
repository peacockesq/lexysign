# LexySign review-release F3/F4/F5

Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/review-release`
Branch: `fix/lexysign-review-release`
Base: `80ba54c6ba747789081c767f0798dca18d62c3a7`
Independent BLOCK (immutable): `/home/trixie/lexysign-independent-80ba54-d2okJJ/REVIEW.md`
No SSH, push, live Docker, mail, client data, or config changes. Local fake-transport tests only.

F1/F2 are product-UI; another worker owns those.

## What changed

### F3 — Mailpit sink fail-closed

`validate_sink_container` now inspects `Config.Env`, `Config.Entrypoint`, `Config.Cmd`, and `Mounts`. Official activation names were taken from:

- https://mailpit.axllent.org/docs/configuration/smtp-relay/
- https://mailpit.axllent.org/docs/configuration/smtp-forward/
- https://mailpit.axllent.org/docs/configuration/runtime-options/

Rejected: relay/forward config-file env and CLI (`MP_SMTP_RELAY_CONFIG`, `MP_SMTP_FORWARD_CONFIG`, `--smtp-relay-config`, `--smtp-forward-config`), host/to (`MP_SMTP_RELAY_HOST`, `MP_SMTP_FORWARD_HOST`, `MP_SMTP_FORWARD_TO`, docs-prose `MP_FORWARD_TO`), matching (`MP_SMTP_RELAY_MATCHING` / `--smtp-relay-matching`), and true relay-all (`MP_SMTP_RELAY_ALL` / `--smtp-relay-all`). Split, equals, case, and boolean forms are handled. Existing five-key reject is kept.

Not rejected without reason: `MP_SMTP_RELAY_ALL=false` / `--smtp-relay-all=false`, tmpfs `/tmp` database, loopback UI `--listen 127.0.0.1:8025`. Optional companion relay fields without host/config/to are not treated as activation. Image pin and “no actual outbound” remain separate gates. Tests never enable real outbound.

### F4 — files tar.gz CRC/footer

Files archives now drain gzip to EOF in `GZIP_CHUNK` reads before tar structure checks. CRC/truncation is no longer inferred from tar member headers alone. SHA/size/source/age/target gates are unchanged. Native mongo magic `6de29981` and invented-`mdmp` reject are unchanged. Absolute/`..` tar members are rejected. Full-manifest negative with an honestly recomputed digest of a CRC-flipped fixture now fails. No whole-archive `read_bytes` / `gzip.decompress` in the verifiers.

### F5 — health recheck both apps

`verify_running_images` always inspects client and server in the same observation pass. A previously healthy peer is not dropped from later polls. Current running state, health, exact image, and revision labels are enforced every pass. Deadline/poll env semantics are preserved. No Caddy/Mongo restart or broad compose. Synthetic polling still does not prove permanent health after return.

## Tests

Command:

```
PYTHONDONTWRITEBYTECODE=1 bash deploy/lexysign/tests/run-tests.sh
```

Actual result: **89 passed, 0 failed**, exit 0.

- Original 71 names all still present and passing (none skipped).
- 18 added controls from the independent reviewer probes (outside frozen evidence): four F3 bypasses, neighboring official spellings, inert Mailpit baseline, files CRC/truncation/good/malicious-path, files gzip streaming source check, health dead/unhealthy/image-drift while peer starts, same-pass healthy baseline.

New sink/backup/health tests patch `inspect_container` or call validators directly. They do not invoke release `main` against native Docker. Existing harness tests still use the fake `docker`/`curl` transport.

## Unresolved native gates

- Independent BLOCK at `80ba54c6ba747789081c767f0798dca18d62c3a7` is not cleared until F1–F5 are rerun against a newly frozen commit. This lane only addresses F3–F5.
- No live Mailpit, no real SMTP forward/relay experiment, no native mongodump restore, no production/staging Docker, no hosted CI.
- Health waiter success is one observation pass, not permanent health.
- Image digest pin and “container currently has no outbound path” are still separate proofs.
- Archive CRC/tar checks are not restore proof.

A corrected helper still does not authorize deployment.
