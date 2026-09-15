# CI guard report

Branch: `upgrade/opensign-v2.41.3`
Base HEAD before this commit: `95ec46dbc1e796529f405c511ca0cd92f1314973`
This commit SHA: filled after commit (see `git log -1`).

Standalone scanner/CI-guard change only. No package.json / package-lock edits (client lockfile mismatch is owned by another worker). No product logic. No push.

## Problem

The previous bash secret scan was not fail-closed:

- Missing/unreadable changed paths used `continue`.
- `if grep -qE`: grep exit 0 is match, exit 1 is no-match, exit 2 (I/O error) is treated as false / no-match.
- `workflow_dispatch` / zero `before` fell back to `HEAD^`, which is often a docs-only commit and under-scans (parent local scan vs `origin/main` is ~107–111 source files).
- Line-oriented `git diff --name-only` is not NUL-safe.

## Fix

New scanner: `scripts/ci/secret_scan.py`

- Paths from `git diff --name-only -z --diff-filter=ACMRT` (deleted files excluded) or `git ls-tree -r -z --name-only` for a full tracked scan.
- File bytes from `git show <rev>:<path>` only — untracked/private working-tree files are never opened.
- Match: print `Secret pattern matched in <path>` only; never print blob text.
- Missing tracked path, `git show` errors, OSError, and bad comparison refs fail the job.
- Skip `package-lock.json`, `*.png`, `*.ico`.
- Event rules:
  - `pull_request`: require provided base SHA.
  - `push` with a real `before`: use it.
  - `workflow_dispatch` or missing/zero `before`: `origin/main` if present, else full tracked scan. Never `HEAD^`.

Workflow `.github/workflows/lexysign-ci.yml`:

- Fetches `origin/main`.
- Runs `python3 scripts/ci/secret_scan_test.py` then the scanner.
- Adds `parity-tests` job: Node 22, no npm install. Requires `tests/parity/*.test.mjs` and fails if the directory or glob is empty (no silent skip).
- Path filters include `scripts/ci/**` and `tests/parity/**`.

`tests/parity/` is not on this branch (lives on parent integration). The parity job is therefore red here until those files are present. That is required fail-closed behavior. Do not green it by skipping. Existing parity tests are expected red pending upstream-compat/product work; this commit does not modify them.

## Local receipts

Host: aarch64, Python 3.13, Node 22.

```
python3 scripts/ci/secret_scan_test.py
..........
Ran 10 tests in 1.250s
OK
```

Fixtures: empty diff; real deleted file; missing path; unreadable/OSError; synthetic match without printing token; whitespace filename via `-z`; bad comparison ref; workflow_dispatch full-scan (no HEAD^); lock/png skip.

```
python3 scripts/ci/secret_scan.py --event push --base origin/main --head HEAD
Secret scan clean.   # exit 0
# 111 ACMRT paths vs origin/main

python3 scripts/ci/secret_scan.py --event workflow_dispatch --base '' --head HEAD
Secret scan clean.   # uses origin/main, not HEAD^

python3 scripts/ci/secret_scan.py --event push --base not-a-real-ref --head HEAD
scan base not-a-real-ref is not a commit; refusing to skip
# exit 1
```

Node contracts unaffected:

- `apps/OpenSign` `node --test test-node/*.test.mjs` — 8 pass
- `apps/OpenSignServer` `node --test spec/lexysignContracts.test.js` — 11 pass

`git diff --check`: clean.

Not run / not called passed: Vitest, Jasmine/Mongo, Docker builds, GitHub CI job `34966560020` client npm ci (lock hash mismatch is another worker). Server Docker pass on that run is noted only.

## Ownership / cherry-pick

Parent should cherry-pick this scanner/CI commit only, not parity tests (`a075e3e78`, `06cbaf74f`). Those tests were not added here.
