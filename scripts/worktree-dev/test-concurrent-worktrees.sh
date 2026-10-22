#!/usr/bin/env bash
set -Eeuo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
export LOREFOLD_DOCKER_TESTS=1
exec python3 -m unittest discover -s "${SCRIPT_DIR}/tests" -p 'test_*.py' -v
