#!/bin/sh
set -eu
umask 077
python /opt/hermes-bundle/bootstrap.py
if [ "$#" -eq 0 ]; then
    set -- gateway run
fi
if command -v "$1" >/dev/null 2>&1; then
    exec "$@"
fi
exec hermes "$@"
