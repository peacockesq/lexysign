#!/usr/bin/env python3
"""Executable tests for LexySign app-only release.

Uses a fake command environment. No Docker daemon, SSH, or network I/O.
"""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path


HERE = Path(__file__).resolve().parent
DEPLOY_DIR = HERE.parent
REPO_ROOT = DEPLOY_DIR.parent.parent
HELPER_PY = DEPLOY_DIR / "lexysign-app-release.py"
HELPER_SH = DEPLOY_DIR / "lexysign-app-release.sh"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "lexysign-deploy.yml"
CADDYFILE = DEPLOY_DIR / "Caddyfile"
KNOWN_CADDY_SHA256 = "1fa6cf56f250ab2f8afbb71a5166e9db5255e690471610e8c333972db5b2a005"

_spec = importlib.util.spec_from_file_location("lexysign_app_release", HELPER_PY)
app = importlib.util.module_from_spec(_spec)
assert _spec.loader is not None
_spec.loader.exec_module(app)


SHA = "d4212d402325551cb9cb903038adfab76afe7b89"
OLD_SHA = "22ea252f555d0000000000000000000000000000"
STAGING_TAG = f"staging-{SHA[:12]}"
PROD_TAG = f"prod-{SHA[:12]}"
SECRET_VALUE = "super-secret-not-for-logs-xyz"

FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

state_path = Path(os.environ["FAKE_STATE"])
state = json.loads(state_path.read_text())
argv = sys.argv[1:]
state.setdefault("log", []).append(argv)
fail = state.get("fail_on")
if fail == "login" and argv[:1] == ["login"]:
    state_path.write_text(json.dumps(state))
    sys.exit(1)
if fail == "pull" and "pull" in argv:
    state_path.write_text(json.dumps(state))
    sys.exit(13)
if fail == "up" and "up" in argv:
    state_path.write_text(json.dumps(state))
    sys.exit(17)
if argv[:1] == ["login"]:
    state_path.write_text(json.dumps(state))
    sys.exit(0)
if argv[:1] == ["inspect"]:
    name = argv[-1]
    doc = state.get("containers", {}).get(name)
    if not doc:
        state_path.write_text(json.dumps(state))
        sys.exit(1)
    sys.stdout.write(json.dumps([doc]))
    state_path.write_text(json.dumps(state))
    sys.exit(0)
if "up" in argv:
    image_tag = state.get("next_image_tag")
    revision = state.get("next_revision")
    owner = state.get("image_owner", "peacockesq")
    registry = state.get("registry", "ghcr.io")
    mapping = state.get("service_containers", {})
    for service, name in mapping.items():
        if name in state.get("containers", {}):
            state["containers"][name]["Config"]["Image"] = f"{registry}/{owner}/lexysign-{service}:{image_tag}"
            state["containers"][name]["Config"]["Labels"]["org.opencontainers.image.revision"] = revision
            state["containers"][name]["Id"] = f"new-{service}-id"
            state["containers"][name]["Image"] = f"sha256:new-{service}"
    if state.get("mismatch_after_up"):
        for name, doc in state.get("containers", {}).items():
            doc["Config"]["Image"] = "ghcr.io/peacockesq/lexysign-client:wrong-tag"
            doc["Config"]["Labels"]["org.opencontainers.image.revision"] = "deadbeef"
state_path.write_text(json.dumps(state))
sys.exit(0)
'''

FAKE_CURL = r'''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
state = json.loads(Path(os.environ["FAKE_STATE"]).read_text())
url = next((a for a in sys.argv[1:] if a.startswith("http://") or a.startswith("https://")), sys.argv[-1])
code = state.get("http", {}).get(url, state.get("http_default", "000"))
sys.stdout.write(str(code))
sys.exit(0)
'''

FAKE_TIMEOUT = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
if not args:
    sys.exit(1)
os.execvp(args[1], args[1:])
'''


class Results:
    def __init__(self) -> None:
        self.passed = 0
        self.failed = 0
        self.names: list[str] = []
        self.failures: list[str] = []

    def record(self, name: str, ok: bool, err: str = "") -> None:
        self.names.append(name)
        if ok:
            self.passed += 1
            print(f"PASS {name}")
        else:
            self.failed += 1
            self.failures.append(f"{name}: {err}")
            print(f"FAIL {name}: {err}")


RESULTS = Results()


TESTS: list = []


def test(name: str):
    def deco(fn):
        TESTS.append((name, fn))
        return fn

    return deco


def write_exec(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def container_doc(image: str, revision: str, ident: str) -> dict:
    return {
        "Id": ident,
        "Image": f"sha256:{ident}",
        "Config": {
            "Image": image,
            "Labels": {"org.opencontainers.image.revision": revision},
        },
    }


def make_env_text(**overrides: str) -> str:
    values = {
        "HOST_URL": "https://sign-staging.lexyalgo.com",
        "SMTP_ENABLE": "true",
        "SMTP_HOST": "mailpit",
        "SMTP_PORT": "1025",
        "SMTP_PASS": SECRET_VALUE,
        "MASTER_KEY": SECRET_VALUE,
        "VITE_SUPABASE_ANON_KEY": SECRET_VALUE,
        "VITE_SUPABASE_URL": "https://example.supabase.co",
    }
    values.update(overrides)
    return "".join(f"{k}={v}\n" for k, v in values.items())


def make_harness(
    tmp: Path,
    *,
    target: str = "staging",
    env_overrides: dict[str, str] | None = None,
    http: dict[str, str] | None = None,
    fail_on: str | None = None,
    mismatch_after_up: bool = False,
    with_backup: bool = True,
    with_env: bool = True,
    extra_env: dict[str, str] | None = None,
) -> dict[str, Path | str]:
    root = tmp / target
    deploy = root / "deploy" / "lexysign"
    deploy.mkdir(parents=True)
    backups = root / "backups"
    backups.mkdir(parents=True)
    caddy = deploy / "Caddyfile"
    caddy.write_text("shared-caddy-must-not-change\n", encoding="utf-8")
    (deploy / "docker-compose.runtime.yml").write_text("name: fixture\n", encoding="utf-8")
    if with_env:
        (deploy / ".env").write_text(make_env_text(**(env_overrides or {})), encoding="utf-8")
        (deploy / ".env").chmod(0o600)
    if with_backup and target == "staging":
        mongo = backups / "mongo.archive"
        files = backups / "files.tgz"
        mongo.write_bytes(b"MONGO-DUMP")
        files.write_bytes(b"FILES-BACKUP")
        (deploy / ".backup-manifest.json").write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "created_at": "2026-09-15T00:00:00Z",
                    "mongo_dump": str(mongo),
                    "files_backup": str(files),
                    "image_swap_reverts_schema": False,
                }
            )
            + "\n",
            encoding="utf-8",
        )

    if target == "staging":
        client = "lexysign-staging-client"
        server = "lexysign-staging-server"
        mongo_c = "lexysign-staging-mongo"
        public_url = "https://sign-staging.lexyalgo.com"
        project = "lexysign-staging"
        image_tag = STAGING_TAG
        old_client = f"ghcr.io/peacockesq/lexysign-client:staging-{OLD_SHA[:12]}"
        old_server = f"ghcr.io/peacockesq/lexysign-server:staging-{OLD_SHA[:12]}"
    else:
        client = "lexysign-client"
        server = "lexysign-server"
        mongo_c = "lexysign-mongo"
        public_url = "https://sign.lexyalgo.com"
        project = "lexysign"
        image_tag = PROD_TAG
        old_client = f"ghcr.io/peacockesq/lexysign-client:prod-{OLD_SHA[:12]}"
        old_server = f"ghcr.io/peacockesq/lexysign-server:prod-{OLD_SHA[:12]}"

    fakebin = tmp / "fakebin"
    fakebin.mkdir()
    write_exec(fakebin / "docker", FAKE_DOCKER)
    write_exec(fakebin / "curl", FAKE_CURL)
    write_exec(fakebin / "timeout", FAKE_TIMEOUT)

    http_map = http or {
        f"{public_url}/": "200",
        f"{public_url}/api/billing/status": "401",
    }
    state = {
        "log": [],
        "fail_on": fail_on,
        "mismatch_after_up": mismatch_after_up,
        "next_image_tag": image_tag,
        "next_revision": SHA,
        "image_owner": "peacockesq",
        "registry": "ghcr.io",
        "service_containers": {"client": client, "server": server},
        "http": http_map,
        "containers": {
            client: container_doc(old_client, OLD_SHA, "old-client"),
            server: container_doc(old_server, OLD_SHA, "old-server"),
        },
    }
    state_path = tmp / "fake-state.json"
    state_path.write_text(json.dumps(state), encoding="utf-8")

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fakebin}:{env.get('PATH', '')}",
            "FAKE_STATE": str(state_path),
            "LEXYSIGN_APP_RELEASE_TEST": "1",
            "LEXYSIGN_SKIP_DOCKER_LOGIN": "1",
            "LEXYSIGN_HTTP_RETRIES": "1",
            "LEXYSIGN_HTTP_RETRY_DELAY": "0",
            "LEXYSIGN_HTTP_MAX_TIME": "2",
            "LEXYSIGN_PULL_TIMEOUT": "5",
            "LEXYSIGN_UP_TIMEOUT": "5",
            "TARGET": target,
            "GITHUB_SHA": SHA,
            "GITHUB_RUN_ID": "test-run",
            "IMAGE_TAG": image_tag,
            "PUBLIC_URL": public_url,
            "PROJECT_NAME": project,
            "DEPLOY_PATH": str(root),
            "CLIENT_CONTAINER": client,
            "SERVER_CONTAINER": server,
            "MONGO_CONTAINER": mongo_c,
            "NETWORK_NAME": "unused",
        }
    )
    if extra_env:
        env.update(extra_env)
    return {
        "env": env,
        "deploy": deploy,
        "caddy": caddy,
        "state": state_path,
        "root": root,
        "client": client,
        "server": server,
    }


def run_helper(harness: dict, mode: str = "release") -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(HELPER_PY), mode],
        env=harness["env"],
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=str(REPO_ROOT),
        timeout=20,
    )


def docker_log(harness: dict) -> list[list[str]]:
    return json.loads(Path(harness["state"]).read_text())["log"]


def expect_raises(fn, exc_type, substr: str) -> None:
    try:
        fn()
    except exc_type as exc:
        if substr not in str(exc):
            raise AssertionError(f"expected {substr!r} in {exc}") from exc
        return
    raise AssertionError(f"{exc_type.__name__} was not raised")


@test("smtp_fail_ses_host")
def _():
    expect_raises(
        lambda: app.validate_staging_smtp(
            {"SMTP_HOST": "email-smtp.us-east-1.amazonaws.com", "SMTP_PORT": "587", "SMTP_ENABLE": "true"}
        ),
        app.ReleaseError,
        "production SES",
    )


@test("smtp_fail_ses_default_alias")
def _():
    expect_raises(
        lambda: app.validate_staging_smtp(
            {"SMTP_HOST": "email-smtp.us-east-1.amazonaws.com", "SMTP_PORT": "587", "SMTP_ENABLE": "false"}
        ),
        app.ReleaseError,
        "not prepared",
    )


@test("smtp_fail_missing_host")
def _():
    expect_raises(lambda: app.validate_staging_smtp({}), app.ReleaseError, "missing or empty")


@test("smtp_fail_empty_host")
def _():
    expect_raises(
        lambda: app.validate_staging_smtp({"SMTP_HOST": "", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"}),
        app.ReleaseError,
        "missing or empty",
    )


@test("smtp_fail_unlisted_gmail_no_allowlist_bypass")
def _():
    expect_raises(
        lambda: app.validate_staging_smtp(
            {"SMTP_HOST": "smtp.gmail.com", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"}
        ),
        app.ReleaseError,
        "not a supported local test sink",
    )


@test("smtp_fail_localhost_not_identity")
def _():
    expect_raises(
        lambda: app.validate_staging_smtp(
            {"SMTP_HOST": "127.0.0.1", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"}
        ),
        app.ReleaseError,
        "not a supported local test sink",
    )


@test("smtp_fail_wrong_port")
def _():
    expect_raises(
        lambda: app.validate_staging_smtp(
            {"SMTP_HOST": "mailpit", "SMTP_PORT": "587", "SMTP_ENABLE": "true"}
        ),
        app.ReleaseError,
        "supported local sink port",
    )


@test("smtp_fail_disabled_sink")
def _():
    expect_raises(
        lambda: app.validate_staging_smtp(
            {"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "false"}
        ),
        app.ReleaseError,
        "not enabled",
    )


@test("smtp_pass_mailpit")
def _():
    app.validate_staging_smtp({"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"})


@test("smtp_pass_lexysign_staging_mailpit")
def _():
    app.validate_staging_smtp(
        {"SMTP_HOST": "lexysign-staging-mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "1"}
    )


@test("input_reject_mismatched_image_tag")
def _():
    cfg = {
        "target": "staging",
        "github_sha": SHA,
        "image_tag": "staging-aaaaaaaaaaaa",
        "public_url": "https://sign-staging.lexyalgo.com",
        "project_name": "lexysign-staging",
        "deploy_path": "/opt/lexysign-staging",
        "client_container": "lexysign-staging-client",
        "server_container": "lexysign-staging-server",
        "mongo_container": "lexysign-staging-mongo",
        "network_name": "lexysign-staging_lexysign",
    }
    os.environ["LEXYSIGN_APP_RELEASE_TEST"] = "1"
    expect_raises(lambda: app.validate_inputs(cfg), app.ReleaseError, "mismatched image tag")


@test("input_reject_floating_tag")
def _():
    os.environ["LEXYSIGN_APP_RELEASE_TEST"] = "1"
    cfg = {
        "target": "staging",
        "github_sha": SHA,
        "image_tag": "staging",
        "public_url": "https://sign-staging.lexyalgo.com",
        "project_name": "lexysign-staging",
        "deploy_path": "/tmp/x",
        "client_container": "lexysign-staging-client",
        "server_container": "lexysign-staging-server",
        "mongo_container": "lexysign-staging-mongo",
        "network_name": "lexysign-staging_lexysign",
    }
    expect_raises(lambda: app.validate_inputs(cfg), app.ReleaseError, "pinned SHA tag")


@test("input_reject_bad_target")
def _():
    expect_raises(
        lambda: app.validate_inputs({"target": "prod", "github_sha": SHA, "image_tag": STAGING_TAG}),
        app.ReleaseError,
        "invalid TARGET",
    )


@test("backup_missing_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        path = Path(raw) / "missing.json"
        expect_raises(
            lambda: app.validate_backup_manifest(path, "staging"),
            app.ReleaseError,
            "Missing backup manifest",
        )


@test("backup_empty_archive_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        empty = root / "mongo.archive"
        empty.write_bytes(b"")
        files = root / "files.tgz"
        files.write_bytes(b"data")
        manifest = root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "created_at": "2026-09-15T00:00:00Z",
                    "mongo_dump": str(empty),
                    "files_backup": str(files),
                }
            )
        )
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, "staging"),
            app.ReleaseError,
            "missing or empty",
        )


@test("backup_image_swap_schema_claim_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        mongo = root / "mongo.archive"
        files = root / "files.tgz"
        mongo.write_bytes(b"dump")
        files.write_bytes(b"files")
        manifest = root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "created_at": "2026-09-15T00:00:00Z",
                    "mongo_dump": str(mongo),
                    "files_backup": str(files),
                    "image_swap_reverts_schema": True,
                }
            )
        )
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, "staging"),
            app.ReleaseError,
            "image_swap_reverts_schema",
        )


@test("backup_valid_passes")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        mongo = root / "mongo.archive"
        files = root / "files.tgz"
        mongo.write_bytes(b"dump")
        files.write_bytes(b"files")
        manifest = root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "created_at": "2026-09-15T00:00:00Z",
                    "mongo_dump": str(mongo),
                    "files_backup": str(files),
                }
            )
        )
        data = app.validate_backup_manifest(manifest, "staging")
        assert data["mongo_dump"] == str(mongo)


@test("docker_guard_refuses_caddy")
def _():
    cfg = {"client_container": "c1", "server_container": "s1"}
    expect_raises(
        lambda: app.assert_app_only_docker(["exec", "lexysign-caddy", "caddy", "reload"], cfg),
        app.ReleaseError,
        "Caddy",
    )


@test("docker_guard_refuses_remove_orphans")
def _():
    cfg = {"client_container": "c1", "server_container": "s1"}
    expect_raises(
        lambda: app.assert_app_only_docker(
            ["compose", "up", "-d", "--no-deps", "--remove-orphans", "server", "client"],
            cfg,
        ),
        app.ReleaseError,
        "Caddy or orphans",
    )


@test("docker_guard_refuses_mongo_up")
def _():
    cfg = {"client_container": "c1", "server_container": "s1"}
    expect_raises(
        lambda: app.assert_app_only_docker(
            ["compose", "up", "-d", "--no-deps", "mongo"],
            cfg,
        ),
        app.ReleaseError,
        "mongo",
    )


@test("docker_guard_refuses_up_without_no_deps")
def _():
    cfg = {"client_container": "c1", "server_container": "s1"}
    expect_raises(
        lambda: app.assert_app_only_docker(["compose", "up", "-d", "server", "client"], cfg),
        app.ReleaseError,
        "--no-deps",
    )


@test("docker_guard_allows_app_up")
def _():
    cfg = {"client_container": "c1", "server_container": "s1"}
    app.assert_app_only_docker(
        ["compose", "--env-file", ".env", "up", "-d", "--no-deps", "--force-recreate", "server", "client"],
        cfg,
    )


@test("smoke_http_accepts_401_not_5xx")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw))
        proc = run_helper(harness, "smoke-http")
        assert proc.returncode == 0, proc.stderr


@test("smoke_http_home_5xx_is_failure")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            http={
                "https://sign-staging.lexyalgo.com/": "500",
                "https://sign-staging.lexyalgo.com/api/billing/status": "401",
            },
        )
        proc = run_helper(harness, "smoke-http")
        assert proc.returncode == 26, proc.stderr
        assert "backend death" in proc.stderr


@test("smoke_http_billing_5xx_is_failure")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            http={
                "https://sign-staging.lexyalgo.com/": "200",
                "https://sign-staging.lexyalgo.com/api/billing/status": "502",
            },
        )
        proc = run_helper(harness, "smoke-http")
        assert proc.returncode == 26, proc.stderr
        assert "not the unauthenticated 401" in proc.stderr


@test("smoke_http_billing_200_not_unconditional_success")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            http={
                "https://sign-staging.lexyalgo.com/": "200",
                "https://sign-staging.lexyalgo.com/api/billing/status": "200",
            },
        )
        proc = run_helper(harness, "smoke-http")
        assert proc.returncode == 26, proc.stderr
        assert "expected unauthenticated 401" in proc.stderr


@test("release_staging_success_does_not_touch_caddy_or_mongo")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw))
        before = Path(harness["caddy"]).read_bytes()
        proc = run_helper(harness)
        assert proc.returncode == 0, proc.stderr
        assert Path(harness["caddy"]).read_bytes() == before
        log = docker_log(harness)
        flat = [" ".join(x) for x in log]
        joined = "\n".join(flat).lower()
        assert "caddy" not in joined
        assert "network" not in joined
        assert "--remove-orphans" not in joined
        assert " rm " not in f" {joined} "
        ups = [x for x in log if "up" in x]
        assert len(ups) == 1
        assert "--no-deps" in ups[0]
        assert ups[0][-2:] == ["server", "client"]
        assert "mongo" not in ups[0]
        pulls = [x for x in log if "pull" in x]
        assert pulls[0][-1] == "server"
        assert pulls[1][-1] == "client"
        assert SECRET_VALUE not in proc.stdout + proc.stderr
        meta = json.loads((Path(harness["deploy"]) / ".rollback-meta.json").read_text())
        assert set(meta["containers"]) == {"client", "server"}
        assert "caddy" not in json.dumps(meta)
        assert "mongo" not in json.dumps(meta["containers"])
        assert "does not revert" in meta["warning"]
        env_text = (Path(harness["deploy"]) / ".env").read_text()
        assert SECRET_VALUE in env_text
        assert "VITE_SUPABASE_ANON_KEY" in env_text


@test("release_staging_ses_fails_before_compose_up")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            env_overrides={
                "SMTP_HOST": "email-smtp.us-east-1.amazonaws.com",
                "SMTP_PORT": "587",
                "SMTP_ENABLE": "true",
            },
        )
        proc = run_helper(harness)
        assert proc.returncode == 22, proc.stderr
        assert "not prepared" in proc.stderr
        log = docker_log(harness)
        assert not any("up" in x or "pull" in x for x in log)


@test("release_staging_missing_backup_fails_before_mutation")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), with_backup=False)
        proc = run_helper(harness)
        assert proc.returncode == 23, proc.stderr
        assert "Missing backup manifest" in proc.stderr
        assert "does not roll back schema" in proc.stderr
        log = docker_log(harness)
        assert not any("up" in x or "pull" in x for x in log)


@test("release_missing_env_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), with_env=False)
        proc = run_helper(harness)
        assert proc.returncode == 20, proc.stderr


@test("release_pull_failure_propagates")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), fail_on="pull")
        proc = run_helper(harness)
        assert proc.returncode != 0
        assert proc.returncode != 22
        log = docker_log(harness)
        assert any("pull" in x for x in log)
        assert not any("up" in x for x in log)


@test("release_up_failure_propagates")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), fail_on="up")
        proc = run_helper(harness)
        assert proc.returncode != 0
        assert "command failed" in proc.stderr


@test("release_image_mismatch_after_up_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), mismatch_after_up=True)
        proc = run_helper(harness)
        assert proc.returncode == 25, proc.stderr
        assert "does not match pinned" in proc.stderr


@test("release_production_allows_ses_without_staging_sink")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            target="production",
            env_overrides={
                "HOST_URL": "https://sign.lexyalgo.com",
                "SMTP_HOST": "email-smtp.us-east-1.amazonaws.com",
                "SMTP_PORT": "587",
                "SMTP_ENABLE": "true",
            },
            with_backup=False,
        )
        proc = run_helper(harness)
        assert proc.returncode == 0, proc.stderr
        log = docker_log(harness)
        joined = " ".join(" ".join(x) for x in log).lower()
        assert "caddy" not in joined
        assert "--remove-orphans" not in joined
        ups = [x for x in log if "up" in x]
        assert ups[0][-2:] == ["server", "client"]


@test("release_command_via_bash_wrapper")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw))
        proc = subprocess.run(
            ["bash", str(HELPER_SH), "release"],
            env=harness["env"],
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=20,
        )
        assert proc.returncode == 0, proc.stderr


@test("workflow_yaml_parses_and_stays_app_only")
def _():
    import yaml

    text = WORKFLOW.read_text(encoding="utf-8")
    data = yaml.safe_load(text)
    assert data["name"] == "Deploy LexySign"
    assert "jobs" in data
    assert "timeout-minutes" in data["jobs"]["deploy"]
    assert data["jobs"]["deploy"]["timeout-minutes"] == 35
    assert "deploy/lexysign/Caddyfile" not in text
    assert "COMPOSE_PROFILES" not in text
    assert "--remove-orphans" not in text
    assert "docker rm -f" not in text
    assert "caddy reload" not in text
    assert "caddy validate" not in text
    assert "network connect" not in text
    assert "VITE_SUPABASE" not in text
    assert "lexysign-app-release.py" in text
    assert "REACT_APP_SERVERURL" in text
    assert "org.opencontainers.image.revision=${{ github.sha }}" in text


@test("caddyfile_bytes_unchanged")
def _():
    import hashlib

    digest = hashlib.sha256(CADDYFILE.read_bytes()).hexdigest()
    assert digest == KNOWN_CADDY_SHA256


@test("helper_source_does_not_stage_caddyfile")
def _():
    text = HELPER_PY.read_text(encoding="utf-8")
    assert "Caddyfile" not in text
    assert "--remove-orphans" in text  # only as a forbidden token
    assert "COMPOSE_PROFILES=edge" not in text


def main() -> int:
    for name, fn in TESTS:
        try:
            fn()
        except Exception:
            RESULTS.record(name, False, traceback.format_exc())
        else:
            RESULTS.record(name, True)
    print(f"Ran {RESULTS.passed + RESULTS.failed} tests: {RESULTS.passed} passed, {RESULTS.failed} failed")
    if RESULTS.failures:
        print("\n".join(RESULTS.failures))
        return 1
    return 0


if __name__ == "__main__":
    # Tests are registered at import via @test.
    sys.exit(main())
