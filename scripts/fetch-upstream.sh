#!/bin/sh
set -eu
project_dir=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
cd "$project_dir"
# Never silently overwrite local edits in the ignored source snapshot.
if [ -d upstream ] && [ -n "$(ls -A upstream)" ]; then
  echo 'upstream already exists. Move it aside before fetching a fresh patched snapshot.' >&2
  exit 1
fi
commit=$(tr -d '\n' < UPSTREAM_COMMIT)
case "$commit" in *[!0-9a-f]*|'') echo 'Invalid UPSTREAM_COMMIT' >&2; exit 1;; esac
[ "${#commit}" -eq 40 ] || { echo 'UPSTREAM_COMMIT must be a full SHA' >&2; exit 1; }
checkout_dir=$(mktemp -d "${TMPDIR:-/tmp}/browserpane-checkout.XXXXXX")
snapshot_dir=$(mktemp -d "${TMPDIR:-/tmp}/browserpane-snapshot.XXXXXX")
cleanup() {
  # Exact owned temporary paths created above, never the checkout/workspace.
  rm -rf -- "$checkout_dir" "$snapshot_dir"
}
trap cleanup EXIT HUP INT TERM
git -C "$checkout_dir" init --quiet
git -C "$checkout_dir" remote add origin https://github.com/ITmedes/browserpane.git
git -C "$checkout_dir" fetch --quiet --depth 1 origin "$commit"
# Outside this Git worktree so git apply resolves paths relative to the snapshot.
[ "$(git -C "$checkout_dir" rev-parse FETCH_HEAD)" = "$commit" ]
git -C "$checkout_dir" archive FETCH_HEAD Cargo.toml Cargo.lock code/shared code/apps \
  code/web/bpane-client/js code/integrations/mcp-bridge/src/playwright-mcp-runtime.ts \
  openapi/bpane-control-v1.operations.json \
  deploy/xorg-dummy.conf deploy/start-host.sh deploy/host-runtime.env \
  deploy/bpane-ext deploy/chromium-policies/managed | tar -x -C "$snapshot_dir"
for patch_file in "$project_dir"/patches/*.patch; do
  [ -f "$patch_file" ] || continue
  (cd "$snapshot_dir" && git apply --check "$patch_file" && git apply "$patch_file")
done
if [ -d upstream ]; then rmdir upstream; fi
mv "$snapshot_dir" upstream
echo "Prepared upstream $commit with the ordered patches in patches/."
