#!/usr/bin/env python3
"""Executable tests for LexySign app-only release.

Uses a fake command environment. No Docker daemon, SSH, or network I/O.
"""

from __future__ import annotations

import gzip
import hashlib
import importlib.util
import io
import json
import os
import stat
import subprocess
import sys
import tarfile
import tempfile
import traceback
from datetime import datetime, timezone
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
NOW = datetime(2026, 9, 15, 12, 0, tzinfo=timezone.utc)

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
if fail == "config" and "config" in argv:
    state_path.write_text(json.dumps(state))
    sys.exit(11)
if fail == "pull" and "pull" in argv:
    state_path.write_text(json.dumps(state))
    sys.exit(13)
if fail == "up" and "up" in argv:
    state_path.write_text(json.dumps(state))
    sys.exit(17)
if argv[:1] == ["login"]:
    state_path.write_text(json.dumps(state))
    sys.exit(0)
if "config" in argv:
    sys.stdout.write(json.dumps(state.get("compose_config") or {}))
    state_path.write_text(json.dumps(state))
    sys.exit(0)
if argv[:2] == ["image", "inspect"]:
    ref = argv[-1]
    doc = (state.get("images") or {}).get(ref)
    if not doc:
        state_path.write_text(json.dumps(state))
        sys.exit(1)
    sys.stdout.write(json.dumps([doc]))
    state_path.write_text(json.dumps(state))
    sys.exit(0)
if argv[:1] == ["inspect"]:
    name = argv[-1]
    doc = state.get("containers", {}).get(name)
    if not doc:
        state_path.write_text(json.dumps(state))
        sys.exit(1)
    seq = (state.get("health_seq") or {}).get(name)
    if seq and state.get("released"):
        idx_map = state.setdefault("health_idx", {})
        idx = idx_map.get(name, 0)
        status = seq[min(idx, len(seq) - 1)]
        idx_map[name] = idx + 1
        doc = json.loads(json.dumps(doc))
        doc.setdefault("State", {}).setdefault("Health", {})["Status"] = status
    sys.stdout.write(json.dumps([doc]))
    state_path.write_text(json.dumps(state))
    sys.exit(0)
if "pull" in argv:
    image_tag = state.get("next_image_tag")
    revision = state.get("next_revision")
    target = state.get("target")
    owner = state.get("image_owner", "peacockesq")
    registry = state.get("registry", "ghcr.io")
    images = state.setdefault("images", {})
    for kind in ("server", "client"):
        ref = f"{registry}/{owner}/lexysign-{kind}:{image_tag}"
        images[ref] = {
            "Id": f"sha256:pulled-{kind}",
            "RepoDigests": [f"{registry}/{owner}/lexysign-{kind}@sha256:digest-{kind}"],
            "Config": {
                "Labels": {
                    "org.opencontainers.image.revision": revision,
                    "com.lexysign.environment": target,
                }
            },
        }
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
            doc = state["containers"][name]
            doc["Config"]["Image"] = f"{registry}/{owner}/lexysign-{service}:{image_tag}"
            doc["Config"]["Labels"]["org.opencontainers.image.revision"] = revision
            doc["Id"] = f"new-{service}-id"
            doc["Image"] = f"sha256:pulled-{service}"
            doc["State"]["Running"] = True
            doc["State"]["Status"] = "running"
            doc["State"]["Restarting"] = False
            doc["State"]["Dead"] = False
            doc["State"]["Health"] = {"Status": "healthy"}
    if state.get("health_seq"):
        state["released"] = True
    if state.get("mismatch_after_up"):
        for doc in state.get("containers", {}).values():
            doc["Config"]["Image"] = "ghcr.io/peacockesq/lexysign-client:wrong-tag"
            doc["Image"] = "sha256:wrong"
            doc["Config"]["Labels"]["org.opencontainers.image.revision"] = "deadbeef"
    if state.get("exited_after_up"):
        for service, name in mapping.items():
            doc = state["containers"][name]
            doc["State"]["Running"] = False
            doc["State"]["Status"] = "exited"
            doc["State"]["Health"] = {"Status": "unhealthy"}
    state_path.write_text(json.dumps(state))
    sys.exit(0)
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
sys.exit(int(state.get("curl_exit", {}).get(url, 0)))
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


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


NATIVE_MONGO_MAGIC = bytes.fromhex("6de29981")


def write_mongo_archive(path: Path, payload: bytes | None = None) -> None:
    if payload is None:
        payload = NATIVE_MONGO_MAGIC + b"\x00archive"
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wb") as handle:
        handle.write(payload)


def write_files_tar(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        data = b"signed-doc"
        info = tarfile.TarInfo(name="files/doc.pdf")
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    path.write_bytes(buffer.getvalue())


def identity(target: str) -> dict[str, str]:
    if target == "production":
        return {
            "public_url": "https://sign.lexyalgo.com",
            "project_name": "lexysign",
            "client_container": "lexysign-client",
            "server_container": "lexysign-server",
            "mongo_container": "lexysign-mongo",
            "network_name": "lexysign_lexysign",
            "files_volume": "lexysign_lexysign-files",
            "mongo_volume": "lexysign_lexysign-mongo",
            "image_tag": PROD_TAG,
        }
    return {
        "public_url": "https://sign-staging.lexyalgo.com",
        "project_name": "lexysign-staging",
        "client_container": "lexysign-staging-client",
        "server_container": "lexysign-staging-server",
        "mongo_container": "lexysign-staging-mongo",
        "network_name": "lexysign-staging_lexysign",
        "files_volume": "lexysign-staging_lexysign-files",
        "mongo_volume": "lexysign-staging_lexysign-mongo",
        "image_tag": STAGING_TAG,
    }


def cfg_for(target: str, deploy_path: str) -> dict[str, str]:
    ident = identity(target)
    return {
        "target": target,
        "github_sha": SHA,
        "github_run_id": "test-run",
        "image_tag": ident["image_tag"],
        "public_url": ident["public_url"],
        "project_name": ident["project_name"],
        "deploy_path": deploy_path,
        "client_container": ident["client_container"],
        "server_container": ident["server_container"],
        "mongo_container": ident["mongo_container"],
        "network_name": ident["network_name"],
        "files_volume": ident["files_volume"],
        "registry": "ghcr.io",
        "image_owner": "peacockesq",
        "compose_file": "docker-compose.runtime.yml",
    }


def write_valid_backup(deploy_path: Path, target: str, created_at: str = "2026-09-15T11:00:00Z") -> Path:
    ident = identity(target)
    backups = deploy_path / "backups" / "20260915"
    mongo = backups / "mongo.archive.gz"
    files = backups / "files.tgz"
    write_mongo_archive(mongo)
    write_files_tar(files)
    mongo_bytes = mongo.read_bytes()
    files_bytes = files.read_bytes()
    manifest = deploy_path / "deploy" / "lexysign" / ".backup-manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)
    manifest.write_text(
        json.dumps(
            {
                "environment": target,
                "created_at": created_at,
                "image_swap_reverts_schema": False,
                "mongo_dump": str(mongo),
                "files_backup": str(files),
                "mongo_dump_sha256": sha256_bytes(mongo_bytes),
                "mongo_dump_bytes": len(mongo_bytes),
                "files_backup_sha256": sha256_bytes(files_bytes),
                "files_backup_bytes": len(files_bytes),
                "source": {
                    "project_name": ident["project_name"],
                    "mongo_container": ident["mongo_container"],
                    "files_volume": ident["files_volume"],
                    "network_name": ident["network_name"],
                },
            }
        )
        + "\n",
        encoding="utf-8",
    )
    return manifest


def container_doc(
    image: str,
    revision: str,
    ident: str,
    network: str,
    *,
    volume_name: str | None = None,
    running: bool = True,
    env: list[str] | None = None,
    ports: dict | None = None,
) -> dict:
    mounts = []
    if volume_name:
        mounts.append({"Destination": "/usr/src/app/files", "Name": volume_name})
    return {
        "Id": ident,
        "Image": f"sha256:{ident}",
        "State": {
            "Running": running,
            "Status": "running" if running else "exited",
            "Restarting": False,
            "Dead": False,
            "Health": {"Status": "healthy"} if running else {},
        },
        "HostConfig": {"Privileged": False, "NetworkMode": network, "PortBindings": ports or {}},
        "Config": {
            "Image": image,
            "Labels": {
                "org.opencontainers.image.revision": revision,
            },
            "Env": env or [],
            "ExposedPorts": {key: {} for key in (ports or {})},
        },
        "Mounts": mounts,
        "NetworkSettings": {
            "Networks": {network: {}},
            "Ports": ports or {},
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


def compose_config_for(target: str, image_tag: str, smtp: dict[str, str], *, server_name: str | None = None) -> dict:
    ident = identity(target)
    server_container = server_name or ident["server_container"]
    return {
        "name": ident["project_name"],
        "networks": {
            "lexysign": {"name": ident["network_name"]},
        },
        "volumes": {
            "lexysign-files": {"name": ident["files_volume"]},
            "lexysign-mongo": {"name": ident["mongo_volume"]},
        },
        "services": {
            "server": {
                "image": f"ghcr.io/peacockesq/lexysign-server:{image_tag}",
                "container_name": server_container,
                "environment": {
                    "MONGODB_URI": "mongodb://mongo:27017/lexysign",
                    "SMTP_HOST": smtp.get("SMTP_HOST", "mailpit"),
                    "SMTP_PORT": smtp.get("SMTP_PORT", "1025"),
                    "SMTP_ENABLE": smtp.get("SMTP_ENABLE", "true"),
                },
                "volumes": [
                    {
                        "type": "volume",
                        "source": "lexysign-files",
                        "target": "/usr/src/app/files",
                    }
                ],
                "networks": {"lexysign": None},
                "privileged": False,
            },
            "client": {
                "image": f"ghcr.io/peacockesq/lexysign-client:{image_tag}",
                "container_name": ident["client_container"],
                "networks": {"lexysign": None},
                "privileged": False,
                "volumes": [],
            },
            "mongo": {
                "image": "mongo:7.0",
                "container_name": ident["mongo_container"],
                "volumes": [
                    {
                        "type": "volume",
                        "source": "lexysign-mongo",
                        "target": "/data/db",
                    }
                ],
                "networks": {"lexysign": None},
            },
        },
    }


def make_harness(
    tmp: Path,
    *,
    target: str = "staging",
    env_overrides: dict[str, str] | None = None,
    http: dict[str, str] | None = None,
    fail_on: str | None = None,
    mismatch_after_up: bool = False,
    exited_after_up: bool = False,
    with_backup: bool = True,
    with_env: bool = True,
    extra_env: dict[str, str] | None = None,
    compose_smtp: dict[str, str] | None = None,
    server_container_name: str | None = None,
    mailpit_relay: str | None = None,
    curl_exit: dict[str, int] | None = None,
    prior_deploy_env: str | None = None,
    health_seq: dict[str, list[str]] | None = None,
) -> dict:
    ident = identity(target)
    fsroot = tmp / "fsroot"
    deploy_path = fsroot / "opt" / ("lexysign" if target == "production" else "lexysign-staging")
    deploy = deploy_path / "deploy" / "lexysign"
    deploy.mkdir(parents=True)
    caddy = deploy / "Caddyfile"
    caddy.write_text("shared-caddy-must-not-change\n", encoding="utf-8")
    (deploy / "docker-compose.runtime.yml").write_text("name: fixture\n", encoding="utf-8")
    env_overrides = env_overrides or {}
    if with_env:
        if target == "production" and "HOST_URL" not in env_overrides:
            env_overrides = {
                "HOST_URL": ident["public_url"],
                "SMTP_HOST": "email-smtp.us-east-1.amazonaws.com",
                "SMTP_PORT": "587",
                "SMTP_ENABLE": "true",
                **env_overrides,
            }
        (deploy / ".env").write_text(make_env_text(**env_overrides), encoding="utf-8")
        (deploy / ".env").chmod(0o600)
    if prior_deploy_env is not None:
        (deploy / ".deploy.env").write_text(prior_deploy_env, encoding="utf-8")
    if with_backup:
        write_valid_backup(deploy_path, target)

    smtp = compose_smtp or {
        "SMTP_HOST": env_overrides.get("SMTP_HOST", "mailpit" if target == "staging" else "email-smtp.us-east-1.amazonaws.com"),
        "SMTP_PORT": env_overrides.get("SMTP_PORT", "1025" if target == "staging" else "587"),
        "SMTP_ENABLE": env_overrides.get("SMTP_ENABLE", "true"),
    }
    client = ident["client_container"]
    server = ident["server_container"]
    network = ident["network_name"]
    image_tag = ident["image_tag"]
    old_client = f"ghcr.io/peacockesq/lexysign-client:{('prod' if target == 'production' else 'staging')}-{OLD_SHA[:12]}"
    old_server = f"ghcr.io/peacockesq/lexysign-server:{('prod' if target == 'production' else 'staging')}-{OLD_SHA[:12]}"

    fakebin = tmp / "fakebin"
    fakebin.mkdir()
    write_exec(fakebin / "docker", FAKE_DOCKER)
    write_exec(fakebin / "curl", FAKE_CURL)
    write_exec(fakebin / "timeout", FAKE_TIMEOUT)

    public_url = ident["public_url"]
    http_map = http or {
        f"{public_url}/": "200",
        f"{public_url}/api/billing/status": "401",
    }
    mailpit_env = []
    if mailpit_relay:
        mailpit_env.append(f"MP_SMTP_RELAY_HOST={mailpit_relay}")
    containers = {
        client: container_doc(old_client, OLD_SHA, "old-client", network, running=True),
        server: container_doc(
            old_server,
            OLD_SHA,
            "old-server",
            network,
            volume_name=ident["files_volume"],
            running=True,
        ),
    }
    if target == "staging":
        containers["mailpit"] = container_doc(
            "axllent/mailpit",
            "mailpit",
            "mailpit-id",
            network,
            running=True,
            env=mailpit_env,
            ports={"1025/tcp": [{"HostPort": "1025"}]},
        )
        containers["lexysign-staging-mailpit"] = containers["mailpit"]
    state = {
        "log": [],
        "fail_on": fail_on,
        "mismatch_after_up": mismatch_after_up,
        "exited_after_up": exited_after_up,
        "next_image_tag": image_tag,
        "next_revision": SHA,
        "target": target,
        "image_owner": "peacockesq",
        "registry": "ghcr.io",
        "service_containers": {"client": client, "server": server},
        "http": http_map,
        "curl_exit": curl_exit or {},
        "health_seq": health_seq or {},
        "compose_config": compose_config_for(target, image_tag, smtp, server_name=server_container_name),
        "containers": containers,
        "images": {},
    }
    state_path = tmp / "fake-state.json"
    state_path.write_text(json.dumps(state), encoding="utf-8")

    env = os.environ.copy()
    env.update(
        {
            "PATH": f"{fakebin}:{env.get('PATH', '')}",
            "FAKE_STATE": str(state_path),
            "LEXYSIGN_DEPLOY_ROOT": str(fsroot),
            "LEXYSIGN_REGISTRY_USER": "ci-user",
            "LEXYSIGN_REGISTRY_TOKEN": "ci-token",
            "LEXYSIGN_HTTP_RETRIES": "1",
            "LEXYSIGN_HTTP_RETRY_DELAY": "0",
            "LEXYSIGN_HTTP_MAX_TIME": "2",
            "LEXYSIGN_PULL_TIMEOUT": "5",
            "LEXYSIGN_UP_TIMEOUT": "5",
            "LEXYSIGN_HEALTH_TIMEOUT": "2",
            "LEXYSIGN_HEALTH_POLL": "0",
            "TARGET": target,
            "GITHUB_SHA": SHA,
            "GITHUB_RUN_ID": "test-run",
            "IMAGE_TAG": image_tag,
            "PUBLIC_URL": public_url,
            "PROJECT_NAME": ident["project_name"],
            "DEPLOY_PATH": str(deploy_path),
            "CLIENT_CONTAINER": client,
            "SERVER_CONTAINER": server,
            "MONGO_CONTAINER": ident["mongo_container"],
            "NETWORK_NAME": network,
            "LEXYSIGN_FILES_VOLUME": ident["files_volume"],
        }
    )
    env.pop("LEXYSIGN_APP_RELEASE_TEST", None)
    env.pop("LEXYSIGN_SKIP_DOCKER_LOGIN", None)
    if extra_env:
        env.update(extra_env)
    return {
        "env": env,
        "deploy": deploy,
        "caddy": caddy,
        "state": state_path,
        "root": deploy_path,
        "fsroot": fsroot,
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
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    cfg["image_tag"] = "staging-aaaaaaaaaaaa"
    expect_raises(lambda: app.validate_inputs(cfg), app.ReleaseError, "mismatched image tag")


@test("input_reject_floating_tag")
def _():
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    cfg["image_tag"] = "staging"
    expect_raises(lambda: app.validate_inputs(cfg), app.ReleaseError, "pinned SHA tag")


@test("input_reject_bad_target")
def _():
    expect_raises(
        lambda: app.validate_inputs({"target": "prod", "github_sha": SHA, "image_tag": STAGING_TAG}),
        app.ReleaseError,
        "invalid TARGET",
    )


@test("input_reject_uppercase_sha")
def _():
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    cfg["github_sha"] = SHA.upper()
    expect_raises(lambda: app.validate_inputs(cfg), app.ReleaseError, "literal 40-character lowercase")


@test("test_flag_does_not_bypass_production_paths")
def _():
    os.environ["LEXYSIGN_APP_RELEASE_TEST"] = "1"
    cfg = cfg_for("production", "/tmp/not-production")
    expect_raises(lambda: app.validate_inputs(cfg), app.ReleaseError, "deploy_path")
    os.environ.pop("LEXYSIGN_APP_RELEASE_TEST", None)


@test("backup_missing_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        expect_raises(
            lambda: app.validate_backup_manifest(root / "missing.json", cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "Missing backup manifest",
        )


@test("backup_junk_bytes_fail")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        backups = root / "backups"
        junk = backups / "mongo.archive.gz"
        files = backups / "files.tgz"
        junk.parent.mkdir(parents=True)
        junk.write_bytes(b"not an archive")
        write_files_tar(files)
        manifest = root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "created_at": "2026-09-15T11:00:00Z",
                    "image_swap_reverts_schema": False,
                    "mongo_dump": str(junk),
                    "files_backup": str(files),
                    "mongo_dump_sha256": sha256_bytes(junk.read_bytes()),
                    "mongo_dump_bytes": junk.stat().st_size,
                    "files_backup_sha256": sha256_bytes(files.read_bytes()),
                    "files_backup_bytes": files.stat().st_size,
                    "source": {
                        "project_name": "lexysign-staging",
                        "mongo_container": "lexysign-staging-mongo",
                        "files_volume": "lexysign-staging_lexysign-files",
                        "network_name": "lexysign-staging_lexysign",
                    },
                }
            )
        )
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "gzip magic",
        )


@test("backup_not_a_date_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "staging", created_at="not-a-date")
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "ISO-8601",
        )


@test("backup_missing_explicit_false_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "staging")
        data = json.loads(manifest.read_text())
        del data["image_swap_reverts_schema"]
        manifest.write_text(json.dumps(data))
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "image_swap_reverts_schema",
        )


@test("backup_empty_archive_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        empty = root / "backups" / "mongo.archive.gz"
        empty.parent.mkdir(parents=True)
        empty.write_bytes(b"")
        files = root / "backups" / "files.tgz"
        write_files_tar(files)
        manifest = root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "created_at": "2026-09-15T11:00:00Z",
                    "image_swap_reverts_schema": False,
                    "mongo_dump": str(empty),
                    "files_backup": str(files),
                    "mongo_dump_sha256": sha256_bytes(b""),
                    "mongo_dump_bytes": 0,
                    "files_backup_sha256": sha256_bytes(files.read_bytes()),
                    "files_backup_bytes": files.stat().st_size,
                    "source": {
                        "project_name": "lexysign-staging",
                        "mongo_container": "lexysign-staging-mongo",
                        "files_volume": "lexysign-staging_lexysign-files",
                        "network_name": "lexysign-staging_lexysign",
                    },
                }
            )
        )
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "empty",
        )


@test("backup_image_swap_schema_claim_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "staging")
        data = json.loads(manifest.read_text())
        data["image_swap_reverts_schema"] = True
        manifest.write_text(json.dumps(data))
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "image_swap_reverts_schema",
        )


@test("backup_hash_mismatch_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "staging")
        data = json.loads(manifest.read_text())
        data["mongo_dump_sha256"] = "0" * 64
        manifest.write_text(json.dumps(data))
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "does not match file readback",
        )


@test("backup_stale_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "staging", created_at="2026-09-01T00:00:00Z")
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "stale",
        )


@test("backup_future_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "staging", created_at="2026-09-16T12:00:00Z")
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "future",
        )


@test("backup_wrong_target_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "production")
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "does not match TARGET",
        )


@test("backup_truncated_gzip_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        backups = root / "backups"
        mongo = backups / "mongo.archive.gz"
        files = backups / "files.tgz"
        mongo.parent.mkdir(parents=True)
        mongo.write_bytes(b"\x1f\x8b")
        write_files_tar(files)
        manifest = root / "manifest.json"
        manifest.write_text(
            json.dumps(
                {
                    "environment": "staging",
                    "created_at": "2026-09-15T11:00:00Z",
                    "image_swap_reverts_schema": False,
                    "mongo_dump": str(mongo),
                    "files_backup": str(files),
                    "mongo_dump_sha256": sha256_bytes(mongo.read_bytes()),
                    "mongo_dump_bytes": mongo.stat().st_size,
                    "files_backup_sha256": sha256_bytes(files.read_bytes()),
                    "files_backup_bytes": files.stat().st_size,
                    "source": {
                        "project_name": "lexysign-staging",
                        "mongo_container": "lexysign-staging-mongo",
                        "files_volume": "lexysign-staging_lexysign-files",
                        "network_name": "lexysign-staging_lexysign",
                    },
                }
            )
        )
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "truncated",
        )


@test("backup_valid_passes")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        (root / "deploy" / "lexysign").mkdir(parents=True)
        manifest = write_valid_backup(root, "staging")
        data = app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW)
        assert data["image_swap_reverts_schema"] is False


def _staging_backup_with_mongo(root: Path, *, payload: bytes | None = None, raw_gzip: bytes | None = None) -> Path:
    (root / "deploy" / "lexysign").mkdir(parents=True, exist_ok=True)
    manifest = write_valid_backup(root, "staging")
    data = json.loads(manifest.read_text())
    mongo = Path(data["mongo_dump"])
    if raw_gzip is not None:
        mongo.write_bytes(raw_gzip)
    else:
        write_mongo_archive(mongo, payload)
    blob = mongo.read_bytes()
    data["mongo_dump_sha256"] = sha256_bytes(blob)
    data["mongo_dump_bytes"] = len(blob)
    manifest.write_text(json.dumps(data))
    return manifest


@test("backup_native_mongo_header_passes")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        manifest = _staging_backup_with_mongo(root, payload=NATIVE_MONGO_MAGIC + b"\x00" * 64)
        app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW)


@test("backup_mdmp_junk_rejected")
def _():
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        manifest = _staging_backup_with_mongo(root, payload=b"mdmp\x00junk")
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "mdmp junk",
        )


@test("backup_mongo_trailer_crc_corrupt_fails")
def _():
    payload = NATIVE_MONGO_MAGIC + (b"x" * 50000)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as handle:
        handle.write(payload)
    raw_gzip = bytearray(buf.getvalue())
    raw_gzip[-4:] = bytes(byte ^ 0xFF for byte in raw_gzip[-4:])
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        manifest = _staging_backup_with_mongo(root, raw_gzip=bytes(raw_gzip))
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "CRC-corrupt",
        )


@test("backup_mongo_tail_truncated_fails")
def _():
    payload = NATIVE_MONGO_MAGIC + (b"y" * 20000)
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb") as handle:
        handle.write(payload)
    truncated = buf.getvalue()[:-16]
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp)
        manifest = _staging_backup_with_mongo(root, raw_gzip=truncated)
        expect_raises(
            lambda: app.validate_backup_manifest(manifest, cfg_for("staging", str(root)), now=NOW),
            app.ReleaseError,
            "truncated",
        )


@test("mongo_gzip_verifier_does_not_read_whole_file")
def _():
    import inspect as pyinspect

    source = pyinspect.getsource(app._verify_mongo_gzip)
    assert "read_bytes" not in source


@test("docker_guard_refuses_caddy")
def _():
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    expect_raises(
        lambda: app.assert_app_only_docker(["exec", "lexysign-caddy", "caddy", "reload"], cfg),
        app.ReleaseError,
        "Caddy",
    )


@test("docker_guard_refuses_remove_orphans")
def _():
    cfg = cfg_for("staging", "/opt/lexysign-staging")
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
    cfg = cfg_for("staging", "/opt/lexysign-staging")
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
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    expect_raises(
        lambda: app.assert_app_only_docker(["compose", "up", "-d", "server", "client"], cfg),
        app.ReleaseError,
        "--no-deps",
    )


@test("docker_guard_allows_app_up")
def _():
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    app.assert_app_only_docker(
        ["compose", "--env-file", ".env", "up", "-d", "--no-deps", "--force-recreate", "server", "client"],
        cfg,
    )


@test("compose_scope_rejects_server_named_caddy")
def _():
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    compose = compose_config_for("staging", STAGING_TAG, {"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"}, server_name="lexysign-caddy")
    expect_raises(lambda: app.validate_compose_scope(cfg, compose), app.ReleaseError, "container_name")


@test("compose_scope_accepts_real_shaped_staging_and_production")
def _():
    staging = compose_config_for("staging", STAGING_TAG, {"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"})
    app.validate_compose_scope(cfg_for("staging", "/opt/lexysign-staging"), staging)
    production = compose_config_for(
        "production",
        PROD_TAG,
        {"SMTP_HOST": "email-smtp.us-east-1.amazonaws.com", "SMTP_PORT": "587", "SMTP_ENABLE": "true"},
    )
    app.validate_compose_scope(cfg_for("production", "/opt/lexysign"), production)


@test("compose_scope_rejects_staging_alias_to_production_volume")
def _():
    compose = compose_config_for("staging", STAGING_TAG, {"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"})
    compose["volumes"]["lexysign-files"]["name"] = "lexysign_lexysign-files"
    expect_raises(
        lambda: app.validate_compose_scope(cfg_for("staging", "/opt/lexysign-staging"), compose),
        app.ReleaseError,
        "lexysign-files",
    )


@test("compose_scope_rejects_files_alias_wrong_target")
def _():
    compose = compose_config_for("staging", STAGING_TAG, {"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"})
    compose["services"]["server"]["volumes"] = [
        {"type": "volume", "source": "lexysign-files", "target": "/var/wrong"}
    ]
    expect_raises(
        lambda: app.validate_compose_scope(cfg_for("staging", "/opt/lexysign-staging"), compose),
        app.ReleaseError,
        "exactly one persistent files mount",
    )


@test("compose_scope_rejects_conflicting_files_mounts")
def _():
    compose = compose_config_for("staging", STAGING_TAG, {"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"})
    pair = {"type": "volume", "source": "lexysign-files", "target": "/usr/src/app/files"}
    compose["services"]["server"]["volumes"] = [pair, dict(pair)]
    expect_raises(
        lambda: app.validate_compose_scope(cfg_for("staging", "/opt/lexysign-staging"), compose),
        app.ReleaseError,
        "exactly one persistent files mount",
    )


@test("compose_scope_rejects_mongo_alias_to_other_target")
def _():
    compose = compose_config_for("staging", STAGING_TAG, {"SMTP_HOST": "mailpit", "SMTP_PORT": "1025", "SMTP_ENABLE": "true"})
    compose["volumes"]["lexysign-mongo"]["name"] = "lexysign_lexysign-mongo"
    expect_raises(
        lambda: app.validate_compose_scope(cfg_for("staging", "/opt/lexysign-staging"), compose),
        app.ReleaseError,
        "lexysign-mongo",
    )


@test("live_container_exited_fails_despite_image_labels")
def _():
    cfg = cfg_for("staging", "/opt/lexysign-staging")
    candidate = {"id": "sha256:pulled-client", "digest": "sha256:digest-client", "revision": SHA, "ref": "x"}
    doc = container_doc(
        f"ghcr.io/peacockesq/lexysign-client:{STAGING_TAG}",
        SHA,
        "pulled-client",
        cfg["network_name"],
        running=False,
    )
    doc["Image"] = "sha256:pulled-client"
    expect_raises(
        lambda: app.assert_live_app_container(cfg["client_container"], doc, cfg, "client", candidate),
        app.ReleaseError,
        "not running",
    )


@test("curl_nonzero_with_printed_401_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            curl_exit={"https://sign-staging.lexyalgo.com/api/billing/status": 28},
        )
        proc = run_helper(harness, "smoke-http")
        assert proc.returncode == 26, proc.stderr
        assert "curl nonzero" in proc.stderr or "000" in proc.stderr


@test("curl_nonzero_with_printed_200_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            curl_exit={"https://sign-staging.lexyalgo.com/": 28},
        )
        proc = run_helper(harness, "smoke-http")
        assert proc.returncode == 26, proc.stderr


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
        joined = "\n".join(" ".join(x) for x in log).lower()
        assert "caddy" not in joined
        assert "network connect" not in joined
        assert "--remove-orphans" not in joined
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
        assert "does not revert" in meta["warning"]
        env_text = (Path(harness["deploy"]) / ".env").read_text()
        assert SECRET_VALUE in env_text


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
            prior_deploy_env="LEXYSIGN_IMAGE_TAG=keep-me\n",
        )
        proc = run_helper(harness)
        assert proc.returncode == 22, proc.stderr
        assert "not prepared" in proc.stderr
        log = docker_log(harness)
        assert not any("up" in x or "pull" in x for x in log)
        assert (Path(harness["deploy"]) / ".deploy.env").read_text() == "LEXYSIGN_IMAGE_TAG=keep-me\n"


@test("release_effective_ses_override_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            compose_smtp={
                "SMTP_HOST": "email-smtp.us-east-1.amazonaws.com",
                "SMTP_PORT": "587",
                "SMTP_ENABLE": "true",
            },
        )
        proc = run_helper(harness)
        assert proc.returncode == 22, proc.stderr
        log = docker_log(harness)
        assert not any("up" in x or "pull" in x for x in log)


@test("release_mailpit_relay_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), mailpit_relay="email-smtp.us-east-1.amazonaws.com")
        proc = run_helper(harness)
        assert proc.returncode == 22, proc.stderr
        assert "relay" in proc.stderr.lower()
        log = docker_log(harness)
        assert not any("up" in x or "pull" in x for x in log)


@test("release_compose_server_named_caddy_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), server_container_name="lexysign-caddy")
        proc = run_helper(harness)
        assert proc.returncode != 0
        log = docker_log(harness)
        assert not any("up" in x or "pull" in x for x in log)


@test("release_staging_missing_backup_fails_before_mutation")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), with_backup=False, prior_deploy_env="LEXYSIGN_IMAGE_TAG=keep-me\n")
        proc = run_helper(harness)
        assert proc.returncode == 23, proc.stderr
        assert "Missing backup manifest" in proc.stderr
        assert (Path(harness["deploy"]) / ".deploy.env").read_text() == "LEXYSIGN_IMAGE_TAG=keep-me\n"
        log = docker_log(harness)
        assert not any("up" in x or "pull" in x for x in log)


@test("release_missing_env_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), with_env=False)
        proc = run_helper(harness)
        assert proc.returncode == 20, proc.stderr


@test("release_pull_failure_leaves_deploy_env")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), fail_on="pull", prior_deploy_env="LEXYSIGN_IMAGE_TAG=keep-me\n")
        proc = run_helper(harness)
        assert proc.returncode != 0
        assert proc.returncode != 22
        log = docker_log(harness)
        assert any("pull" in x for x in log)
        assert not any("up" in x for x in log)
        assert (Path(harness["deploy"]) / ".deploy.env").read_text() == "LEXYSIGN_IMAGE_TAG=keep-me\n"


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


@test("release_exited_after_up_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), exited_after_up=True)
        proc = run_helper(harness)
        assert proc.returncode == 25, proc.stderr
        assert "not running" in proc.stderr


@test("release_health_starting_then_healthy")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            health_seq={
                "lexysign-staging-client": ["starting", "healthy"],
                "lexysign-staging-server": ["starting", "healthy"],
            },
            extra_env={"LEXYSIGN_HEALTH_TIMEOUT": "2", "LEXYSIGN_HEALTH_POLL": "0"},
        )
        proc = run_helper(harness)
        assert proc.returncode == 0, proc.stderr


@test("release_health_stuck_starting_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            health_seq={
                "lexysign-staging-client": ["starting"],
                "lexysign-staging-server": ["starting"],
            },
            extra_env={"LEXYSIGN_HEALTH_TIMEOUT": "0.15", "LEXYSIGN_HEALTH_POLL": "0.05"},
        )
        proc = run_helper(harness)
        assert proc.returncode == 25, proc.stderr
        assert "still starting" in proc.stderr


@test("release_health_unhealthy_fails")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            health_seq={
                "lexysign-staging-client": ["unhealthy"],
                "lexysign-staging-server": ["unhealthy"],
            },
        )
        proc = run_helper(harness)
        assert proc.returncode == 25, proc.stderr
        assert "not healthy" in proc.stderr


@test("release_health_mismatch_fails_immediately")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(
            Path(raw),
            mismatch_after_up=True,
            health_seq={
                "lexysign-staging-client": ["starting"],
                "lexysign-staging-server": ["starting"],
            },
            extra_env={"LEXYSIGN_HEALTH_TIMEOUT": "30", "LEXYSIGN_HEALTH_POLL": "5"},
        )
        proc = run_helper(harness)
        assert proc.returncode == 25, proc.stderr
        assert "still starting" not in proc.stderr


@test("release_production_requires_backup_and_allows_ses")
def _():
    with tempfile.TemporaryDirectory() as raw:
        blocked = make_harness(Path(raw), target="production", with_backup=False)
        proc = run_helper(blocked)
        assert proc.returncode == 23, proc.stderr
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), target="production")
        proc = run_helper(harness)
        assert proc.returncode == 0, proc.stderr
        log = docker_log(harness)
        joined = " ".join(" ".join(x) for x in log).lower()
        assert "caddy" not in joined
        assert "--remove-orphans" not in joined
        ups = [x for x in log if "up" in x]
        assert ups[0][-2:] == ["server", "client"]


@test("release_retry_preserves_original_rollback")
def _():
    with tempfile.TemporaryDirectory() as raw:
        harness = make_harness(Path(raw), fail_on="up")
        first = run_helper(harness)
        assert first.returncode != 0
        original = Path(harness["deploy"]) / ".release-history" / "original-rollback.json"
        public = Path(harness["deploy"]) / ".rollback-meta.json"
        first_original = original.read_text()
        first_public = public.read_text()
        state = json.loads(Path(harness["state"]).read_text())
        state["fail_on"] = "pull"
        Path(harness["state"]).write_text(json.dumps(state))
        second = run_helper(harness)
        assert second.returncode != 0
        assert original.read_text() == first_original
        assert public.read_text() == first_public


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
    assert data["jobs"]["deploy"]["timeout-minutes"] == 35
    assert "deploy/lexysign/Caddyfile" not in text
    assert "COMPOSE_PROFILES" not in text
    assert "--remove-orphans" not in text
    assert "docker rm -f" not in text
    assert "caddy reload" not in text
    assert "VITE_SUPABASE" not in text
    assert "lexysign-app-release.py" in text


@test("caddyfile_bytes_unchanged")
def _():
    digest = hashlib.sha256(CADDYFILE.read_bytes()).hexdigest()
    assert digest == KNOWN_CADDY_SHA256


@test("helper_source_does_not_stage_caddyfile")
def _():
    text = HELPER_PY.read_text(encoding="utf-8")
    assert "Caddyfile" not in text
    assert "--remove-orphans" in text
    assert "COMPOSE_PROFILES=edge" not in text
    assert "LEXYSIGN_APP_RELEASE_TEST" not in text


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
    sys.exit(main())
