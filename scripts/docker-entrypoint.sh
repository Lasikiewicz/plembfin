#!/bin/sh
set -e
# When the container starts as root (the default on most Docker setups), fix
# /data ownership so the non-root plembfin user can write to a host-mounted
# volume, then drop privilege and exec the real process.
DATA_PATH="${DATA_DIR:-/data}"
if [ "$(id -u)" = "0" ]; then
    mkdir -p "$DATA_PATH"
    chown -R plembfin:plembfin "$DATA_PATH" 2>/dev/null || true
    if [ "${PLEMBFIN_DEMO_MODE:-}" = "1" ] && [ "${PLEMBFIN_DEMO_SEED:-1}" = "1" ]; then
        gosu plembfin node /app/scripts/seed-demo-catalog.js
    fi
    exec gosu plembfin "$@"
fi
if [ "${PLEMBFIN_DEMO_MODE:-}" = "1" ] && [ "${PLEMBFIN_DEMO_SEED:-1}" = "1" ]; then
    node /app/scripts/seed-demo-catalog.js
fi
exec "$@"
