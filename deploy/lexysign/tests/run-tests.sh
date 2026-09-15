#!/usr/bin/env bash
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
bash -n "$dir/../lexysign-app-release.sh"
python3 -m py_compile "$dir/../lexysign-app-release.py"
python3 -m py_compile "$dir/test_app_release.py"
python3 "$dir/test_app_release.py"
