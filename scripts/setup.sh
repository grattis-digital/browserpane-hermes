#!/bin/sh
# Prepare public Compose configuration only; never overwrite operator settings.
set -eu
cd "$(dirname "$0")/.."
umask 077
if [ -L .env ]; then
  echo 'Refusing to modify a symlinked .env; configure Compose manually.' >&2
  exit 1
fi
if [ ! -e .env ]; then cp -n .env.example .env; fi
docker compose config --quiet
echo 'Configuration prepared. Defaults bind only to this host.'
echo 'For LAN access, edit .env and read docs/SECURITY.md before starting.'
echo 'Next: docker compose up -d --build'
echo 'Then: ./scripts/doctor.sh and the TLS trust / Hermes setup steps in README.md.'
