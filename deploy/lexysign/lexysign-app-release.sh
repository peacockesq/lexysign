#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 is required for lexysign-app-release" >&2
  exit 19
fi
exec python3 "$here/lexysign-app-release.py" "$@"
