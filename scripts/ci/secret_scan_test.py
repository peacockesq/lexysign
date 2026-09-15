#!/usr/bin/env python3
"""Fixture tests for scripts/ci/secret_scan.py. No network. Temp git repos only."""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import secret_scan  # noqa: E402

ScanError = secret_scan.ScanError
list_changed_paths = secret_scan.list_changed_paths
read_tracked = secret_scan.read_tracked
run_scan = secret_scan.run_scan
scan_paths = secret_scan.scan_paths


def _git(repo: str, args: list[str], check: bool = True) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    env["GIT_AUTHOR_NAME"] = "ci-guard-test"
    env["GIT_AUTHOR_EMAIL"] = "ci-guard-test@example.invalid"
    env["GIT_COMMITTER_NAME"] = "ci-guard-test"
    env["GIT_COMMITTER_EMAIL"] = "ci-guard-test@example.invalid"
    proc = subprocess.run(["git", "-C", repo, *args], capture_output=True, env=env)
    if check and proc.returncode != 0:
        raise RuntimeError(proc.stderr.decode("utf-8", "replace"))
    return proc


def _init_repo(root: str) -> str:
    _git(root, ["init", "-b", "main"])
    _git(root, ["config", "user.name", "ci-guard-test"])
    _git(root, ["config", "user.email", "ci-guard-test@example.invalid"])
    Path(root, "README").write_text("ok\n", encoding="utf-8")
    _git(root, ["add", "README"])
    _git(root, ["commit", "-m", "root"])
    return root


def _commit_file(repo: str, relpath: str, content: str, message: str) -> None:
    dest = Path(repo, relpath)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(content, encoding="utf-8")
    _git(repo, ["add", "-A", "--", relpath])
    _git(repo, ["commit", "-m", message])


def _synthetic_aws_id() -> str:
    return "AKIA" + ("0" * 12) + "TEST"


def _synthetic_jwt() -> str:
    return "eyJ" + ("a" * 20) + "." + ("b" * 20) + "." + ("c" * 20)


class SecretScanTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="secret-scan-")
        self.repo = _init_repo(self._tmp.name)
        self.root = _git(self.repo, ["rev-parse", "HEAD"]).stdout.decode().strip()

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def test_empty_diff_is_clean(self) -> None:
        result = run_scan(self.repo, "push", self.root, "HEAD")
        self.assertTrue(result.ok)
        self.assertEqual(result.reason, "clean")
        self.assertEqual(result.matched_paths, [])

    def test_deleted_file_is_not_scanned(self) -> None:
        _commit_file(self.repo, "gone.txt", "delete me\n", "add gone")
        _git(self.repo, ["rm", "gone.txt"])
        _git(self.repo, ["commit", "-m", "remove gone"])
        paths = list_changed_paths(self.repo, self.root, "HEAD")
        self.assertNotIn("gone.txt", paths)
        result = run_scan(self.repo, "push", self.root, "HEAD")
        self.assertTrue(result.ok)
        self.assertEqual(result.reason, "clean")

    def test_missing_changed_file_fails_closed(self) -> None:
        result = scan_paths(self.repo, "HEAD", ["does-not-exist.txt"])
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "error")
        self.assertIn("missing changed tracked file", result.error or "")
        self.assertNotIn(_synthetic_aws_id(), result.error or "")

    def test_unreadable_read_error_fails_closed(self) -> None:
        def boom(repo: str, rev: str, path: str) -> bytes:
            raise OSError("permission denied")

        result = scan_paths(self.repo, "HEAD", ["README"], reader=boom)
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "error")
        self.assertIn("unreadable changed tracked file", result.error or "")

    def test_git_show_nonzero_other_error_fails_closed(self) -> None:
        _commit_file(self.repo, "blocked.txt", "no secret\n", "add blocked")
        real = read_tracked

        def other_error(repo: str, rev: str, path: str) -> bytes:
            if path == "blocked.txt":
                raise ScanError("unreadable changed tracked file: blocked.txt")
            return real(repo, rev, path)

        result = scan_paths(self.repo, "HEAD", ["blocked.txt"], reader=other_error)
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "error")

    def test_synthetic_match_fails_without_secret_text(self) -> None:
        token = _synthetic_aws_id()
        _commit_file(self.repo, "leak.txt", f"id={token}\n", "add leak")
        result = run_scan(self.repo, "push", self.root, "HEAD")
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "match")
        self.assertEqual(result.matched_paths, ["leak.txt"])
        dumped = (result.error or "") + "".join(result.matched_paths)
        self.assertNotIn(token, dumped)
        self.assertNotIn(_synthetic_jwt(), dumped)

    def test_whitespace_filename_is_nul_safe(self) -> None:
        token = _synthetic_jwt()
        _commit_file(self.repo, "white space.jwt.txt", token + "\n", "add spaced")
        paths = list_changed_paths(self.repo, self.root, "HEAD")
        self.assertIn("white space.jwt.txt", paths)
        result = run_scan(self.repo, "push", self.root, "HEAD")
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "match")
        self.assertEqual(result.matched_paths, ["white space.jwt.txt"])
        self.assertNotIn(token, "".join(result.matched_paths))

    def test_bad_comparison_ref_fails_closed(self) -> None:
        result = run_scan(self.repo, "push", "not-a-real-ref", "HEAD")
        self.assertFalse(result.ok)
        self.assertEqual(result.reason, "error")
        self.assertIn("refusing to skip", result.error or "")

    def test_workflow_dispatch_does_not_use_head_parent(self) -> None:
        _commit_file(self.repo, "docs-only.md", "docs\n", "docs")
        # Without origin/main, workflow_dispatch does a full tracked scan.
        result = run_scan(self.repo, "workflow_dispatch", "", "HEAD")
        self.assertTrue(result.ok)
        self.assertEqual(result.reason, "clean")
        _commit_file(self.repo, "full-scan-hit.txt", _synthetic_aws_id() + "\n", "secret")
        hit = run_scan(self.repo, "workflow_dispatch", "", "HEAD")
        self.assertFalse(hit.ok)
        self.assertEqual(hit.reason, "match")
        self.assertIn("full-scan-hit.txt", hit.matched_paths)

    def test_package_lock_and_png_are_skipped(self) -> None:
        token = _synthetic_aws_id()
        _commit_file(self.repo, "package-lock.json", token + "\n", "lock")
        png = Path(self.repo, "logo.png")
        png.write_bytes(b"\x89PNG\r\n" + token.encode("ascii"))
        _git(self.repo, ["add", "logo.png"])
        _git(self.repo, ["commit", "-m", "png"])
        result = run_scan(self.repo, "push", self.root, "HEAD")
        self.assertTrue(result.ok)
        self.assertEqual(result.reason, "clean")


if __name__ == "__main__":
    unittest.main()
