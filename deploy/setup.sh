#!/usr/bin/env bash
# The former installer reset Git and rewrote nginx/systemd; keep it disabled.
set -euo pipefail
printf '%s\n' 'deploy/setup.sh is retired. Use deploy/upgrade-v2.sh from a reviewed main checkout.' >&2
printf '%s\n' 'The upgrade script backs up .env and .local-data and preserves nginx TLS and the existing backend unit.' >&2
exit 1
