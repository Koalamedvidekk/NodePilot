#!/usr/bin/env bash
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
chmod +x "${DIR}/scripts/bootstrap.sh" 2>/dev/null || true
exec "${DIR}/scripts/bootstrap.sh" "$@"
