#!/bin/bash
# Narrow, opt-in graphics adaptation. All non-graphics flags pass through.
bpane_chromium_args() {
  local mode=$1 arg
  shift
  BPANE_CHROMIUM_ARGS=()
  case "$mode" in
    cpu) BPANE_CHROMIUM_ARGS=("$@") ;;
    v3d)
      [ "${BPANE_X11_BACKEND:-dummy}" = xvnc ] || return 64
      for arg in "$@"; do
        case "$arg" in
          --disable-gpu|--disable-gpu=*|--disable-gpu-compositing|--disable-gpu-compositing=*|--use-gl=*|--use-angle=*) ;;
          --no-sandbox|--no-sandbox=*|--disable-gpu-sandbox|--disable-gpu-sandbox=*) return 64 ;;
          *) BPANE_CHROMIUM_ARGS+=("$arg") ;;
        esac
      done
      BPANE_CHROMIUM_ARGS+=(--use-gl=angle --use-angle=gles-egl
        --enable-gpu-rasterization --disable-gpu-vsync)
      ;;
    *) return 64 ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  set -euo pipefail
  bpane_chromium_args "${BPANE_GPU_MODE:-cpu}" "$@" || {
    echo 'Invalid GPU mode, X11 backend or sandbox flags' >&2; exit 64;
  }
  if [ "${BPANE_GPU_MODE:-cpu}" = v3d ]; then
    test -r /opt/browserpane/libbpane_gpu_sched.so
    test -r /dev/bpane-render && test -w /dev/bpane-render
    # Only Chromium inherits the workaround, never the host/gateway/X11 server.
    export MESA_SHADER_CACHE_DISABLE=true BPANE_GPU_SKIP_BATCH_SCHED=1
    export LD_PRELOAD=/opt/browserpane/libbpane_gpu_sched.so
  fi
  # Prevent the upstream restart loop reopening the profile during graceful shutdown.
  while [ -f /tmp/bpane/shutdown ]; do sleep 1; done
  echo "$$" > /tmp/bpane/chromium.pid
  exec /usr/bin/chromium "${BPANE_CHROMIUM_ARGS[@]}"
fi
