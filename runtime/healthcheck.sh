#!/bin/sh
set -eu
test -S /tmp/bpane/agent.sock
curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null
curl -fsS --max-time 2 http://127.0.0.1:8090/healthz >/dev/null
