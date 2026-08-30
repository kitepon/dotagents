#!/usr/bin/env bash
# 旧WSL2席は退役済み。履歴・旧wire互換は残すが現役展開は許可しない。
set -euo pipefail
echo 'FAIL: WSL2 hostは退役済みです。native Linux workstationはsetup-linux-workstation-factory.shを使ってください' >&2
exit 1
