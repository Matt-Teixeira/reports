#!/bin/bash
set -e

# Default to svc if RUN_USER not specified
RUN_USER="${RUN_USER:-svc}"

# Dynamically set HOME based on user
export HOME="/home/$RUN_USER"

# Repair the log directory while still root, BEFORE gosu drops privileges.
# Docker creates a missing bind-mount source as root:root, and the logger
# dies EACCES inside createWriteStream -- before any logging exists to say
# why. This is reports' ONLY writable directory (no other file writers).
# Only a root-owned directory is repaired: one somebody deliberately chowned
# (e.g. /opt/run-logs/reports as svc:docker) is left alone.
LOG_MOUNT=/workspace/utils/logger/logs
mkdir -p "$LOG_MOUNT"
if [ "$(stat -c %u "$LOG_MOUNT")" = "0" ]; then
    echo "entrypoint: $LOG_MOUNT is root-owned (Docker created it) — chowning to $RUN_USER:docker"
    chown "$RUN_USER":docker "$LOG_MOUNT" || true
    chmod 2775 "$LOG_MOUNT" || true
fi

# Execute command as the specified user
exec gosu "$RUN_USER" "$@"
