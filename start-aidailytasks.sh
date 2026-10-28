#!/usr/bin/env bash
# Starts the AiDailyTasks board (server on :4317 + web UI) if it isn't already running.
set -euo pipefail

APP_DIR="/c/Code/AIDailyTask"
LOG_DIR="$APP_DIR/logs"
LOG_FILE="$LOG_DIR/startup.log"

mkdir -p "$LOG_DIR"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG_FILE"
}

# Skip if the server is already listening on 4317
if netstat -ano | grep -q "127.0.0.1:4317.*LISTENING"; then
    log "AiDailyTasks already running on :4317 - nothing to do."
    exit 0
fi

# The port check races when two launches happen within the server's boot time,
# so also take a lock; treat locks older than 5 minutes as stale from a crash.
LOCK_DIR="$APP_DIR/logs/start.lock"
if mkdir "$LOCK_DIR" 2>/dev/null; then
    trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
elif [ -n "$(find "$LOCK_DIR" -maxdepth 0 -mmin +5 2>/dev/null)" ]; then
    log "Removing stale lock and continuing."
    trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT
else
    log "Another launch is already in progress - nothing to do."
    exit 0
fi

log "Starting AiDailyTasks (npm run dev)..."
cd "$APP_DIR"

# Detach so the board keeps running after this script exits
nohup npm run dev >> "$LOG_DIR/board.log" 2>&1 &
log "Started with PID $!"

# Hold the lock until the server is actually up (or 60s), so a second
# launch during boot can't slip past the port check above.
for _ in $(seq 1 60); do
    if netstat -ano | grep -q "127.0.0.1:4317.*LISTENING"; then
        log "Server is listening on :4317."
        exit 0
    fi
    sleep 1
done
log "WARNING: server not listening on :4317 after 60s - check board.log."
