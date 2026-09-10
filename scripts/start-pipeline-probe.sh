#!/bin/bash
# Disposable full X11/Chromium stack: no production ports, profile, or network.
set -euo pipefail
project_dir=$(cd "$(dirname "$0")/.." && pwd)
probe_image=${BPANE_PIPELINE_IMAGE:-browserpane-hermes:test}
probe_name=${BPANE_PIPELINE_NAME:-browserpane-pipeline-probe}
probe_run=${BPANE_PIPELINE_RUN_ID:-$probe_name}
case "$probe_name" in browserpane-pipeline-*) ;; *) echo 'Expected browserpane-pipeline-* test name' >&2; exit 64 ;; esac
if ! [[ "$probe_run" =~ ^[a-zA-Z0-9-]{1,80}$ ]]; then echo 'Invalid disposable run marker' >&2; exit 64; fi
docker_cli=(docker)
network_args=(--network none)
capture_args=()
case "${BPANE_EXPERIMENTAL_DAMAGE_READBACK:-0}" in 0|1) ;; *) echo 'Damage readback flag must be 0 or 1' >&2; exit 64 ;; esac
case "${BPANE_EXPERIMENTAL_DAMAGE_ANALYSIS:-0}" in 0|1) ;; *) echo 'Damage analysis flag must be 0 or 1' >&2; exit 64 ;; esac
if [ -n "${BPANE_SCROLL_COPY_QUANTUM_PX:-}" ]; then
  if ! [[ "$BPANE_SCROLL_COPY_QUANTUM_PX" =~ ^[0-9]+$ ]] || [ "$BPANE_SCROLL_COPY_QUANTUM_PX" -gt 512 ]; then
    echo 'BPANE_SCROLL_COPY_QUANTUM_PX must be an integer from 0 to 512' >&2; exit 64
  fi
  capture_args=(-e "BPANE_SCROLL_COPY_QUANTUM_PX=$BPANE_SCROLL_COPY_QUANTUM_PX")
fi
if [ -n "${BPANE_CDP_SCROLL_SNAP_CSS_PX:-}" ]; then
  if ! [[ "$BPANE_CDP_SCROLL_SNAP_CSS_PX" =~ ^[0-9]+$ ]] || [ "$BPANE_CDP_SCROLL_SNAP_CSS_PX" -gt 256 ]; then
    echo 'Scroll snap must be an integer from 0 to 256' >&2; exit 64
  fi
  capture_args+=(-e "BPANE_CDP_SCROLL_SNAP_CSS_PX=$BPANE_CDP_SCROLL_SNAP_CSS_PX")
fi
viewer_origin=https://localhost
gateway_url=https://localhost:4433
if [ "${BPANE_PIPELINE_VIEWER:-0}" = 1 ]; then
  # Optional local-only WebTransport qualification; never publishes on the LAN.
  network_args=(--network bridge --publish 127.0.0.1:18090:8090 --publish 127.0.0.1:24433:4433/udp)
  viewer_origin=http://localhost:18090
  gateway_url=https://localhost:24433
fi
if [ "${BPANE_DOCKER_SUDO:-0}" = 1 ]; then docker_cli=(sudo -n docker); fi
if "${docker_cli[@]}" container inspect "$probe_name" >/dev/null 2>&1; then
  echo "$probe_name exists; inspect it before retrying" >&2; exit 1
fi
"${docker_cli[@]}" run -d --name "$probe_name" --label browserpane.test=pipeline --label "browserpane.test.run=$probe_run" \
  "${network_args[@]}" --restart=no --cap-drop ALL --security-opt no-new-privileges:true \
  --security-opt "seccomp=$project_dir/runtime/chromium-seccomp.json" \
  --memory 2300m --cpu-shares 512 --pids-limit 512 --shm-size 512m \
  --tmpfs /tmp:size=256m,mode=1777,nosuid,nodev \
  --tmpfs /data:size=256m,uid=10000,gid=10000,mode=0700 \
  --tmpfs /shared:size=128m,uid=10000,gid=10000,mode=0700 \
  --env-file "$project_dir/runtime/host-runtime.env" \
  ${capture_args[@]+"${capture_args[@]}"} \
  -e VIEWER_ORIGIN="$viewer_origin" -e GATEWAY_URL="$gateway_url" \
  -e BPANE_URL=about:blank -e BPANE_DEVICE_SCALE=1 -e BPANE_PIPELINE_TEST=1 \
  -e BPANE_CAPTURE_TIMINGS="${BPANE_CAPTURE_TIMINGS:-0}" \
  -e BPANE_EXPERIMENTAL_DAMAGE_READBACK="${BPANE_EXPERIMENTAL_DAMAGE_READBACK:-0}" \
  -e BPANE_EXPERIMENTAL_DAMAGE_ANALYSIS="${BPANE_EXPERIMENTAL_DAMAGE_ANALYSIS:-0}" \
  -e BPANE_CHROMIUM_SANDBOX_MODE=strict -e BPANE_CHROMIUM_EXTRA_FLAGS=--disable-setuid-sandbox \
  -e BPANE_CHROMIUM_DEBUG_ADDRESS=127.0.0.1 -e RUST_LOG=warn \
  "$probe_image"
for attempt in $(seq 1 90); do
  if "${docker_cli[@]}" exec "$probe_name" curl -fsS http://127.0.0.1:8090/healthz >/dev/null 2>&1; then
    echo 'Disposable capture probe ready'; exit 0
  fi
  if [ "$("${docker_cli[@]}" inspect "$probe_name" --format '{{.State.Running}}')" != true ]; then break; fi
  sleep 1
done
"${docker_cli[@]}" logs --tail 30 "$probe_name"
echo 'Probe failed readiness; retained for inspection' >&2
exit 1
