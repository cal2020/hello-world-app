#!/bin/sh
# Container entrypoint. Some platforms (e.g. Railway) mount volumes owned by root.
# If started as root: make /data writable for the unprivileged 'app' user, then drop privileges.
set -e
DATA="${LWB_VAR:-/data}"
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R app:app "$DATA"
  exec setpriv --reuid=app --regid=app --init-groups python scripts/run.py "$@"
fi
exec python scripts/run.py "$@"
