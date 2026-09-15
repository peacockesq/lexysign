#!/usr/bin/env python3
"""Fail-closed secret scan over git-tracked sources only.

Reads file contents via `git show <rev>:<path>` so untracked/private working-tree
files are never opened. Paths come from `git diff --name-only -z` (NUL-safe) or
`git ls-files -z` for a full tracked scan.

Exit codes:
  0  clean (empty diff or no matches)
  1  match found, or any error (missing file, git failure, unreadable blob)
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from dataclasses import dataclass, field

SKIP_NAMES = {"package-lock.json"}
SKIP_SUFFIXES = (".png", ".ico")

# Patterns are compiled from parts so this source file itself does not contain a match.
SECRET_PATTERNS = [
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----"),
    re.compile(r"sk_live_[A-Za-z0-9]{20,}"),
    re.compile(r"whsec_[A-Za-z0-9]{20,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{20,}"),
    re.compile(r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}"),
]


class ScanError(Exception):
    pass


@dataclass
class ScanResult:
    ok: bool
    reason: str
    matched_paths: list[str] = field(default_factory=list)
    error: str | None = None


def is_zero_sha(value: str | None) -> bool:
    if not value:
        return True
    stripped = value.strip()
    return stripped == "" or set(stripped) == {"0"}


def should_skip(path: str) -> bool:
    name = os.path.basename(path)
    if name in SKIP_NAMES:
        return True
    lower = path.lower()
    return lower.endswith(SKIP_SUFFIXES)


def git_run(repo: str, args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True,
    )
    if check and proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip() or f"git {' '.join(args)} failed"
        raise ScanError(err)
    return proc


def git_nul_lines(repo: str, args: list[str]) -> list[str]:
    proc = git_run(repo, args, check=True)
    parts = proc.stdout.split(b"\0")
    out = []
    for part in parts:
        if not part:
            continue
        out.append(part.decode("utf-8", "surrogateescape"))
    return out


def ref_exists(repo: str, ref: str) -> bool:
    proc = git_run(repo, ["rev-parse", "--verify", "--quiet", f"{ref}^{{commit}}"], check=False)
    return proc.returncode == 0


def resolve_base(event: str, provided_base: str | None, repo: str) -> tuple[str | None, bool]:
    """Return (base_ref, full_scan). Never falls back to HEAD^."""
    event = (event or "").strip()
    if event == "workflow_dispatch":
        if ref_exists(repo, "origin/main"):
            return "origin/main", False
        return None, True
    if event == "pull_request":
        if is_zero_sha(provided_base):
            raise ScanError("pull_request base SHA is missing; refusing to skip")
        return provided_base.strip(), False
    if not is_zero_sha(provided_base):
        return provided_base.strip(), False
    if ref_exists(repo, "origin/main"):
        return "origin/main", False
    return None, True


def list_changed_paths(repo: str, base: str, head: str) -> list[str]:
    if not ref_exists(repo, base):
        raise ScanError(f"scan base {base} is not a commit; refusing to skip")
    if not ref_exists(repo, head):
        raise ScanError(f"scan head {head} is not a commit; refusing to skip")
    try:
        return git_nul_lines(
            repo,
            ["diff", "--name-only", "-z", "--diff-filter=ACMRT", base, head],
        )
    except ScanError as exc:
        raise ScanError(f"git diff failed for {base}..{head}: {exc}") from exc


def list_tracked_paths(repo: str, head: str) -> list[str]:
    if not ref_exists(repo, head):
        raise ScanError(f"scan head {head} is not a commit; refusing to skip")
    return git_nul_lines(repo, ["ls-tree", "-r", "-z", "--name-only", head])


def read_tracked(repo: str, rev: str, path: str) -> bytes:
    proc = git_run(repo, ["show", f"{rev}:{path}"], check=False)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        if proc.returncode == 128 or "does not exist" in err or "exists on disk, but not in" in err:
            raise ScanError(f"missing changed tracked file: {path}")
        raise ScanError(f"unreadable changed tracked file: {path}")
    return proc.stdout


def file_has_secret(data: bytes) -> bool:
    text = data.decode("latin-1")
    return any(pattern.search(text) for pattern in SECRET_PATTERNS)


def scan_paths(repo: str, rev: str, paths: list[str], reader=read_tracked) -> ScanResult:
    matched: list[str] = []
    for path in paths:
        if should_skip(path):
            continue
        try:
            data = reader(repo, rev, path)
        except ScanError as exc:
            return ScanResult(ok=False, reason="error", error=str(exc))
        except OSError:
            return ScanResult(
                ok=False,
                reason="error",
                error=f"unreadable changed tracked file: {path}",
            )
        try:
            if file_has_secret(data):
                matched.append(path)
        except Exception:
            return ScanResult(
                ok=False,
                reason="error",
                error=f"failed scanning {path}",
            )
    if matched:
        return ScanResult(ok=False, reason="match", matched_paths=matched)
    return ScanResult(ok=True, reason="clean")


def run_scan(repo: str, event: str, provided_base: str | None, head: str) -> ScanResult:
    try:
        base, full = resolve_base(event, provided_base, repo)
        if full:
            paths = list_tracked_paths(repo, head)
        else:
            assert base is not None
            paths = list_changed_paths(repo, base, head)
        return scan_paths(repo, head, paths)
    except ScanError as exc:
        return ScanResult(ok=False, reason="error", error=str(exc))


def report(result: ScanResult) -> int:
    if result.reason == "clean":
        print("Secret scan clean.", file=sys.stderr)
        return 0
    if result.reason == "match":
        for path in result.matched_paths:
            print(f"Secret pattern matched in {path}", file=sys.stderr)
        return 1
    print(result.error or "Secret scan failed closed.", file=sys.stderr)
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Fail-closed tracked-source secret scan")
    parser.add_argument("--repo", default=".", help="Git repository root")
    parser.add_argument("--event", default="", help="GitHub event name")
    parser.add_argument("--base", default="", help="Comparison base SHA/ref")
    parser.add_argument("--head", default="HEAD", help="Head revision to read blobs from")
    args = parser.parse_args(argv)
    repo = os.path.abspath(args.repo)
    result = run_scan(repo, args.event, args.base, args.head)
    return report(result)


if __name__ == "__main__":
    sys.exit(main())
