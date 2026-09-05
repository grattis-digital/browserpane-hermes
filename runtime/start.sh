#!/bin/bash
# Lifecycle only: capture, browser flags, display and audio use the pinned startup script.
set -euo pipefail
umask 077
node /app/server/check-settings.mjs
# MCP shares this network namespace and uses loopback CDP directly.
export BPANE_CDP_PROXY_ENABLE=0 BPANE_CHROMIUM_DEBUG_ADDRESS=127.0.0.1
mkdir -p "$XDG_RUNTIME_DIR" /data/profile /shared/downloads /tmp/bpane
children=()
host_group=""
shutdown() {
  trap - TERM INT EXIT
  touch /tmp/bpane/shutdown
  # Keep Xorg alive while CDP closes Chromium and flushes its profile.
  node /app/server/close-browser.mjs || true
  if [ -f /tmp/bpane/chromium.pid ]; then
    browser_pid=$(</tmp/bpane/chromium.pid)
    for attempt in $(seq 1 60); do
      if ! kill -0 "$browser_pid" 2>/dev/null; then break; fi
      sleep 0.1
    done
  fi
  if [ -n "$host_group" ]; then kill -TERM -- "-$host_group" 2>/dev/null || true; fi
  for pid in "${children[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  wait || true
}
trap shutdown TERM INT EXIT
setsid bash /app/upstream/start-host.sh &
host_group=$!
children+=("$host_group")
for attempt in $(seq 1 150); do
  if [ -S "$BPANE_SOCKET_PATH" ] && curl -fsS http://127.0.0.1:9222/json/version >/dev/null 2>&1; then break; fi
  kill -0 "$host_group"
  sleep 0.2
done
test -S "$BPANE_SOCKET_PATH"
curl -fsS http://127.0.0.1:9222/json/version >/dev/null
node /app/server/gateway-process.mjs &
children+=("$!")
node /app/server/mcp-process.mjs &
children+=("$!")
node /app/server/main.mjs &
children+=("$!")
wait -n "${children[@]}"
exit 1
