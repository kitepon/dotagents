#!/usr/bin/env bash
# native Linux一撃展開のroot phase。必ずuser向けwrapperからsudo/pkexec経由で呼ぶ。
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo 'FAIL: root権限が必要です' >&2; exit 1; }
[ "$#" -eq 2 ] || { echo 'FAIL: target userとsetup variantを指定してください' >&2; exit 1; }
target_user="$1"
setup_variant="$2"
[[ "$target_user" =~ ^[a-z_][a-z0-9_-]*$ ]] \
  || { echo 'FAIL: target userが不正です' >&2; exit 1; }
case "$setup_variant" in
  server|linux) ;;
  *) echo 'FAIL: setup variantが不正です' >&2; exit 1 ;;
esac
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
  ca-certificates cron curl gh git jq make openssh-client openssh-server
  python3 python3-venv ripgrep shellcheck tmux xz-utils
)
missing_packages=()
for package_name in "${packages[@]}"; do
  if ! dpkg-query -W -f='${db:Status-Abbrev}' "$package_name" 2>/dev/null | grep -Fq 'ii '; then
    missing_packages+=("$package_name")
  fi
done
if [ "${#missing_packages[@]}" -gt 0 ]; then
  echo 'INFO: Ubuntu公式archiveから工場の前提packageを導入します'
  apt-get update
  env DEBIAN_FRONTEND=noninteractive apt-get install -y "${missing_packages[@]}"
fi

# 既存Engineの配布元は保持する。未導入時だけDocker公式apt repositoryを使う。
if ! dpkg-query -W -f='${db:Status-Abbrev}' docker-ce 2>/dev/null | grep -Fq 'ii ' \
  && ! dpkg-query -W -f='${db:Status-Abbrev}' docker.io 2>/dev/null | grep -Fq 'ii '; then
  echo 'INFO: Docker公式apt repositoryからEngineを導入します'
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat <<EOF | tee /etc/apt/sources.list.d/docker.sources >/dev/null
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  env DEBIAN_FRONTEND=noninteractive apt-get install --no-remove -y \
    docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

systemctl enable --now cron
systemctl enable --now docker

if [ "$setup_variant" = linux ]; then
  sudoers_path="/etc/sudoers.d/90-dotagents-${target_user}-nopasswd"
  sudoers_tmp="$(mktemp)"
  trap 'rm -f "${sudoers_tmp:-}" "${sshd_tmp:-}"' EXIT
  printf '%s ALL=(ALL:ALL) NOPASSWD: ALL\n' "$target_user" >"$sudoers_tmp"
  chmod 0440 "$sudoers_tmp"
  visudo -cf "$sudoers_tmp" >/dev/null
  install -o root -g root -m 0440 "$sudoers_tmp" "$sudoers_path"

  sshd_config_path='/etc/ssh/sshd_config.d/50-dotagents-rabbit.conf'
  sshd_tmp="$(mktemp)"
  {
    printf '%s\n' 'PubkeyAuthentication yes'
    printf '%s\n' 'PasswordAuthentication no'
    printf '%s\n' 'KbdInteractiveAuthentication no'
    printf '%s\n' 'PermitRootLogin no'
  } >"$sshd_tmp"
  install -o root -g root -m 0644 "$sshd_tmp" "$sshd_config_path"
  sshd -t
  systemctl enable --now ssh
  systemctl reload ssh
fi

if ! id -nG "$target_user" | tr ' ' '\n' | grep -Fqx docker; then
  echo "INFO: $target_user をdocker groupへ追加します"
  usermod -aG docker "$target_user"
fi
docker info >/dev/null
if [ "$setup_variant" = linux ]; then
  systemctl is-active --quiet ssh
  sudo -u "$target_user" sudo -n true
fi
echo 'setup-linux-prerequisites-root: OK'
