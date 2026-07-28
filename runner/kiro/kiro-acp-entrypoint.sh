#!/bin/sh
# A4 Kiro runner entrypoint.
#
# Loads the Kiro API key from the READ-ONLY secret file mounted at
# /run/secrets/kiro-api-key and exports it as KIRO_API_KEY for the kiro-cli
# child ONLY. The key is therefore never present in the container's Env
# (`docker inspect` shows no KIRO_API_KEY), never in argv, and never logged.
#
# Then exec the trusted command (kiro-cli acp …) supplied by the launcher.
set -eu

if [ -f /run/secrets/kiro-api-key ]; then
  KIRO_API_KEY="$(cat /run/secrets/kiro-api-key)"
  export KIRO_API_KEY
fi

exec "$@"
