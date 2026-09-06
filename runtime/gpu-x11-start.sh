#!/bin/bash
# This sidecar owns display :99, its Unix socket, and no browser/profile.
set -euo pipefail
export DISPLAY=:99
test -r /dev/bpane-render && test -w /dev/bpane-render
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
/usr/bin/Xtigervnc :99 -geometry 1280x720 -depth 24 \
  -rendernode /dev/bpane-render -rfbport -1 \
  -rfbunixpath /tmp/unused-vnc.sock -rfbunixmode 0600 \
  -localhost -nolisten tcp -SecurityTypes None -ac -noreset -nocursor &
display_pid=$!
cleanup() { kill -TERM "$display_pid" 2>/dev/null || true; wait "$display_pid" || true; }
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
ready=0
for attempt in $(seq 1 150); do
  kill -0 "$display_pid"
  # Drain xdpyinfo: grep -q can close its pipe early and turn success into
  # SIGPIPE under pipefail when the server advertises many visuals.
  if timeout 2 xdpyinfo -queryExtensions 2>/dev/null | grep DRI3 >/dev/null; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" = 1 ] || { echo 'Xvnc did not provide DRI3' >&2; exit 1; }
read -r generation < /proc/sys/kernel/random/uuid
xprop -root -f _BPANE_X11_INSTANCE 8s -set _BPANE_X11_INSTANCE "$generation"
failures=0
while sleep 2; do
  kill -0 "$display_pid"
  if timeout 3 xprop -root _BPANE_X11_INSTANCE >/dev/null 2>&1; then
    failures=0
  else
    failures=$((failures + 1))
    [ "$failures" -lt 3 ] || { echo 'X11 display stopped responding' >&2; exit 1; }
  fi
done
