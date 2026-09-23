#!/usr/bin/env sh
# One-time setup: pinned dependencies into workbench/.venv (Python >= 3.10; tested on 3.11).
set -e
cd "$(dirname "$0")/.."
python3 -m venv .venv
.venv/bin/pip install -q -r requirements.txt
echo "Optional live model adapter: .venv/bin/pip install -r requirements-live.txt and set ANTHROPIC_API_KEY."
