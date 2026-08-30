#!/usr/bin/env bash
# native Linux一撃展開のroot phase。必ずuser向けwrapperからsudo/pkexec経由で呼ぶ。
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo 'FAIL: root権限が必要です' >&2; exit 1; }
[ "$#" -eq 1 ] || { echo 'FAIL: target userを1個指定してください' >&2; exit 1; }
target_user="$1"
[[ "$target_user" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || { echo 'FAIL: target userが不正です' >&2; exit 1; }
if [ "$target_user" = root ] || ! id "$target_user" >/dev/null 2>&1; then
  echo 'FAIL: target userが存在しません' >&2
  exit 1
fi
[ -r /etc/os-release ] || { echo 'FAIL: /etc/os-releaseがありません' >&2; exit 1; }
# shellcheck disable=SC1091 # OS vendor factsの標準入口。
. /etc/os-release
[ "${ID:-}" = ubuntu ] \
  || { echo "FAIL: 自動導入はUbuntuだけを対象とします（検出: ${ID:-unknown}）" >&2; exit 1; }

packages=(
  ca-certificates cron curl docker.io gh git jq make openssh-client
  python3 python3-venv ripgrep shellcheck tmux xz-utils
)
install_needed=false
for package_name in "${packages[@]}"; do
  if ! dpkg-query -W -f='${db:Status-Abbrev}' "$package_name" 2>/dev/null | grep -Fq 'ii '; then
    install_needed=true
    break
  fi
done
if [ "$install_needed" = true ]; then
  echo 'INFO: Ubuntu公式archiveから工場の前提packageを導入します'
  apt-get update
  env DEBIAN_FRONTEND=noninteractive apt-get install -y "${packages[@]}"
fi

systemctl enable --now cron
systemctl enable --now docker

if ! id -nG "$target_user" | tr ' ' '\n' | grep -Fqx docker; then
  echo "INFO: $target_user をdocker groupへ追加します"
  usermod -aG docker "$target_user"
fi
docker info >/dev/null
echo 'setup-linux-prerequisites-root: OK'
