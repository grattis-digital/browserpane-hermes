#!/bin/bash
set -eu
# Prevent the upstream restart loop reopening the profile during graceful shutdown.
while [ -f /tmp/bpane/shutdown ]; do sleep 1; done
echo "$$" > /tmp/bpane/chromium.pid
exec /usr/bin/chromium "$@"
