#!/usr/bin/env bash
# Download the pinned OPA release and verify its SHA-256 before use.
set -euo pipefail
VERSION=1.20.0
SHA256=4e4c65be08ed27e7375d816d446a444e65ba101806014c7a51b2a7652c2a942a
DEST="$(cd "$(dirname "$0")/.." && pwd)/.tools/opa"
mkdir -p "$(dirname "$DEST")"
curl -fsSL -o "$DEST.tmp" "https://github.com/open-policy-agent/opa/releases/download/v${VERSION}/opa_linux_amd64_static"
echo "${SHA256}  $DEST.tmp" | sha256sum -c -
mv "$DEST.tmp" "$DEST" && chmod +x "$DEST"
"$DEST" version | head -1
