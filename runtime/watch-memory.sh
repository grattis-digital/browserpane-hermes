#!/bin/bash
# A renderer OOM does not necessarily terminate Chromium or the container.
# Request the wrapper's normal graceful shutdown, then Docker owns restart.
set -euo pipefail
events=${1:-/sys/fs/cgroup/memory.events}
if [ "$events" = --baseline ]; then events=/sys/fs/cgroup/memory.events; fi
interval=${2:-5}
[[ "$interval" =~ ^[0-9]+([.][0-9]+)?$ ]] || exit 64
counter() {
  local key value rest found=""
  while read -r key value rest || [ -n "$key" ]; do
    if [ "$key" = oom_kill ]; then
      [ -z "$found" ] && [ -z "$rest" ] || return 1
      [[ "$value" =~ ^(0|[1-9][0-9]{0,17})$ ]] || return 1
      found=$value
    fi
  done < "$events"
  [ -n "$found" ] || return 1
  printf '%s\n' "$found"
}
if [ "${1:-}" = --baseline ]; then counter; exit; fi
baseline=${3:-$(counter)} || { echo 'Memory watchdog could not read initial OOM counter' >&2; exit 1; }
[[ "$baseline" =~ ^(0|[1-9][0-9]{0,17})$ ]] || { echo 'Memory watchdog could not read initial OOM counter' >&2; exit 1; }
failures=0
while sleep "$interval"; do
  if current=$(counter); then
    failures=0
    if [ "$current" -ne "$baseline" ]; then
      echo 'Memory watchdog: OOM counter changed; requesting graceful session recovery' >&2
      exit 1
    fi
  else
    failures=$((failures + 1))
    if [ "$failures" -ge 3 ]; then
      echo 'Memory watchdog: OOM counter unavailable; requesting graceful session recovery' >&2
      exit 1
    fi
  fi
done
