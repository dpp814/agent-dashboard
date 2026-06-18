#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

PORT="${AGENT_MONITOR_PORT:-8787}"
PID_FILE=".agent-monitor/agent-monitor-${PORT}.pid"
LOG_FILE="app.log"

mkdir -p .agent-monitor

stop_pid() {
  pid="$1"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -CONT "$pid" 2>/dev/null || true
  kill "$pid" 2>/dev/null || return 0

  i=0
  while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 20 ]; do
    sleep 0.1
    i=$((i + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
  fi
}

if [ -f "$PID_FILE" ]; then
  stop_pid "$(cat "$PID_FILE")"
fi

if command -v ss >/dev/null 2>&1; then
  ss -ltnp 2>/dev/null \
    | grep ":${PORT}" \
    | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' \
    | while read -r pid; do
      stop_pid "$pid"
    done
fi

npm run build

printf '\n[%s] restarting Agent Monitor on port %s\n' "$(date -Iseconds)" "$PORT" >> "$LOG_FILE"
if command -v setsid >/dev/null 2>&1; then
  setsid sh -c "exec node apps/server/dist/index.js </dev/null >> '$LOG_FILE' 2>&1" &
else
  nohup sh -c "exec node apps/server/dist/index.js </dev/null >> '$LOG_FILE' 2>&1" >/dev/null 2>&1 &
fi
echo "$!" > "$PID_FILE"

echo "Agent Monitor restarted in background, pid $!"
echo "Logs: $(pwd)/$LOG_FILE"
