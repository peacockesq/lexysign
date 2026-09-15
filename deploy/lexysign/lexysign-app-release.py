#!/usr/bin/env python3
"""Fail-closed LexySign app-only release.

This helper may replace the target client/server containers. It must never copy,
overwrite, recreate, remove, reload, or change networks of shared Caddy, never
use --remove-orphans, never recreate Mongo, and never touch volumes.

Host .env remains the secret source. Client runtime-env continues to come from
container env (VITE_SUPABASE_*) written by docker-entrypoint.lexysign.sh. This
helper does not inject frontend secrets and does not print env values.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


ALLOWED_TARGETS = ("staging", "production")
STAGING_SMTP_SINK_HOSTS = frozenset({"mailpit", "lexysign-staging-mailpit"})
STAGING_SMTP_SINK_PORT = "1025"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TAG_RE = re.compile(r"^(prod|staging)-[0-9a-f]{12}$")
SES_HINTS = ("amazonaws.com", "email-smtp.", "amazonses", "smtp.mailgun.org")
FORBIDDEN_DOCKER_TOKENS = (
    "caddy",
    "--remove-orphans",
    "--renew-anon-volumes",
    "--profile",
    "compose_profiles",
)
APP_SERVICES = frozenset({"server", "client"})
SECRET_ENV_KEYS = frozenset(
    {
        "MASTER_KEY",
        "SMTP_PASS",
        "SMTP_PASSWORD",
        "SMTP_USERNAME",
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "SUPABASE_SERVICE_ROLE_KEY",
        "VITE_SUPABASE_ANON_KEY",
        "SUPABASE_ANON_KEY",
        "PFX_BASE64",
        "PASS_PHRASE",
        "DO_SECRET_ACCESS_KEY",
        "DO_ACCESS_KEY_ID",
        "MAILGUN_API_KEY",
        "LEXYSIGN_REGISTRY_TOKEN",
    }
)

EXPECTED = {
    "production": {
        "prefix": "prod",
        "public_url": "https://sign.lexyalgo.com",
        "project_name": "lexysign",
        "deploy_path": "/opt/lexysign",
        "client_container": "lexysign-client",
        "server_container": "lexysign-server",
        "mongo_container": "lexysign-mongo",
        "network_name": "lexysign_lexysign",
    },
    "staging": {
        "prefix": "staging",
        "public_url": "https://sign-staging.lexyalgo.com",
        "project_name": "lexysign-staging",
        "deploy_path": "/opt/lexysign-staging",
        "client_container": "lexysign-staging-client",
        "server_container": "lexysign-staging-server",
        "mongo_container": "lexysign-staging-mongo",
        "network_name": "lexysign-staging_lexysign",
    },
}


class ReleaseError(Exception):
    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_test_mode() -> bool:
    return os.environ.get("LEXYSIGN_APP_RELEASE_TEST", "") == "1"


def pinned_image_tag(target: str, github_sha: str) -> str:
    prefix = EXPECTED[target]["prefix"]
    return f"{prefix}-{github_sha[:12]}"


def parse_env_file(path: Path) -> dict[str, str]:
    """Parse KEY=VALUE lines. Does not execute the file. Values are not logged."""
    values: dict[str, str] = {}
    text = path.read_text(encoding="utf-8")
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :]
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        values[key] = value
    return values


def upsert_env_key(path: Path, key: str, value: str) -> None:
    if key in SECRET_ENV_KEYS:
        raise ReleaseError(f"refusing to rewrite secret key {key}", 21)
    original = path.read_text(encoding="utf-8")
    lines = original.splitlines(keepends=True)
    pattern = re.compile(rf"^{re.escape(key)}=")
    replaced = False
    out: list[str] = []
    for line in lines:
        if pattern.match(line.lstrip("\ufeff")):
            nl = "\n" if line.endswith("\n") else ""
            out.append(f"{key}={value}{nl}")
            replaced = True
        else:
            out.append(line)
    if not replaced:
        prefix = "" if not out or out[-1].endswith("\n") else "\n"
        out.append(f"{prefix}{key}={value}\n")
    path.write_text("".join(out), encoding="utf-8")


def load_config() -> dict[str, str]:
    target = os.environ.get("TARGET", "").strip()
    github_sha = os.environ.get("GITHUB_SHA", "").strip().lower()
    image_tag = os.environ.get("IMAGE_TAG", "").strip()
    deploy_path = os.environ.get("DEPLOY_PATH", "").strip()
    cfg = {
        "target": target,
        "github_sha": github_sha,
        "github_run_id": os.environ.get("GITHUB_RUN_ID", "manual").strip() or "manual",
        "image_tag": image_tag,
        "public_url": os.environ.get("PUBLIC_URL", "").strip().rstrip("/"),
        "project_name": os.environ.get("PROJECT_NAME", "").strip(),
        "deploy_path": deploy_path,
        "client_container": os.environ.get("CLIENT_CONTAINER", "").strip(),
        "server_container": os.environ.get("SERVER_CONTAINER", "").strip(),
        "mongo_container": os.environ.get("MONGO_CONTAINER", "").strip(),
        "network_name": os.environ.get("NETWORK_NAME", "").strip(),
        "registry": os.environ.get("REGISTRY", "ghcr.io").strip() or "ghcr.io",
        "image_owner": os.environ.get("IMAGE_OWNER", "peacockesq").strip() or "peacockesq",
        "compose_file": os.environ.get("LEXYSIGN_COMPOSE_FILE", "docker-compose.runtime.yml"),
    }
    return cfg


def validate_inputs(cfg: Mapping[str, str]) -> None:
    target = cfg["target"]
    if target not in ALLOWED_TARGETS:
        raise ReleaseError(
            f"invalid TARGET {target!r}; expected staging or production", 21
        )
    sha = cfg["github_sha"]
    if not SHA_RE.match(sha):
        raise ReleaseError("GITHUB_SHA must be the full 40-character lowercase hex revision", 21)
    expected_tag = pinned_image_tag(target, sha)
    if not TAG_RE.match(cfg["image_tag"]):
        raise ReleaseError(
            f"IMAGE_TAG {cfg['image_tag']!r} is not a pinned SHA tag; expected {expected_tag}",
            21,
        )
    if cfg["image_tag"] != expected_tag:
        raise ReleaseError(
            "refusing mismatched image tag override "
            f"{cfg['image_tag']!r}; deployed selection is pinned to workflow SHA tag {expected_tag}",
            21,
        )
    expected = EXPECTED[target]
    if not is_test_mode():
        for key in (
            "public_url",
            "project_name",
            "deploy_path",
            "client_container",
            "server_container",
            "mongo_container",
            "network_name",
        ):
            if cfg[key] != expected[key]:
                raise ReleaseError(
                    f"{key} {cfg[key]!r} does not match {target} expected {expected[key]!r}",
                    21,
                )
    else:
        for key in (
            "public_url",
            "project_name",
            "deploy_path",
            "client_container",
            "server_container",
            "mongo_container",
        ):
            if not cfg[key]:
                raise ReleaseError(f"missing required {key}", 21)
        if cfg["public_url"] != expected["public_url"]:
            raise ReleaseError(
                f"public_url {cfg['public_url']!r} does not match {target} expected {expected['public_url']!r}",
                21,
            )
    if cfg["client_container"] == cfg["server_container"]:
        raise ReleaseError("client and server containers must be distinct", 21)


def staging_smtp_error(reason: str) -> ReleaseError:
    supported = ", ".join(sorted(STAGING_SMTP_SINK_HOSTS))
    return ReleaseError(
        "Staging mail sink is not prepared. "
        f"{reason} "
        f"Fail-closed: staging may send only through an explicit local test sink "
        f"(SMTP_HOST in {{{supported}}} and SMTP_PORT={STAGING_SMTP_SINK_PORT}). "
        "Amazon SES / production relays are refused. This release will not reroute mail "
        "or bypass the allowlist. Cain must provision the local sink before synthetic signing.",
        22,
    )


def validate_staging_smtp(env_values: Mapping[str, str]) -> None:
    host = env_values.get("SMTP_HOST", "").strip()
    port = env_values.get("SMTP_PORT", "").strip()
    enable = env_values.get("SMTP_ENABLE", "").strip().lower()
    if not host:
        raise staging_smtp_error("SMTP_HOST is missing or empty.")
    host_l = host.lower()
    if any(hint in host_l for hint in SES_HINTS) or host_l.endswith(".amazonaws.com"):
        raise staging_smtp_error(
            f"SMTP_HOST {host!r} is a production SES/remote relay, not a local test sink."
        )
    if host_l not in STAGING_SMTP_SINK_HOSTS:
        raise staging_smtp_error(
            f"SMTP_HOST {host!r} is not a supported local test sink identity."
        )
    if port != STAGING_SMTP_SINK_PORT:
        raise staging_smtp_error(
            f"SMTP_PORT {port!r} does not match the supported local sink port {STAGING_SMTP_SINK_PORT}."
        )
    if enable not in {"true", "1", "yes"}:
        raise staging_smtp_error(
            f"SMTP_ENABLE={enable!r}; the local sink is present but not enabled."
        )


def validate_backup_manifest(manifest_path: Path, target: str) -> dict[str, Any]:
    if not manifest_path.is_file():
        raise ReleaseError(
            f"Missing backup manifest {manifest_path}. "
            "Native Parse startup migrations can mutate MongoDB; swapping the old app image "
            "does not roll back schema. Create a real mongodump plus files-volume backup and "
            "write the manifest before staging app replacement. This helper does not invent archives.",
            23,
        )
    try:
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ReleaseError(f"backup manifest is not valid JSON: {exc}", 23) from exc
    if not isinstance(data, dict):
        raise ReleaseError("backup manifest must be a JSON object", 23)
    env_name = str(data.get("environment", "")).strip()
    if env_name != target:
        raise ReleaseError(
            f"backup manifest environment {env_name!r} does not match TARGET {target}",
            23,
        )
    if data.get("image_swap_reverts_schema") is True:
        raise ReleaseError(
            "backup manifest claims image_swap_reverts_schema=true; that is false. "
            "Parse/Mongo schema is not rolled back by replacing app images.",
            23,
        )
    for key in ("mongo_dump", "files_backup"):
        raw = data.get(key)
        if not isinstance(raw, str) or not raw.strip():
            raise ReleaseError(f"backup manifest missing {key} path", 23)
        path = Path(raw)
        if not path.is_absolute():
            raise ReleaseError(f"backup manifest {key} must be an absolute path", 23)
        if not path.is_file() or path.stat().st_size <= 0:
            raise ReleaseError(
                f"backup manifest {key} {str(path)!r} is missing or empty; "
                "refusing to mutate before a real database/files backup exists",
                23,
            )
        if path.name in {os.devnull, "null"} or str(path) in {"/dev/null", "/dev/zero"}:
            raise ReleaseError(f"backup manifest {key} is not a real archive", 23)
    if str(data.get("mongo_dump")) == str(data.get("files_backup")):
        raise ReleaseError("backup manifest mongo_dump and files_backup must be distinct files", 23)
    created_at = str(data.get("created_at", "")).strip()
    if not created_at:
        raise ReleaseError("backup manifest missing created_at", 23)
    return data


def compose_base_args(cfg: Mapping[str, str]) -> list[str]:
    return [
        "compose",
        "--env-file",
        ".env",
        "--env-file",
        ".deploy.env",
        "-f",
        cfg["compose_file"],
    ]


def _tokens(argv: Sequence[str]) -> list[str]:
    return [str(part) for part in argv]


def assert_app_only_docker(argv: Sequence[str], cfg: Mapping[str, str]) -> None:
    tokens = _tokens(argv)
    lowered = [tok.lower() for tok in tokens]
    joined = " ".join(lowered)
    for tok in lowered:
        for forbidden in FORBIDDEN_DOCKER_TOKENS:
            if forbidden in tok:
                raise ReleaseError(
                    f"refusing Docker operation that would touch shared edge/Caddy or orphans: {tokens}",
                    24,
                )
    if "caddy" in joined:
        raise ReleaseError(f"refusing Docker operation that references Caddy: {tokens}", 24)
    if tokens[:1] == ["network"] or "network" in lowered[:3]:
        raise ReleaseError("refusing docker network changes during app release", 24)
    if tokens[:1] == ["rm"] or (len(tokens) >= 2 and tokens[0] == "container" and tokens[1] == "rm"):
        raise ReleaseError("refusing docker rm during app release", 24)
    if tokens[:1] == ["exec"]:
        raise ReleaseError("refusing docker exec during app release", 24)
    if "volume" in lowered[:3]:
        raise ReleaseError("refusing docker volume operations during app release", 24)
    if "--remove-orphans" in tokens:
        raise ReleaseError("refusing --remove-orphans", 24)
    if "mongo" in lowered and "inspect" not in lowered:
        raise ReleaseError(f"refusing Docker operation that targets mongo: {tokens}", 24)

    if tokens[:1] == ["inspect"]:
        names = [tok for tok in tokens[1:] if not tok.startswith("-")]
        allowed = {cfg["client_container"], cfg["server_container"]}
        for name in names:
            if name not in allowed:
                raise ReleaseError(
                    f"refusing inspect of non-app target {name!r}; app release is client/server only",
                    24,
                )
        return

    if tokens[:1] == ["login"]:
        return

    if tokens[:1] != ["compose"]:
        raise ReleaseError(f"refusing unexpected docker subcommand: {tokens}", 24)

    if "up" in tokens:
        if "--no-deps" not in tokens:
            raise ReleaseError("compose up must use --no-deps so Mongo/Caddy are not started", 24)
        services = [
            tok
            for tok in tokens[tokens.index("up") + 1 :]
            if not tok.startswith("-")
        ]
        if not services or set(services) - APP_SERVICES:
            raise ReleaseError(
                f"compose up is limited to server client; got {services}",
                24,
            )
        if "mongo" in services:
            raise ReleaseError("compose up must not include mongo", 24)
        return

    if "pull" in tokens:
        services = [
            tok
            for tok in tokens[tokens.index("pull") + 1 :]
            if not tok.startswith("-")
        ]
        if not services or set(services) - APP_SERVICES:
            raise ReleaseError(
                f"compose pull is limited to server client; got {services}",
                24,
            )
        return

    raise ReleaseError(f"refusing unexpected docker compose operation: {tokens}", 24)


def run_docker(
    cfg: Mapping[str, str],
    docker_argv: Sequence[str],
    timeout_secs: int | None = None,
    capture: bool = False,
) -> subprocess.CompletedProcess[str]:
    assert_app_only_docker(docker_argv, cfg)
    argv = ["docker", *docker_argv]
    if timeout_secs is not None:
        argv = ["timeout", f"{timeout_secs}s", *argv]
    result = subprocess.run(
        argv,
        check=False,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
    )
    if result.returncode != 0:
        detail = ""
        if capture and result.stderr:
            # Do not echo possible secret material; keep a short reason.
            detail = f" (exit {result.returncode})"
        raise ReleaseError(
            f"command failed: {' '.join(argv[:6])}...{detail}",
            25 if "inspect" in docker_argv else 1,
        )
    return result


def docker_login() -> None:
    if is_test_mode() or os.environ.get("LEXYSIGN_SKIP_DOCKER_LOGIN", "") == "1":
        eprint("Skipping docker login (test/skip mode)")
        return
    user = os.environ.get("LEXYSIGN_REGISTRY_USER", "").strip()
    token = os.environ.get("LEXYSIGN_REGISTRY_TOKEN", "").strip()
    if not user or not token:
        raise ReleaseError("docker login credentials missing; refusing to pull", 27)
    result = subprocess.run(
        ["docker", "login", "ghcr.io", "-u", user, "--password-stdin"],
        input=token,
        text=True,
        check=False,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise ReleaseError("docker login to ghcr.io failed", 27)


def inspect_container(cfg: Mapping[str, str], name: str) -> dict[str, Any] | None:
    assert_app_only_docker(["inspect", name], cfg)
    result = subprocess.run(
        ["docker", "inspect", name],
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    if not data:
        return None
    return data[0]


def container_meta(doc: Mapping[str, Any] | None) -> dict[str, Any]:
    if not doc:
        return {"missing": True}
    labels = (doc.get("Config") or {}).get("Labels") or {}
    return {
        "missing": False,
        "id": doc.get("Id"),
        "image": (doc.get("Config") or {}).get("Image"),
        "image_id": doc.get("Image"),
        "revision": labels.get("org.opencontainers.image.revision"),
    }


def capture_rollback_metadata(cfg: Mapping[str, str], dest: Path) -> dict[str, Any]:
    payload = {
        "captured_at": utc_now(),
        "target": cfg["target"],
        "warning": (
            "Image rollback does not revert Parse/Mongo schema migrations. "
            "Restore mongo_dump and files_backup from the backup manifest to undo data/schema mutation."
        ),
        "containers": {
            "client": container_meta(inspect_container(cfg, cfg["client_container"])),
            "server": container_meta(inspect_container(cfg, cfg["server_container"])),
        },
    }
    dest.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    dest.chmod(0o600)
    return payload


def write_deploy_env(cfg: Mapping[str, str], dest: Path) -> None:
    body = (
        f"LEXYSIGN_IMAGE_TAG={cfg['image_tag']}\n"
        f"LEXYSIGN_PROJECT_NAME={cfg['project_name']}\n"
        f"LEXYSIGN_CLIENT_CONTAINER={cfg['client_container']}\n"
        f"LEXYSIGN_SERVER_CONTAINER={cfg['server_container']}\n"
        f"LEXYSIGN_MONGO_CONTAINER={cfg['mongo_container']}\n"
        f"HOST_URL={cfg['public_url']}\n"
        f"LEXYSIGN_GIT_SHA={cfg['github_sha']}\n"
        f"LEXYSIGN_GITHUB_RUN_ID={cfg['github_run_id']}\n"
    )
    dest.write_text(body, encoding="utf-8")
    dest.chmod(0o600)


def expected_image(cfg: Mapping[str, str], name: str) -> str:
    return f"{cfg['registry']}/{cfg['image_owner']}/lexysign-{name}:{cfg['image_tag']}"


def verify_running_images(cfg: Mapping[str, str]) -> None:
    checks = (
        ("client", cfg["client_container"]),
        ("server", cfg["server_container"]),
    )
    for kind, name in checks:
        doc = inspect_container(cfg, name)
        if not doc:
            raise ReleaseError(f"{name} is not running after app release", 25)
        meta = container_meta(doc)
        wanted = expected_image(cfg, kind)
        if meta.get("image") != wanted:
            raise ReleaseError(
                f"{name} image {meta.get('image')!r} does not match pinned {wanted}",
                25,
            )
        if meta.get("revision") != cfg["github_sha"]:
            raise ReleaseError(
                f"{name} revision {meta.get('revision')!r} does not match workflow SHA",
                25,
            )


def http_retries() -> tuple[int, float, int]:
    retries = int(os.environ.get("LEXYSIGN_HTTP_RETRIES", "8"))
    delay = float(os.environ.get("LEXYSIGN_HTTP_RETRY_DELAY", "5"))
    max_time = int(os.environ.get("LEXYSIGN_HTTP_MAX_TIME", "45"))
    return retries, delay, max_time


def curl_status(url: str, method: str, max_time: int) -> str:
    argv = [
        "curl",
        "--max-time",
        str(max_time),
        "-sS",
        "-o",
        os.devnull,
        "-w",
        "%{http_code}",
        "-L",
        "--max-redirs",
        "5",
        url,
    ]
    if method == "HEAD":
        argv.insert(1, "-I")
    result = subprocess.run(
        argv,
        check=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        stdin=subprocess.DEVNULL,
    )
    code = (result.stdout or "").strip()
    if result.returncode != 0 and not code:
        return "000"
    if not re.fullmatch(r"[0-9]{3}", code):
        return "000"
    return code


def wait_status(url: str, method: str, acceptable: Iterable[str], retry_5xx: bool) -> str:
    retries, delay, max_time = http_retries()
    last = "000"
    attempts = max(1, retries)
    for attempt in range(1, attempts + 1):
        last = curl_status(url, method, max_time)
        if last in set(acceptable):
            return last
        retryable = last == "000" or (retry_5xx and last.startswith("5"))
        if not retryable or attempt == attempts:
            return last
        time.sleep(delay)
    return last


def smoke_http(public_url: str) -> None:
    origin = public_url.rstrip("/")
    home = wait_status(f"{origin}/", "HEAD", acceptable={"200", "301", "302", "303", "307", "308"}, retry_5xx=True)
    if home.startswith("5") or home == "000":
        raise ReleaseError(
            f"app health failed for {origin}/: HTTP {home} (backend death or unreachable)",
            26,
        )
    if home != "200" and not home.startswith("3"):
        raise ReleaseError(f"app health failed for {origin}/: HTTP {home}", 26)

    billing = wait_status(
        f"{origin}/api/billing/status",
        "GET",
        acceptable={"401"},
        retry_5xx=True,
    )
    if billing == "401":
        return
    if billing.startswith("5") or billing == "000":
        raise ReleaseError(
            f"billing/status failed: HTTP {billing} (backend death or unreachable, not the unauthenticated 401 boundary)",
            26,
        )
    raise ReleaseError(
        f"billing/status expected unauthenticated 401, got HTTP {billing}; "
        "this is not treated as success",
        26,
    )


def pull_timeout() -> int:
    return int(os.environ.get("LEXYSIGN_PULL_TIMEOUT", "1200"))


def up_timeout() -> int:
    return int(os.environ.get("LEXYSIGN_UP_TIMEOUT", "600"))


def release(cfg: Mapping[str, str]) -> None:
    validate_inputs(cfg)
    deploy_dir = Path(cfg["deploy_path"]) / "deploy" / "lexysign"
    env_path = deploy_dir / ".env"
    if not env_path.is_file():
        raise ReleaseError(
            f"Missing {env_path}. Seed this file from production/staging secrets before deploying.",
            20,
        )
    env_values = parse_env_file(env_path)

    if cfg["target"] == "staging":
        validate_staging_smtp(env_values)
        manifest = Path(
            os.environ.get(
                "LEXYSIGN_BACKUP_MANIFEST",
                str(deploy_dir / ".backup-manifest.json"),
            )
        )
        validate_backup_manifest(manifest, "staging")

    os.chdir(deploy_dir)
    rollback_path = Path(
        os.environ.get("LEXYSIGN_ROLLBACK_META", str(deploy_dir / ".rollback-meta.json"))
    )
    capture_rollback_metadata(cfg, rollback_path)
    eprint(f"Wrote target-only rollback metadata to {rollback_path}")
    eprint(
        "Note: replacing client/server images does not reverse Parse startup migrations. "
        "Use the backup manifest archives to restore data/schema."
    )

    upsert_env_key(env_path, "HOST_URL", cfg["public_url"])
    write_deploy_env(cfg, deploy_dir / ".deploy.env")

    docker_login()
    compose = compose_base_args(cfg)
    eprint(f"Pulling LexySign images for {cfg['target']} tag {cfg['image_tag']}")
    run_docker(cfg, [*compose, "pull", "server"], timeout_secs=pull_timeout())
    run_docker(cfg, [*compose, "pull", "client"], timeout_secs=pull_timeout())
    run_docker(
        cfg,
        [*compose, "up", "-d", "--no-deps", "--force-recreate", "server", "client"],
        timeout_secs=up_timeout(),
    )
    verify_running_images(cfg)
    smoke_http(cfg["public_url"])
    eprint(f"App-only release complete for {cfg['target']} at {cfg['image_tag']}")


def usage() -> None:
    eprint("Usage: lexysign-app-release.py [release|smoke-http]")


def main(argv: Sequence[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    mode = args[0] if args else "release"
    if mode in {"-h", "--help"}:
        usage()
        return 0
    try:
        if mode == "smoke-http":
            public_url = os.environ.get("PUBLIC_URL", "").strip()
            if not public_url:
                raise ReleaseError("PUBLIC_URL is required for smoke-http", 21)
            smoke_http(public_url)
            return 0
        if mode != "release":
            raise ReleaseError(f"unknown mode {mode!r}", 21)
        release(load_config())
        return 0
    except ReleaseError as exc:
        eprint(str(exc))
        return exc.code


if __name__ == "__main__":
    sys.exit(main())
