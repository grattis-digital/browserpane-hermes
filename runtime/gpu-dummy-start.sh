#!/bin/bash
# Experimental display/encoder only; never starts Chromium or touches a profile.
set -euo pipefail
export DISPLAY=:99 BPANE_GPU_TAIL=1 BPANE_GPU_LEASE=1 BPANE_GPU_LEASE_LAYOUT=uif
test -r /dev/bpane-render && test -w /dev/bpane-render
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99
/usr/lib/xorg/Xorg :99 -config /etc/X11/bpane.conf -logfile /tmp/Xorg.log \
  -nolisten tcp -noreset -nocursor -ac &
display_pid=$!
encoder_pid=""
watch_pid=""
cleanup() {
  trap - TERM INT EXIT
  if [ -n "$encoder_pid" ]; then kill -TERM "$encoder_pid" 2>/dev/null || true; fi
  if [ -n "$watch_pid" ]; then kill -TERM "$watch_pid" 2>/dev/null || true; fi
  kill -TERM "$display_pid" 2>/dev/null || true
  for attempt in $(seq 1 20); do
    if ! kill -0 "$display_pid" 2>/dev/null && { [ -z "$encoder_pid" ] || ! kill -0 "$encoder_pid" 2>/dev/null; }; then break; fi
    sleep 0.1
  done
  if [ -n "$encoder_pid" ]; then kill -KILL "$encoder_pid" 2>/dev/null || true; fi
  if [ -n "$watch_pid" ]; then kill -KILL "$watch_pid" 2>/dev/null || true; fi
  kill -KILL "$display_pid" 2>/dev/null || true
  wait || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
ready=0
for attempt in $(seq 1 150); do
  kill -0 "$display_pid"
  if timeout 2 xdpyinfo -queryExtensions 2>/dev/null | grep BPANE-GPU-LEASE >/dev/null; then ready=1; break; fi
  sleep 0.2
done
[ "$ready" = 1 ] || { echo 'GPU lease display did not become ready' >&2; exit 1; }
read -r generation < /proc/sys/kernel/random/uuid
xprop -root -f _BPANE_X11_INSTANCE 8s -set _BPANE_X11_INSTANCE "$generation"
bpane-vulkan-probe --listen &
encoder_pid=$!
watch_health() {
  local failures=0
  while sleep 5; do
    if bpane-vulkan-probe --health; then failures=0; else failures=$((failures + 1)); fi
    if [ "$failures" -ge 3 ]; then
      echo 'GPU supervisor health failed repeatedly; restarting display' >&2
      return 1
    fi
  done
}
watch_health &
watch_pid=$!
wait -n "$display_pid" "$encoder_pid" "$watch_pid"
exit 1
