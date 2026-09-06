#!/bin/sh
# Explicit public-source allowlist; never archive the workspace or operator data.
set -eu
cd "$(dirname "$0")/.."
test -f upstream/Cargo.lock || { echo 'Run scripts/fetch-upstream.sh first.' >&2; exit 1; }
set -- .dockerignore .gitignore .gitattributes .env.example .github AGENTS.md Dockerfile \
  Dockerfile.pipeline-test Dockerfile.gpu Dockerfile.gpu-display compose.yaml compose.gpu.yaml package.json package-lock.json \
  vitest.config.mjs LICENSE README.md UPSTREAM.md UPSTREAM_COMMIT \
  NODEJS_STANDARDS.md RUST_STANDARDS.md client config docs hermes patches \
  runtime scripts server test upstream
if [ -d assets ]; then set -- "$@" assets; fi
for public_doc in CONTRIBUTING.md SECURITY.md CHANGELOG.md; do
  if [ -f "$public_doc" ]; then set -- "$@" "$public_doc"; fi
done
# Directory allowlists are not secret detection. Exclude conventional operator
# state even for local packaging (which does not pass through .dockerignore).
# Nested .env examples are unnecessary; the explicit root .env.example stays.
set -- --exclude='*/target' --exclude='*/node_modules' --exclude='*/__pycache__' \
  --exclude='*.log' --exclude='*.pyc' --exclude='.DS_Store' --exclude='.env' \
  --exclude='*/.env.*' --exclude='*.pem' --exclude='*.key' --exclude='*.crt' \
  --exclude='*/secrets' --exclude='*/.git' --exclude='*/test-results' \
  --exclude='*/.access.json' "$@"
if [ "$(uname -s)" = Darwin ]; then
  COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata \
    -czf source.tar.gz "$@"
else
  tar -czf source.tar.gz "$@"
fi
