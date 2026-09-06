#!/bin/bash
# Browser restarts are checked again; do not silently retain software fallback.
set -euo pipefail
failures=0
while sleep 5; do
  if node /app/server/check-gpu.mjs; then failures=0; else failures=$((failures + 1)); fi
  [ "$failures" -lt 3 ] || exit 1
done
