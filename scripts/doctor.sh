#!/bin/sh
# Read-only diagnostics; never prints environment, tokens or browser URLs.
set -eu
cd "$(dirname "$0")/.."
docker compose config --quiet
docker compose exec -T browserpane node /app/server/doctor.mjs
docker compose ps
echo 'Also verify trusted HTTPS and a live viewer connection from the intended client.'
echo 'These local checks do not prove DNS, CA trust or UDP reachability through a firewall.'
