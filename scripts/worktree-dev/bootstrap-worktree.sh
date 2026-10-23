#!/usr/bin/env bash
# Agent-neutral database/environment bootstrap; see README for application startup.
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "${SCRIPT_DIR}/lorefold-worktree-dev" setup "$@"
