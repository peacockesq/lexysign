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

import gzip
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


ALLOWED_TARGETS = ("staging", "production")
STAGING_SMTP_SINK_HOSTS = frozenset({"mailpit", "lexysign-staging-mailpit"})
STAGING_SMTP_SINK_PORT = "1025"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
TAG_RE = re.compile(r"^(prod|staging)-[0-9a-f]{12}$")
SES_HINTS = ("amazonaws.com", "email-smtp.", "amazonses", "smtp.mailgun.org")
RELAY_ENV_KEYS = (
    "MP_SMTP_RELAY_HOST",
    "MP_SMTP_RELAY_SERVER",
    "MP_SMTP_RELAY",
    "SMTP_RELAY_HOST",
    "RELAY_HOST",
)
FORBIDDEN_DOCKER_TOKENS = (
    "caddy",
    "--remove-orphans",
    "--renew-anon-volumes",
    "--profile",
    "compose_profiles",
)
APP_SERVICES = frozenset({"server", "client"})
MONGO_ARCHIVE_MAGIC = b"mdmp"
BACKUP_MAX_AGE = timedelta(hours=24)
BACKUP_FUTURE_SKEW = timedelta(minutes=5)
FILES_MOUNT = "/usr/src/app/files"
MONGO_URI = "mongodb://mongo:27017/lexysign"
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
        "files_volume": "lexysign_lexysign-files",
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
        "files_volume": "lexysign-staging_lexysign-files",
    },
}


class ReleaseError(Exception):
    def __init__(self, message: str, code: int = 1) -> None:
        super().__init__(message)
        self.code = code


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_now_stamp() -> str:
    return utc_now().strftime("%Y-%m-%dT%H:%M:%SZ")


def expected_layout(target: str) -> dict[str, str]:
    exp = dict(EXPECTED[target])
    root = os.environ.get("LEXYSIGN_DEPLOY_ROOT", "").strip()
    if root:
        exp["deploy_path"] = str(Path(root) / Path(exp["deploy_path"]).relative_to("/"))
    return exp


def pinned_image_tag(target: str, github_sha: str) -> str:
    return f"{EXPECTED[target]['prefix']}-{github_sha[:12]}"


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
    return {
        "target": os.environ.get("TARGET", "").strip(),
        "github_sha": os.environ.get("GITHUB_SHA", "").strip(),
        "github_run_id": os.environ.get("GITHUB_RUN_ID", "manual").strip() or "manual",
        "image_tag": os.environ.get("IMAGE_TAG", "").strip(),
        "public_url": os.environ.get("PUBLIC_URL", "").strip().rstrip("/"),
        "project_name": os.environ.get("PROJECT_NAME", "").strip(),
        "deploy_path": os.environ.get("DEPLOY_PATH", "").strip(),
        "client_container": os.environ.get("CLIENT_CONTAINER", "").strip(),
        "server_container": os.environ.get("SERVER_CONTAINER", "").strip(),
        "mongo_container": os.environ.get("MONGO_CONTAINER", "").strip(),
        "network_name": os.environ.get("NETWORK_NAME", "").strip(),
        "registry": os.environ.get("REGISTRY", "ghcr.io").strip() or "ghcr.io",
        "image_owner": os.environ.get("IMAGE_OWNER", "peacockesq").strip() or "peacockesq",
        "compose_file": os.environ.get("LEXYSIGN_COMPOSE_FILE", "docker-compose.runtime.yml"),
        "files_volume": os.environ.get("LEXYSIGN_FILES_VOLUME", "").strip(),
    }


def validate_inputs(cfg: Mapping[str, str]) -> None:
    target = cfg["target"]
    if target not in ALLOWED_TARGETS:
        raise ReleaseError(
            f"invalid TARGET {target!r}; expected staging or production", 21
        )
    sha = cfg["github_sha"]
    if not SHA_RE.match(sha):
        raise ReleaseError(
            "GITHUB_SHA must be the literal 40-character lowercase hex revision; "
            "malformed or case-folded source IDs are rejected",
            21,
        )
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
    expected = expected_layout(target)
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
    if cfg["client_container"] == cfg["server_container"]:
        raise ReleaseError("client and server containers must be distinct", 21)
    files_volume = cfg.get("files_volume") or expected["files_volume"]
    if files_volume != expected["files_volume"]:
        raise ReleaseError(
            f"files_volume {files_volume!r} does not match {target} expected {expected['files_volume']!r}",
            21,
        )


def env_map(raw: Any) -> dict[str, str]:
    if raw is None:
        return {}
    if isinstance(raw, dict):
        return {str(k): "" if v is None else str(v) for k, v in raw.items()}
    out: dict[str, str] = {}
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, str) and "=" in item:
                key, value = item.split("=", 1)
                out[key] = value
    return out


def smtp_error(reason: str) -> ReleaseError:
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
        raise smtp_error("SMTP_HOST is missing or empty.")
    host_l = host.lower()
    if any(hint in host_l for hint in SES_HINTS) or host_l.endswith(".amazonaws.com"):
        raise smtp_error(
            f"SMTP_HOST {host!r} is a production SES/remote relay, not a local test sink."
        )
    if host not in STAGING_SMTP_SINK_HOSTS:
        raise smtp_error(
            f"SMTP_HOST {host!r} is not a supported local test sink identity."
        )
    if port != STAGING_SMTP_SINK_PORT:
        raise smtp_error(
            f"SMTP_PORT {port!r} does not match the supported local sink port {STAGING_SMTP_SINK_PORT}."
        )
    if enable not in {"true", "1", "yes"}:
        raise smtp_error(
            f"SMTP_ENABLE={enable!r}; the local sink is present but not enabled."
        )


def sha256_and_size(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as handle:
        while True:
            chunk = handle.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            digest.update(chunk)
    return digest.hexdigest(), size


def _parse_iso_aware(raw: str) -> datetime:
    text = raw.strip()
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ReleaseError(
            f"backup manifest created_at {raw!r} is not an ISO-8601 timestamp", 23
        ) from exc
    if parsed.tzinfo is None:
        raise ReleaseError("backup manifest created_at must be timezone-aware", 23)
    return parsed.astimezone(timezone.utc)


def _require_regular_file(path: Path, backups_root: Path, label: str) -> None:
    if not path.is_absolute():
        raise ReleaseError(f"backup manifest {label} must be an absolute path", 23)
    if not path.exists():
        raise ReleaseError(f"backup manifest {label} is missing", 23)
    if path.is_symlink() or stat.S_ISLNK(path.lstat().st_mode):
        raise ReleaseError(f"backup manifest {label} must not be a symlink", 23)
    if not path.is_file():
        raise ReleaseError(f"backup manifest {label} is not a regular file", 23)
    resolved = path.resolve()
    root = backups_root.resolve()
    if root not in resolved.parents and resolved != root:
        raise ReleaseError(
            f"backup manifest {label} must live under the protected backup directory {root}",
            23,
        )


def _verify_mongo_gzip(path: Path) -> None:
    header = path.read_bytes()[:2]
    if header != b"\x1f\x8b":
        raise ReleaseError("mongo_dump is not a gzip archive (missing gzip magic)", 23)
    try:
        with gzip.open(path, "rb") as handle:
            magic = handle.read(4)
    except (OSError, EOFError, gzip.BadGzipFile) as exc:
        raise ReleaseError(
            "mongo_dump gzip is truncated or not a valid gzip archive", 23
        ) from exc
    if magic != MONGO_ARCHIVE_MAGIC:
        raise ReleaseError(
            "mongo_dump decompressed header is not a mongodump archive (expected mdmp magic)",
            23,
        )


def _verify_files_tar(path: Path) -> None:
    try:
        with tarfile.open(path, "r:*") as archive:
            members = [member for member in archive.getmembers() if member.isfile()]
    except (OSError, tarfile.TarError) as exc:
        raise ReleaseError("files_backup is not an openable tar/gzip archive", 23) from exc
    if not members:
        raise ReleaseError("files_backup tar contains no files", 23)


def validate_backup_manifest(
    manifest_path: Path,
    cfg: Mapping[str, str],
    now: datetime | None = None,
) -> dict[str, Any]:
    target = cfg["target"]
    layout = expected_layout(target)
    backups_root = Path(cfg["deploy_path"]) / "backups"
    if not manifest_path.is_file():
        raise ReleaseError(
            f"Missing backup manifest {manifest_path}. "
            "Native Parse startup migrations can mutate MongoDB; swapping the old app image "
            "does not roll back schema. Create a real mongodump --archive --gzip plus files-volume "
            "tar.gz under the protected backups directory before app replacement. "
            "This helper does not invent archives or perform restore.",
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
    if "image_swap_reverts_schema" not in data or data.get("image_swap_reverts_schema") is not False:
        raise ReleaseError(
            "backup manifest must set image_swap_reverts_schema to false. "
            "Parse/Mongo schema is not rolled back by replacing app images.",
            23,
        )
    created = _parse_iso_aware(str(data.get("created_at", "")).strip())
    clock = now or utc_now()
    if created - clock > BACKUP_FUTURE_SKEW:
        raise ReleaseError("backup manifest created_at is in the future", 23)
    if clock - created > BACKUP_MAX_AGE:
        raise ReleaseError(
            "backup manifest is stale (created_at older than 24h freshness policy); "
            "take a new mongodump and files archive before app replacement",
            23,
        )
    source = data.get("source")
    if not isinstance(source, dict):
        raise ReleaseError("backup manifest missing source identity metadata", 23)
    for key, expected in (
        ("project_name", layout["project_name"]),
        ("mongo_container", layout["mongo_container"]),
        ("files_volume", layout["files_volume"]),
        ("network_name", layout["network_name"]),
    ):
        if str(source.get(key, "")).strip() != expected:
            raise ReleaseError(
                f"backup manifest source.{key} does not match {target} identity {expected}",
                23,
            )
    paths: dict[str, Path] = {}
    for key, hash_key, size_key, verifier in (
        ("mongo_dump", "mongo_dump_sha256", "mongo_dump_bytes", _verify_mongo_gzip),
        ("files_backup", "files_backup_sha256", "files_backup_bytes", _verify_files_tar),
    ):
        raw = data.get(key)
        if not isinstance(raw, str) or not raw.strip():
            raise ReleaseError(f"backup manifest missing {key} path", 23)
        path = Path(raw)
        _require_regular_file(path, backups_root, key)
        if path.stat().st_size <= 0:
            raise ReleaseError(f"backup manifest {key} is empty", 23)
        digest, size = sha256_and_size(path)
        claimed_hash = str(data.get(hash_key, "")).strip().lower()
        if claimed_hash != digest:
            raise ReleaseError(f"backup manifest {hash_key} does not match file readback", 23)
        try:
            claimed_size = int(data.get(size_key))
        except (TypeError, ValueError) as exc:
            raise ReleaseError(f"backup manifest {size_key} is missing or not an integer", 23) from exc
        if claimed_size != size:
            raise ReleaseError(f"backup manifest {size_key} does not match file readback", 23)
        verifier(path)
        paths[key] = path
    if paths["mongo_dump"] == paths["files_backup"]:
        raise ReleaseError("backup manifest mongo_dump and files_backup must be distinct files", 23)
    return data


def compose_base_args(cfg: Mapping[str, str], deploy_env_file: str) -> list[str]:
    return [
        "compose",
        "--env-file",
        ".env",
        "--env-file",
        deploy_env_file,
        "-f",
        cfg["compose_file"],
    ]


def _tokens(argv: Sequence[str]) -> list[str]:
    return [str(part) for part in argv]


def expected_image(cfg: Mapping[str, str], name: str) -> str:
    return f"{cfg['registry']}/{cfg['image_owner']}/lexysign-{name}:{cfg['image_tag']}"


def allowed_inspect_names(cfg: Mapping[str, str]) -> set[str]:
    names = {cfg["client_container"], cfg["server_container"]}
    if cfg.get("target") == "staging":
        names.update(STAGING_SMTP_SINK_HOSTS)
    return names


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
    if tokens[:1] == ["rm"] or (len(tokens) >= 2 and tokens[0] == "container" and tokens[1] == "rm"):
        raise ReleaseError("refusing docker rm during app release", 24)
    if tokens[:1] == ["exec"]:
        raise ReleaseError("refusing docker exec during app release", 24)
    if "volume" in lowered[:3]:
        raise ReleaseError("refusing docker volume operations during app release", 24)
    if "--remove-orphans" in tokens:
        raise ReleaseError("refusing --remove-orphans", 24)
    if tokens[:1] == ["network"]:
        raise ReleaseError("refusing docker network changes during app release", 24)
    if "mongo" in lowered and "inspect" not in lowered and "config" not in lowered:
        raise ReleaseError(f"refusing Docker operation that targets mongo: {tokens}", 24)

    if tokens[:1] == ["inspect"]:
        names = [tok for tok in tokens[1:] if not tok.startswith("-")]
        allowed = allowed_inspect_names(cfg)
        for name in names:
            if name not in allowed:
                raise ReleaseError(
                    f"refusing inspect of non-app/sink target {name!r}",
                    24,
                )
        return

    if tokens[:1] == ["login"]:
        return

    if tokens[:2] == ["image", "inspect"]:
        refs = [tok for tok in tokens[2:] if not tok.startswith("-")]
        allowed_refs = {expected_image(cfg, "client"), expected_image(cfg, "server")}
        for ref in refs:
            if ref not in allowed_refs:
                raise ReleaseError(f"refusing image inspect of unexpected ref {ref!r}", 24)
        return

    if tokens[:1] != ["compose"]:
        raise ReleaseError(f"refusing unexpected docker subcommand: {tokens}", 24)

    if "config" in tokens:
        return

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
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0:
        raise ReleaseError(
            f"command failed: {' '.join(argv[:6])}... (exit {result.returncode})",
            25 if "inspect" in docker_argv else 1,
        )
    return result


def docker_login() -> None:
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
        stdin=subprocess.DEVNULL,
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
    state = doc.get("State") or {}
    mounts = doc.get("Mounts") or []
    networks = list((doc.get("NetworkSettings") or {}).get("Networks") or {})
    return {
        "missing": False,
        "id": doc.get("Id"),
        "image": (doc.get("Config") or {}).get("Image"),
        "image_id": doc.get("Image"),
        "revision": labels.get("org.opencontainers.image.revision"),
        "running": state.get("Running"),
        "status": state.get("Status"),
        "networks": networks,
        "mount_destinations": [item.get("Destination") for item in mounts],
        "volume_names": [item.get("Name") for item in mounts if item.get("Name")],
    }


def history_dir(deploy_dir: Path) -> Path:
    path = deploy_dir / ".release-history"
    path.mkdir(mode=0o700, exist_ok=True)
    return path


def write_json_once(path: Path, payload: Mapping[str, Any]) -> None:
    if path.exists():
        return
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    os.replace(tmp, path)


def preserve_original_state(cfg: Mapping[str, str], deploy_dir: Path) -> dict[str, Any]:
    hist = history_dir(deploy_dir)
    payload = {
        "captured_at": utc_now_stamp(),
        "target": cfg["target"],
        "github_sha": cfg["github_sha"],
        "warning": (
            "Image rollback does not revert Parse/Mongo schema migrations. "
            "Restore mongo_dump and files_backup from the backup manifest to undo data/schema mutation. "
            "Successful restore is a separate native gate; this file is not archive-only DR."
        ),
        "containers": {
            "client": container_meta(inspect_container(cfg, cfg["client_container"])),
            "server": container_meta(inspect_container(cfg, cfg["server_container"])),
        },
    }
    original = hist / "original-rollback.json"
    write_json_once(original, payload)
    public_meta = deploy_dir / ".rollback-meta.json"
    write_json_once(public_meta, payload)
    prior_env = hist / "original.deploy.env"
    live_env = deploy_dir / ".deploy.env"
    if live_env.is_file() and not prior_env.exists():
        shutil.copy2(live_env, prior_env)
        prior_env.chmod(0o600)
    host_url_file = hist / "original.host_url"
    if not host_url_file.exists():
        env_values = parse_env_file(deploy_dir / ".env")
        host_url_file.write_text(env_values.get("HOST_URL", "") + "\n", encoding="utf-8")
        host_url_file.chmod(0o600)
    return json.loads(original.read_text(encoding="utf-8"))


def write_attempt_ledger(deploy_dir: Path, cfg: Mapping[str, str], phase: str) -> Path:
    attempts = history_dir(deploy_dir) / "attempts"
    attempts.mkdir(mode=0o700, exist_ok=True)
    stamp = utc_now().strftime("%Y%m%dT%H%M%S")
    path = attempts / f"{cfg['github_run_id']}-{stamp}-{phase}.json"
    payload = {
        "phase": phase,
        "target": cfg["target"],
        "github_sha": cfg["github_sha"],
        "image_tag": cfg["image_tag"],
        "captured_at": utc_now_stamp(),
    }
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    path.chmod(0o600)
    return path


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


def _volume_source(item: Any) -> str:
    if isinstance(item, str):
        return item.split(":", 1)[0]
    if isinstance(item, dict):
        return str(item.get("source") or item.get("Source") or item.get("Name") or "")
    return ""


def _volume_target(item: Any) -> str:
    if isinstance(item, str):
        parts = item.split(":")
        return parts[1] if len(parts) > 1 else ""
    if isinstance(item, dict):
        return str(item.get("target") or item.get("Target") or item.get("Destination") or "")
    return ""


def validate_compose_scope(cfg: Mapping[str, str], compose: Mapping[str, Any]) -> None:
    if compose.get("name") != cfg["project_name"]:
        raise ReleaseError(
            f"compose project {compose.get('name')!r} does not match {cfg['project_name']}",
            24,
        )
    services = compose.get("services") or {}
    layout = expected_layout(cfg["target"])
    for kind in ("server", "client"):
        svc = services.get(kind) or {}
        wanted_name = cfg[f"{kind}_container"]
        if svc.get("container_name") != wanted_name:
            raise ReleaseError(
                f"compose {kind} container_name {svc.get('container_name')!r} is not {wanted_name}",
                24,
            )
        image = str(svc.get("image") or "")
        wanted_image = expected_image(cfg, kind)
        if image != wanted_image and not image.startswith(
            f"{cfg['registry']}/{cfg['image_owner']}/lexysign-{kind}@sha256:"
        ):
            raise ReleaseError(
                f"compose {kind} image is not the pinned owner/tag or digest",
                24,
            )
        if svc.get("privileged"):
            raise ReleaseError(f"compose {kind} is privileged; refusing app release", 24)
        network_mode = str(svc.get("network_mode") or "")
        if network_mode in {"host", "service:caddy"} or network_mode.startswith("container:"):
            raise ReleaseError(f"compose {kind} network_mode {network_mode!r} is not app-only", 24)
        for volume in svc.get("volumes") or []:
            source = _volume_source(volume).lower()
            target = _volume_target(volume).lower()
            blob = f"{source}:{target}"
            if "docker.sock" in blob or "/etc/caddy" in blob or "caddyfile" in blob:
                raise ReleaseError(
                    f"compose {kind} has a shared-edge or docker socket mount; refusing",
                    24,
                )
    server = services.get("server") or {}
    server_env = env_map(server.get("environment"))
    mongo_uri = server_env.get("MONGODB_URI") or server_env.get("DATABASE_URI") or ""
    if mongo_uri != MONGO_URI:
        raise ReleaseError("compose server DB destination is not mongodb://mongo:27017/lexysign", 24)
    file_targets = [_volume_target(item) for item in server.get("volumes") or []]
    if FILES_MOUNT not in file_targets:
        raise ReleaseError("compose server is missing the persistent files mount", 24)
    file_sources = [_volume_source(item) for item in server.get("volumes") or []]
    if layout["files_volume"] not in file_sources and "lexysign-files" not in file_sources:
        raise ReleaseError("compose server files volume identity does not match the target", 24)
    server_nets = server.get("networks") or {}
    if isinstance(server_nets, dict):
        net_keys = set(server_nets)
    else:
        net_keys = set(server_nets)
    if "lexysign" not in net_keys and cfg["network_name"] not in net_keys:
        raise ReleaseError("compose server is not attached to the LexySign app network", 24)


def validate_current_contract(cfg: Mapping[str, str]) -> None:
    layout = expected_layout(cfg["target"])
    for kind, name in (("client", cfg["client_container"]), ("server", cfg["server_container"])):
        doc = inspect_container(cfg, name)
        if not doc:
            raise ReleaseError(
                f"{name} is missing; refuse to replace without a current target identity",
                24,
            )
        meta = container_meta(doc)
        host_cfg = doc.get("HostConfig") or {}
        if host_cfg.get("Privileged"):
            raise ReleaseError(f"{name} is privileged; refusing replacement", 24)
        if host_cfg.get("NetworkMode") == "host":
            raise ReleaseError(f"{name} uses host network; refusing replacement", 24)
        if cfg["network_name"] not in (meta.get("networks") or []):
            raise ReleaseError(
                f"{name} is not on expected network {cfg['network_name']}; mount/network drift",
                24,
            )
        if kind == "server":
            if FILES_MOUNT not in (meta.get("mount_destinations") or []):
                raise ReleaseError(f"{name} is missing files mount {FILES_MOUNT}", 24)
            volumes = meta.get("volume_names") or []
            if layout["files_volume"] not in volumes:
                raise ReleaseError(
                    f"{name} files volume is not {layout['files_volume']}; refusing drift",
                    24,
                )


def validate_effective_smtp(cfg: Mapping[str, str], compose: Mapping[str, Any]) -> str:
    server_env = env_map((compose.get("services") or {}).get("server", {}).get("environment"))
    validate_staging_smtp(server_env)
    return server_env.get("SMTP_HOST", "").strip()


def _port_open(doc: Mapping[str, Any], port: str) -> bool:
    ports = (doc.get("NetworkSettings") or {}).get("Ports") or {}
    exposed = (doc.get("Config") or {}).get("ExposedPorts") or {}
    bindings = (doc.get("HostConfig") or {}).get("PortBindings") or {}
    keys = {f"{port}/tcp", port}
    return any(key in ports or key in exposed or key in bindings for key in keys)


def validate_sink_container(cfg: Mapping[str, str], host: str) -> None:
    doc = inspect_container(cfg, host)
    if not doc:
        raise smtp_error(f"local sink container {host!r} is not present.")
    state = doc.get("State") or {}
    if not state.get("Running") or state.get("Restarting") or state.get("Dead"):
        raise smtp_error(f"local sink container {host!r} is not running.")
    if not _port_open(doc, STAGING_SMTP_SINK_PORT):
        raise smtp_error(f"local sink container {host!r} does not expose SMTP port {STAGING_SMTP_SINK_PORT}.")
    networks = (doc.get("NetworkSettings") or {}).get("Networks") or {}
    if cfg["network_name"] not in networks:
        raise smtp_error(
            f"local sink {host!r} is not on the staging app network {cfg['network_name']}."
        )
    env_values = env_map((doc.get("Config") or {}).get("Env"))
    for key in RELAY_ENV_KEYS:
        if env_values.get(key, "").strip():
            raise smtp_error(
                f"local sink {host!r} has relay/forwarding enabled; refusing (no SES/remote relay)."
            )


def resolve_pulled_candidates(cfg: Mapping[str, str]) -> dict[str, dict[str, str]]:
    candidates: dict[str, dict[str, str]] = {}
    for kind in ("server", "client"):
        ref = expected_image(cfg, kind)
        result = run_docker(cfg, ["image", "inspect", ref], capture=True)
        try:
            data = json.loads(result.stdout)[0]
        except (json.JSONDecodeError, IndexError, TypeError) as exc:
            raise ReleaseError(f"unable to inspect pulled {kind} image", 25) from exc
        labels = (data.get("Config") or {}).get("Labels") or {}
        revision = labels.get("org.opencontainers.image.revision")
        environment = labels.get("com.lexysign.environment")
        image_id = str(data.get("Id") or "")
        digests = data.get("RepoDigests") or []
        digest = str(digests[0]) if digests else ""
        if revision != cfg["github_sha"]:
            raise ReleaseError(
                f"pulled {kind} revision does not match workflow SHA; refusing to replace running containers",
                25,
            )
        if environment != cfg["target"]:
            raise ReleaseError(
                f"pulled {kind} environment label {environment!r} does not match {cfg['target']}",
                25,
            )
        if not image_id.startswith("sha256:"):
            raise ReleaseError(f"pulled {kind} has no image id; a mutable tag is not a pin", 25)
        if "@sha256:" not in digest:
            raise ReleaseError(
                f"pulled {kind} has no repo digest; refusing to treat a SHA-looking tag as immutable",
                25,
            )
        candidates[kind] = {
            "id": image_id,
            "digest": digest,
            "revision": revision,
            "ref": ref,
        }
    return candidates


def assert_live_app_container(
    name: str,
    doc: Mapping[str, Any] | None,
    cfg: Mapping[str, str],
    kind: str,
    candidate: Mapping[str, str],
) -> None:
    if not doc:
        raise ReleaseError(f"{name} is not present after app release", 25)
    state = doc.get("State") or {}
    status = str(state.get("Status") or "")
    if not state.get("Running") or state.get("Restarting") or state.get("Dead"):
        raise ReleaseError(
            f"{name} is not running (status={status!r}); image/revision match is not enough",
            25,
        )
    if status in {"exited", "dead", "paused", "restarting", "removing", "created"}:
        raise ReleaseError(f"{name} status {status!r} is not a live app container", 25)
    health = state.get("Health")
    if isinstance(health, dict) and health:
        if health.get("Status") != "healthy":
            raise ReleaseError(
                f"{name} healthcheck is {health.get('Status')!r}, not healthy",
                25,
            )
    wanted = expected_image(cfg, kind)
    config_image = (doc.get("Config") or {}).get("Image")
    if config_image != wanted:
        raise ReleaseError(
            f"{name} image {config_image!r} does not match pinned {wanted}",
            25,
        )
    if doc.get("Image") != candidate["id"]:
        raise ReleaseError(
            f"{name} image id does not match the pulled candidate digest/id",
            25,
        )
    labels = (doc.get("Config") or {}).get("Labels") or {}
    if labels.get("org.opencontainers.image.revision") != cfg["github_sha"]:
        raise ReleaseError(f"{name} revision does not match workflow SHA", 25)


def verify_running_images(cfg: Mapping[str, str], candidates: Mapping[str, Mapping[str, str]]) -> None:
    for kind, name in (("client", cfg["client_container"]), ("server", cfg["server_container"])):
        doc = inspect_container(cfg, name)
        assert_live_app_container(name, doc, cfg, kind, candidates[kind])


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
    if result.returncode != 0:
        return "000"
    code = (result.stdout or "").strip()
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
            f"app health failed for {origin}/: HTTP {home} (backend death, unreachable, or curl nonzero)",
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
            f"billing/status failed: HTTP {billing} (backend death, unreachable, or curl nonzero; not the unauthenticated 401 boundary)",
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


def load_compose_config(cfg: Mapping[str, str], deploy_env_file: str) -> dict[str, Any]:
    result = run_docker(
        cfg,
        [*compose_base_args(cfg, deploy_env_file), "config", "--format", "json"],
        capture=True,
    )
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ReleaseError("compose config --format json did not parse", 24) from exc
    if not isinstance(data, dict):
        raise ReleaseError("compose config JSON must be an object", 24)
    return data


def release(cfg: Mapping[str, str]) -> None:
    validate_inputs(cfg)
    cfg = dict(cfg)
    cfg["files_volume"] = expected_layout(cfg["target"])["files_volume"]
    deploy_dir = Path(cfg["deploy_path"]) / "deploy" / "lexysign"
    env_path = deploy_dir / ".env"
    if not env_path.is_file():
        raise ReleaseError(
            f"Missing {env_path}. Seed this file from production/staging secrets before deploying.",
            20,
        )
    parse_env_file(env_path)
    manifest = Path(
        os.environ.get(
            "LEXYSIGN_BACKUP_MANIFEST",
            str(deploy_dir / ".backup-manifest.json"),
        )
    )
    validate_backup_manifest(manifest, cfg)

    os.chdir(deploy_dir)
    hist = history_dir(deploy_dir)
    candidate_env = hist / f"{cfg['github_run_id']}.deploy.env.candidate"
    write_deploy_env(cfg, candidate_env)
    compose = load_compose_config(cfg, str(candidate_env))
    validate_compose_scope(cfg, compose)
    if cfg["target"] == "staging":
        sink_host = validate_effective_smtp(cfg, compose)
        validate_sink_container(cfg, sink_host)
    validate_current_contract(cfg)
    preserve_original_state(cfg, deploy_dir)
    write_attempt_ledger(deploy_dir, cfg, "preflight")
    eprint(
        "Note: replacing client/server images does not reverse Parse startup migrations. "
        "Use the backup manifest archives to restore data/schema. Restore is a separate native gate."
    )

    docker_login()
    eprint(f"Pulling LexySign images for {cfg['target']} tag {cfg['image_tag']}")
    run_docker(cfg, [*compose_base_args(cfg, str(candidate_env)), "pull", "server"], timeout_secs=pull_timeout())
    run_docker(cfg, [*compose_base_args(cfg, str(candidate_env)), "pull", "client"], timeout_secs=pull_timeout())
    candidates = resolve_pulled_candidates(cfg)
    live_env = deploy_dir / ".deploy.env"
    os.replace(candidate_env, live_env)
    upsert_env_key(env_path, "HOST_URL", cfg["public_url"])
    write_attempt_ledger(deploy_dir, cfg, "pulled")
    run_docker(
        cfg,
        [*compose_base_args(cfg, str(live_env)), "up", "-d", "--no-deps", "--force-recreate", "server", "client"],
        timeout_secs=up_timeout(),
    )
    verify_running_images(cfg, candidates)
    smoke_http(cfg["public_url"])
    write_attempt_ledger(deploy_dir, cfg, "complete")
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
