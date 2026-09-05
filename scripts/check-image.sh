#!/bin/sh
# Compatibility entry point: runtime, MCP/downloads, restart/recreate persistence.
set -eu
cd "$(dirname "$0")/.."
exec node scripts/test-runtime.mjs "${1:-browserpane-hermes:test}"
