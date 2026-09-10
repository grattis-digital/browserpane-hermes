#!/bin/bash
# Installed ONLY in a disposable experimental image at /usr/bin/chromium.
# The normal GPU/sandbox wrapper still runs first and passes all other flags.
bpane_custom_chromium_args() {
  local mode=$1 arg prefix seen=0
  shift
  case "$mode" in
    0) prefix=--disable-features= ;;
    1) prefix=--enable-features= ;;
    *) return 64 ;;
  esac
  BPANE_CUSTOM_ARGS=()
  for arg in "$@"; do
    case "$arg" in
      --no-sandbox|--no-sandbox=*|--disable-gpu-sandbox|--disable-gpu-sandbox=*) return 64 ;;
      --enable-features=*BrowserPaneSurfaceDamage*|--disable-features=*BrowserPaneSurfaceDamage*) return 64 ;;
    esac
    if [[ "$arg" == "$prefix"* ]]; then
      arg="${arg%,},BrowserPaneSurfaceDamage"
      # An empty existing list needs no leading comma.
      arg=${arg/=,/=}
      seen=1
    fi
    BPANE_CUSTOM_ARGS+=("$arg")
  done
  if [ "$seen" = 0 ]; then BPANE_CUSTOM_ARGS+=("${prefix}BrowserPaneSurfaceDamage"); fi
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  [ "${BPANE_PIPELINE_TEST:-}" = 1 ] || { echo 'Custom Chromium requires a disposable test' >&2; exit 64; }
  test_token=${BPANE_RENDER_PILOT:-${BPANE_RUNTIME_TEST_ID:-}}
  [[ "$test_token" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || exit 64
  bpane_custom_chromium_args "${BPANE_CUSTOM_DAMAGE:-0}" "$@" || exit 64
  exec /opt/browserpane-chromium/chrome "${BPANE_CUSTOM_ARGS[@]}"
fi
