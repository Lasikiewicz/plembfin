#!/bin/sh
set -e
# When the container starts as root (the default on most Docker setups), fix
# /data ownership so the non-root plembfin user can write to a host-mounted
# volume, then drop privilege and exec the real process.
if [ "$(id -u)" = "0" ]; then
    chown -R plembfin:plembfin /data 2>/dev/null || true
    exec gosu plembfin "$@"
fi
exec "$@"
