#!/bin/bash
# Reproduce native Linux host/gateway and private X11/MIT-SHM regressions.
# Only source and disposable build caches are mounted. No production service,
# profile, Docker socket, GPU device, or host X11 socket is accessed.
set -euo pipefail

project_dir=$(cd "$(dirname "$0")/.." && pwd)
test_image=${BPANE_PIPELINE_TEST_IMAGE:-browserpane-hermes:pipeline-test-toolchain}
test_name=${BPANE_PIPELINE_TEST_NAME:-browserpane-pipeline-tests-$$}
registry_volume=${BPANE_PIPELINE_TEST_REGISTRY_VOLUME:-browserpane-pipeline-cargo}
target_volume=${BPANE_PIPELINE_TEST_TARGET_VOLUME:-browserpane-pipeline-target}
cargo_jobs=${BPANE_PIPELINE_TEST_JOBS:-2}
docker_cli=(docker)
if [ "${BPANE_DOCKER_SUDO:-0}" = 1 ]; then docker_cli=(sudo -n docker); fi

case "$test_name" in browserpane-pipeline-tests-*) ;; *) echo 'Expected a browserpane-pipeline-tests-* container name' >&2; exit 64 ;; esac
for cache_volume in "$registry_volume" "$target_volume"; do
  case "$cache_volume" in browserpane-pipeline-*) ;; *) echo 'Expected browserpane-pipeline-* cache volume names' >&2; exit 64 ;; esac
done
if ! [[ "$cargo_jobs" =~ ^[1-9][0-9]*$ ]]; then
  echo 'BPANE_PIPELINE_TEST_JOBS must be a positive integer' >&2; exit 64
fi
for required_source in Cargo.toml Cargo.lock openapi/bpane-control-v1.operations.json; do
  if [ ! -f "$project_dir/upstream/$required_source" ]; then
    echo "Missing upstream/$required_source; materialize the patched upstream source first" >&2
    exit 1
  fi
done
for container_name in "$test_name" "$test_name-fetch"; do
  if "${docker_cli[@]}" container inspect "$container_name" >/dev/null 2>&1; then
    echo "$container_name already exists; inspect it before retrying" >&2; exit 1
  fi
done

cleanup() {
  for container_name in "$test_name" "$test_name-fetch"; do
    if [ "$("${docker_cli[@]}" inspect --format '{{index .Config.Labels "browserpane.test.run"}}' "$container_name" 2>/dev/null || true)" = "$test_name" ]; then
      # --rm removes only this run's disposable container. Build caches remain.
      "${docker_cli[@]}" stop --time 10 "$container_name" >/dev/null 2>&1 || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${BPANE_PIPELINE_TEST_SKIP_BUILD:-0}" != 1 ]; then
  # The toolchain Dockerfile has no COPY instructions. Feeding just that file
  # avoids uploading a potentially multi-gigabyte upstream build tree.
  "${docker_cli[@]}" build --tag "$test_image" - < "$project_dir/Dockerfile.pipeline-test"
else
  "${docker_cli[@]}" image inspect "$test_image" >/dev/null
fi

common_args=(
  --rm --init --restart=no
  --label browserpane.test=pipeline-linux-tests --label "browserpane.test.run=$test_name"
  --cap-drop ALL --security-opt no-new-privileges:true
  --memory 3g --cpu-shares 512 --pids-limit 512 --shm-size 128m
  --mount "type=bind,src=$project_dir/upstream,dst=/src,readonly"
  --mount "type=volume,src=$registry_volume,dst=/usr/local/cargo/registry"
  --mount "type=volume,src=$target_volume,dst=/build-target"
  --workdir /src -e "CARGO_BUILD_JOBS=$cargo_jobs"
)

if [ "${BPANE_PIPELINE_TEST_OFFLINE:-0}" != 1 ]; then
  # Only dependency fetching has network access; the actual tests are isolated.
  "${docker_cli[@]}" run "${common_args[@]}" --name "$test_name-fetch" --network bridge \
    "$test_image" cargo fetch --locked
fi

"${docker_cli[@]}" run -i "${common_args[@]}" --name "$test_name" --network none \
  "$test_image" bash -se <<'CONTAINER_TESTS'
set -euo pipefail
cargo test --locked --offline -p bpane-host -p bpane-gateway

registered_listener_tests=$(cargo test --locked --offline -p bpane-gateway listener_tests:: -- --list)
for regression in \
  omitted_api_bind_preserves_existing_bind_contract \
  private_api_bind_does_not_move_public_transport \
  invalid_api_bind_fails_without_falling_back_to_public; do
  case "$registered_listener_tests" in
    *"listener_tests::$regression: test"*) ;;
    *) echo "Missing gateway listener regression: $regression" >&2; exit 1 ;;
  esac
done
cargo test --locked --offline -p bpane-gateway listener_tests:: -- --test-threads=1

# cargo test succeeds when a filter matches nothing. Check registration first
# so an unpatched checkout cannot silently claim these regressions passed.
registered_capture_tests=$(cargo test --locked --offline -p bpane-host -p bpane-gateway \
  capture::x11::tests:: -- --ignored --list)
for regression in \
  tile_damage_preserves_small_repeated_final_updates \
  tile_damage_survives_processing_window \
  tile_geometry_refresh_grows_undersized_shm \
  tile_shm_capture_reuses_caller_buffer \
  nonempty_damage_remains_pending_until_next_capture \
  damage_subtract_does_not_self_trigger \
  capture_returns_none_when_no_damage; do
  case "$registered_capture_tests" in
    *"capture::x11::tests::$regression: test"*) ;;
    *) echo "Missing ignored X11 regression: $regression; check the upstream patches" >&2; exit 1 ;;
  esac
done

# A display owned by this test container, never the user's/production display.
Xvfb :87 -screen 0 1280x720x24 -nolisten tcp -ac &
capture_x11_pid=$!
cleanup_x11() {
  kill "$capture_x11_pid" 2>/dev/null || true
  wait "$capture_x11_pid" 2>/dev/null || true
}
trap cleanup_x11 EXIT
export DISPLAY=:87
display_ready=0
for attempt in $(seq 1 50); do
  if xrandr --current >/dev/null 2>&1; then display_ready=1; break; fi
  if ! kill -0 "$capture_x11_pid" 2>/dev/null; then break; fi
  sleep 0.1
done
if [ "$display_ready" != 1 ]; then echo 'Private Xvfb did not become ready' >&2; exit 1; fi

# Run serially: these tests deliberately repaint the same disposable root.
cargo test --locked --offline -p bpane-host -p bpane-gateway \
  capture::x11::tests::tile_ -- --ignored --test-threads=1
for regression in \
  nonempty_damage_remains_pending_until_next_capture \
  damage_subtract_does_not_self_trigger \
  capture_returns_none_when_no_damage; do
  cargo test --locked --offline -p bpane-host -p bpane-gateway \
    "capture::x11::tests::$regression" -- --exact --ignored --test-threads=1
done
for regression in \
  tile_loop::readback::x11_tests::regional_x11_pixels_preserve_damage_arriving_after_acknowledgement \
  capture::x11::regional::tests::regional_and_packed_reads_account_for_shm_and_getimage_without_extra_owned_copy \
  tile_loop::classify_integration_tests::damage_directed_classification_preserves_video_state_through_hint_gaps; do
  registered=$(cargo test --locked --offline -p bpane-host "$regression" -- --ignored --list)
  case "$registered" in *"$regression: test"*) ;; *) echo "Missing $regression" >&2; exit 1 ;; esac
  cargo test --locked --offline -p bpane-host "$regression" -- --exact --ignored --test-threads=1
done
echo 'Linux host/gateway, nine X11 capture regressions and classifier lifecycle regression passed.'
CONTAINER_TESTS

echo "Disposable test containers removed; reusable caches retained: $registry_volume, $target_volume"
