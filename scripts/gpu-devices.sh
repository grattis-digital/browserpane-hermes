#!/bin/bash
# Read-only: emit stable Compose assignments, never mutate devices/udev/config.
set -euo pipefail
[ "$(uname -s)" = Linux ] || { echo 'GPU discovery requires the Linux Docker host' >&2; exit 64; }
render_node= display_node=
for device in /dev/dri/by-path/*; do
  [ -L "$device" ] || continue
  resolved=$(readlink -f "$device")
  [ -c "$resolved" ] || continue
  node=${resolved##*/}
  driver=$(basename "$(readlink -f "/sys/class/drm/$node/device/driver")")
  case "$node:$driver" in
    renderD*:v3d)
      [ -z "$render_node" ] || { echo 'Multiple V3D render devices; select explicitly' >&2; exit 1; }
      render_node=$device ;;
    card*:vc4-drm)
      [ -z "$display_node" ] || { echo 'Multiple VC4 display devices; select explicitly' >&2; exit 1; }
      display_node=$device ;;
  esac
done
[ -n "$render_node" ] && [ -n "$display_node" ] || {
  echo 'Require stable /dev/dri/by-path V3D render and VC4 display links; do not hard-code card numbers' >&2; exit 1;
}
printf 'BPANE_GPU_RENDER_DEVICE=%s\nBPANE_GPU_DISPLAY_DEVICE=%s\n' "$render_node" "$display_node"
printf 'BPANE_GPU_RENDER_GID=%s\nBPANE_GPU_DISPLAY_GID=%s\n' \
  "$(stat -Lc '%g' "$render_node")" "$(stat -Lc '%g' "$display_node")"
