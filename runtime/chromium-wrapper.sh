#!/bin/bash
# Narrow, opt-in graphics adaptation. All non-graphics flags pass through.
bpane_chromium_args() {
  local mode=$1 arg decode=${BPANE_GPU_DECODE:-off}
  local disabled_features=AcceleratedVideoDecodeLinuxZeroCopyGL
  shift
  BPANE_CHROMIUM_ARGS=()
  case "$decode" in
    off) ;;
    v4l2) [ "$mode" = v3d ] && [ "${BPANE_X11_BACKEND:-dummy}" = gpu-dummy ] || return 64 ;;
    *) return 64 ;;
  esac
  case "$mode" in
    cpu) BPANE_CHROMIUM_ARGS=("$@") ;;
    v3d)
      [ "${BPANE_X11_BACKEND:-dummy}" = gpu-dummy ] || return 64
      for arg in "$@"; do
        case "$arg" in
          --disable-gpu|--disable-gpu=*|--disable-gpu-compositing|--disable-gpu-compositing=*|--use-gl=*|--use-angle=*) ;;
          --no-sandbox|--no-sandbox=*|--disable-gpu-sandbox|--disable-gpu-sandbox=*) return 64 ;;
          --disable-features=*)
            if [ "$decode" = v4l2 ]; then
              [ -z "${arg#*=}" ] || disabled_features+=",${arg#*=}"
            else
              BPANE_CHROMIUM_ARGS+=("$arg")
            fi
            ;;
          *) BPANE_CHROMIUM_ARGS+=("$arg") ;;
        esac
      done
      BPANE_CHROMIUM_ARGS+=(--use-gl=angle --use-angle=gles-egl
        --enable-gpu-rasterization --disable-gpu-vsync)
      ;;
    *) return 64 ;;
  esac
  if [ "$decode" = v4l2 ]; then
    # RPi's launcher otherwise adds its own ANGLE backend and suppresses
    # policy extension networking. Put launcher options before any URL.
    # NV12 native-pixmap import fails on this X11/ANGLE stack. Request the
    # decoder's BGR4 output instead; hardware decoding and sandbox stay on.
    # Merge feature switches so this cannot erase the caller's disabled list.
    BPANE_CHROMIUM_ARGS=(--no-gl-override --enable-remote-extensions
      "--disable-features=$disabled_features" "${BPANE_CHROMIUM_ARGS[@]}")
  fi
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
  if [ "${BPANE_GPU_DECODE:-off}" = v4l2 ]; then
    test -c /dev/video10 && test -r /dev/video10 && test -w /dev/video10
    IFS=: read -r decode_major decode_minor < <(stat -Lc '%t:%T' /dev/video10)
    test "$(cat "/sys/dev/char/$((16#$decode_major)):$((16#$decode_minor))/name")" = bcm2835-codec-decode
    # Read-only startup identity check. Fail closed on a stale/non-Pi image.
    test "$(dpkg-query -W -f='${Version}' chromium)" = '1:152.0.7977.82-1~deb12u1+rpt1'
  fi
  # Prevent the upstream restart loop reopening the profile during graceful shutdown.
  while [ -f /tmp/bpane/shutdown ]; do sleep 1; done
  echo "$$" > /tmp/bpane/chromium.pid
  exec /usr/bin/chromium "${BPANE_CHROMIUM_ARGS[@]}"
fi
