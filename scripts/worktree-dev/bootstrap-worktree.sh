#!/usr/bin/env bash
# Agent-neutral infrastructure bootstrap. No app dependencies exist yet.
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec "${SCRIPT_DIR}/lorefold-worktree-dev" setup "$@"
