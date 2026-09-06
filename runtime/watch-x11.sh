#!/bin/bash
# Losing/replacing an external display invalidates Chrome/capture connections.
# Exit so the ordinary container supervisor can restart the complete session.
set -euo pipefail
read_generation() { timeout 3 xprop -root _BPANE_X11_INSTANCE; }
initial=$(read_generation)
[[ "$initial" == '_BPANE_X11_INSTANCE(STRING) = "'* ]] || exit 1
failures=0
while sleep 2; do
  if ! current=$(read_generation); then
    failures=$((failures + 1))
    [ "$failures" -lt 3 ] || exit 1
    continue
  fi
  failures=0
  [ "$current" = "$initial" ] || exit 1
done
