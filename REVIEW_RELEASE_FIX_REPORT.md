# LexySign review-release F3 correction

Worktree: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/review-release`
Branch: `fix/lexysign-review-release`
Parent (immutable prior candidate): `1a2cdbac798fc53f067182721b9aef1c86438b4d`
Original BLOCK (immutable): `/home/trixie/lexysign-independent-80ba54-d2okJJ/REVIEW.md`
Re-review BLOCK (immutable): `/home/trixie/lexysign-release-rereview-1a2cdb-ns8eplb7/REVIEW.md`
No SSH, push, live Docker, mail, client data, or config/provider changes. Local fake-transport tests only.
F4/F5 helper fixes in `1a2cdb` are unchanged. F1/F2 are product-UI; another worker owns those.

This commit does not clear the independent re-review BLOCK. Parent integrates only after a fresh independent frozen review of this SHA.

## F3 — env occurrence scan (root cause)

`1a2cdb` still BLOCKED: `_env_lookup_ci` returned the first case-insensitive match after `env_map` collapsed `Config.Env` into a dict. An empty lowercase key hid an active uppercase Mailpit setting. Exact duplicate keys last-won, so an active value followed by an empty same key was accepted.

`mailpit_outbound_reason` now walks every raw `Config.Env` occurrence. No dictionary collapse. Every case-insensitive match of a supported key is inspected; any active occurrence rejects. Linux uppercase/lowercase keys are distinct; the validator still conservatively rejects either. An empty/inert variant never shadows an active one in any order.

Covered: host, forward host/to, config, relay matching, relay-all — case collisions and exact duplicate-key values/orders. Inert `MP_SMTP_RELAY_ALL=false` still accepted. Error text names keys only; values are not copied into `ReleaseError`.

## CLI / mounts

pflag `BoolVar` gives bare `--smtp-relay-all` `NoOptDefVal=true` and does not consume the next token. `--smtp-relay-all=false` remains the inert equals form. Split `--smtp-relay-all false` is conservative activation (reject). Upstream Cobra rejects positional `false` before server start, so split-false is not an independent runnable outbound witness.

The mounts loop was a no-op. It is removed. Mount contents are not opened or validated; this is not a broad egress redesign.

## Tests (TDD)

RED, tests only, helper still `1a2cdb` behavior:

```
PYTHONDONTWRITEBYTECODE=1 bash deploy/lexysign/tests/run-tests.sh
```

Actual: **96 tests: 89 passed, 7 failed**, exit 1. Log: `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/f3-correction-controls/red-supplied-tests.log`

Failed (ReleaseError was not raised):

- `sink_rejects_split_smtp_relay_all_false_conservative_pflag`
- `sink_rejects_case_masked_relay_host_any_order`
- `sink_rejects_case_masked_forward_host_to_any_order`
- `sink_rejects_case_masked_relay_and_forward_config_any_order`
- `sink_rejects_case_masked_relay_matching_and_all_any_order`
- `sink_rejects_duplicate_env_keys_any_active_occurrence` (active then empty same key)
- `sink_rejects_env_activation_without_leaking_values`

Original 89 names still passed on that run, including inert `MP_SMTP_RELAY_ALL=false` / `--smtp-relay-all=false`.

GREEN after the helper change, same command: **96 passed, 0 failed**, exit 0. Log: `.../f3-correction-controls/green-supplied-tests.log`

## Independent controls (outside original evidence)

Copied/adapted `/home/trixie/lexysign-release-rereview-1a2cdb-ns8eplb7/regression-controls.py` to `/home/trixie/.hermes/profiles/cain/workspace/lexysign-upgrade-20260915/f3-correction-controls/regression-controls.py`. Candidate path is this worktree helper. Original helper is a byte-identical copy (`sha256 3a398597a69170bef8159ffdc7945e6e6827879567c184951d0be758445117eb`). Original review tree was not written.

```
python3 -B .../f3-correction-controls/regression-controls.py
```

Actual run `controls-nwb1k3uc`, **exit 0**:

- F3 **21/21 PASS**
- F4 **8/8 PASS** (preserved)
- F5 **8/8 PASS** (preserved)

Candidate helper sha256 in that result: `cf946b60433b1ed8cd876597581736026c859d20940f413abb1fca5628996d10`. Offline declarations and synthetic inspect/format fixtures only; no native mail/Docker/Mongo.

## Unresolved native gates

- Independent BLOCKs at `80ba54c6ba747789081c767f0798dca18d62c3a7` and `1a2cdbac798fc53f067182721b9aef1c86438b4d` stay on those SHAs. This lane needs a new frozen review.
- No live Mailpit, no real SMTP forward/relay experiment, no native mongodump restore, no production/staging Docker, no hosted CI.
- Split-false conservative deny is not proof of a running native sink.
- Mount files are not opened; image pin and “container currently has no outbound path” remain separate proofs.
- Health waiter success is one observation pass, not permanent health.
- Archive CRC/tar checks are not restore proof.

A corrected helper still does not authorize deployment.
