#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DOTAGENTS_SETUP_TEST_VARIANT=server exec "$ROOT/tests/install/setup-linux-common.sh"
