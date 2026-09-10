#!/usr/bin/env bash
# native Linuxの共通一撃展開本体。公開入口はserver/workstation別wrapperが所有する。
set -euo pipefail

script_source="${BASH_SOURCE[0]}"
while [ -L "$script_source" ]; do
  script_dir="$(cd "$(dirname "$script_source")" && pwd)"
  script_source="$(readlink "$script_source")"
  case "$script_source" in /*) ;; *) script_source="$script_dir/$script_source" ;; esac
done
ROOT="$(cd "$(dirname "$script_source")/.." && pwd)"
SETUP_VARIANT="${DOTAGENTS_SETUP_VARIANT:-}"
case "$SETUP_VARIANT" in
  server)
    HOST_PROFILE=server
    SETUP_COMMAND=setup-linux-factory
    CRON_MARKER='# dotagents-agents-update-linux'
    ACTIONS_RUNNER_ROOT="$HOME/actions-runner-kitepon"
    ACTIONS_RUNNER_NAME='factory-linux-main'
    ACTIONS_RUNNER_LABEL='linux-server'
    ;;
  linux)
    HOST_PROFILE=linux
    SETUP_COMMAND=setup-linux-workstation-factory
    CRON_MARKER='# dotagents-agents-update-linux-workstation'
    ACTIONS_RUNNER_ROOT="$HOME/.local/share/actions-runner-kitepon"
    ACTIONS_RUNNER_NAME='factory-linux-rabbit'
    ACTIONS_RUNNER_LABEL='linux-workstation'
    ;;
  wsl) echo 'FAIL: WSL2 hostは退役済みです。現役入口として配備できません' >&2; exit 1 ;;
  *) echo "FAIL: 未対応のsetup variant: $SETUP_VARIANT" >&2; exit 1 ;;
esac
REPORT_CONFIG="${FACTORY_REPORTER_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/dotagents/factory-reporter.json}"
FACTORY_CREDENTIAL_FILE="${FACTORY_CREDENTIAL_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/dotagents/credentials/factory.token}"
MAIN_SERVER_SSH_TARGET="${MAIN_SERVER_SSH_TARGET:-kite@192.168.1.2}"
RABBIT_SSH_HOST="${RABBIT_SSH_HOST:-192.168.1.55}"
REPORT_STATE="${XDG_STATE_HOME:-$HOME/.local/state}/dotagents/factory-reporter-v8"
UPDATE_LOG="${XDG_STATE_HOME:-$HOME/.local/state}/agents-update/agents-update.log"

die() { echo "FAIL: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "必須commandがない: $1"; }

org_runner_record() {
  local runner_name="$1" response
  response="$(gh api orgs/kitepon/actions/runners)" || return 1
  node -e '
    const matches=JSON.parse(process.argv[2]).runners.filter((runner) => runner.name === process.argv[1]);
    if (matches.length !== 1) process.exit(1);
    process.stdout.write(JSON.stringify(matches[0]));
  ' "$runner_name" "$response"
}

set_org_runner_labels() {
  local runner_name="$1" runner_label="$2" runner_id labels_json runner_json
  runner_json="$(org_runner_record "$runner_name")" \
    || die "GitHub Actions runnerを一意に取得できない: $runner_name"
  if node -e '
    const labels=new Set(JSON.parse(process.argv[1]).labels.map((label) => label.name));
    process.exit(labels.has("factory") && labels.has(process.argv[2]) ? 0 : 1);
  ' "$runner_json" "$runner_label"; then
    return 0
  fi
  runner_id="$(node -e 'process.stdout.write(String(JSON.parse(process.argv[1]).id))' "$runner_json")"
  labels_json="$(node -e 'process.stdout.write(JSON.stringify({labels:["factory",process.argv[1]]}))' "$runner_label")"
  gh api --method PUT "orgs/kitepon/actions/runners/$runner_id/labels" --input - \
    <<<"$labels_json" >/dev/null \
    || die "GitHub Actions runner labelを更新できない: $runner_name"
}

verify_org_runner_online() {
  local runner_name="$1" runner_label="$2" runner_json
  for _ in {1..15}; do
    runner_json="$(org_runner_record "$runner_name")" \
      || die "GitHub Actions runnerの状態を取得できない: $runner_name"
    if node -e '
      const value=JSON.parse(process.argv[1]);
      const labels=new Set(value.labels.map((label) => label.name));
      process.exit(value.status === "online" && labels.has("factory") && labels.has(process.argv[2]) ? 0 : 1);
    ' "$runner_json" "$runner_label" 2>/dev/null; then
      echo "INFO: GitHub Actions runner online: $runner_name ($runner_label)"
      return 0
    fi
    sleep 2
  done
  die "GitHub Actions runnerのonline/label readbackに失敗: $runner_name"
}

ensure_github_actions_runner() {
  [ "${DOTAGENTS_SETUP_SKIP_ACTIONS_RUNNER:-0}" != 1 ] || return 0
  local runner_name='' service_file="$ACTIONS_RUNNER_ROOT/.service"
  local runtime_arch asset_name asset_url asset_digest expected_sha metadata
  local download_dir staged_dir registration_token

  if [ -f "$ACTIONS_RUNNER_ROOT/.runner" ]; then
    runner_name="$(node -e '
      const source = require("fs").readFileSync(process.argv[1], "utf8").replace(/^\uFEFF/, "");
      const value = JSON.parse(source);
      if (typeof value.agentName === "string") process.stdout.write(value.agentName);
    ' "$ACTIONS_RUNNER_ROOT/.runner" 2>/dev/null || true)"
    [ "$runner_name" = "$ACTIONS_RUNNER_NAME" ] \
      || die "既存GitHub Actions runner名がcanonicalでない: $runner_name"
  else
    case "$(uname -m)" in
      x86_64|amd64) runtime_arch=x64 ;;
      aarch64|arm64) runtime_arch=arm64 ;;
      *) die "GitHub Actions runner未対応arch: $(uname -m)" ;;
    esac
    metadata="$(gh api repos/actions/runner/releases/latest --jq \
      '[.assets[] | select(.name | test("^actions-runner-linux-'"$runtime_arch"'-[0-9.]+\\.tar\\.gz$")) | [.name,.browser_download_url,.digest]] | if length == 1 then .[0] | @tsv else error("runner asset is not unique") end')" \
      || die 'GitHub Actions runner公式release metadataを取得できない'
    IFS=$'\t' read -r asset_name asset_url asset_digest <<<"$metadata"
    expected_sha="${asset_digest#sha256:}"
    [[ "$expected_sha" =~ ^[a-f0-9]{64}$ ]] || die 'GitHub Actions runner asset digestが不正'
    registration_token="$(gh api --method POST orgs/kitepon/actions/runners/registration-token --jq .token 2>/dev/null)" \
      || die 'GitHub Actions runner登録tokenを発行できない。gh auth refresh -h github.com -s admin:org を完了して一撃展開を再実行する'
    [ -n "$registration_token" ] || die 'GitHub Actions runner登録tokenが空'

    download_dir="$(mktemp -d)"
    staged_dir="$HOME/.local/share/.actions-runner-kitepon-$$"
    trap '[ -z "${download_dir:-}" ] || rm -rf -- "$download_dir"; [ -z "${staged_dir:-}" ] || rm -rf -- "$staged_dir"' RETURN
    curl -fsSL "$asset_url" -o "$download_dir/$asset_name"
    printf '%s  %s\n' "$expected_sha" "$download_dir/$asset_name" | sha256sum -c -
    install -d -m 700 "$staged_dir"
    tar -xzf "$download_dir/$asset_name" -C "$staged_dir"
    sudo "$staged_dir/bin/installdependencies.sh"
    if [ -e "$ACTIONS_RUNNER_ROOT" ]; then
      die "未登録のGitHub Actions runner directoryを自動上書きしない: $ACTIONS_RUNNER_ROOT"
    fi
    mv "$staged_dir" "$ACTIONS_RUNNER_ROOT"
    staged_dir=''
    (
      cd "$ACTIONS_RUNNER_ROOT"
      ./config.sh --unattended --url https://github.com/kitepon \
        --token "$registration_token" --name "$ACTIONS_RUNNER_NAME" \
        --labels "factory,$ACTIONS_RUNNER_LABEL" --work _work --replace
    )
    registration_token=''
    rm -rf "$download_dir"
    download_dir=''
    trap - RETURN
  fi

  (
    cd "$ACTIONS_RUNNER_ROOT"
    if [ ! -f "$service_file" ]; then
      sudo ./svc.sh install "$USER"
    fi
    sudo ./svc.sh start
    sudo ./svc.sh status >/dev/null
  )

  set_org_runner_labels "$ACTIONS_RUNNER_NAME" "$ACTIONS_RUNNER_LABEL"
  verify_org_runner_online "$ACTIONS_RUNNER_NAME" "$ACTIONS_RUNNER_LABEL"
  if [ "$HOST_PROFILE" = linux ]; then
    # WSL2廃止時の旧linux-native labelを、rabbit初回展開からmain-server側も移行する。
    set_org_runner_labels factory-linux-main linux-server
    verify_org_runner_online factory-linux-main linux-server
  fi
}

linux_root_prerequisites_ready() {
  local package_name
  for package_name in ca-certificates cron curl gh git jq make openssh-client \
    openssh-server python3 python3-venv ripgrep shellcheck tmux xz-utils; do
    dpkg-query -W -f='${db:Status-Abbrev}' "$package_name" 2>/dev/null | grep -Fq 'ii ' \
      || return 1
  done
  { dpkg-query -W -f='${db:Status-Abbrev}' docker-ce 2>/dev/null | grep -Fq 'ii ' \
    || dpkg-query -W -f='${db:Status-Abbrev}' docker.io 2>/dev/null | grep -Fq 'ii '; } \
    || return 1
  systemctl is-enabled cron >/dev/null 2>&1 \
    && systemctl is-active cron >/dev/null 2>&1 \
    && systemctl is-enabled docker >/dev/null 2>&1 \
    && systemctl is-active docker >/dev/null 2>&1 \
    && id -nG "$USER" | tr ' ' '\n' | grep -Fqx docker \
    || return 1
  if [ "$HOST_PROFILE" = linux ]; then
    systemctl is-enabled ssh >/dev/null 2>&1 \
      && systemctl is-active ssh >/dev/null 2>&1 \
      && sudo -n true >/dev/null 2>&1 \
      || return 1
    [ "$(sudo -n stat -c '%a %U:%G' "/etc/sudoers.d/90-dotagents-${USER}-nopasswd" 2>/dev/null || true)" = '440 root:root' ] \
      && [ "$(sudo -n cat "/etc/sudoers.d/90-dotagents-${USER}-nopasswd" 2>/dev/null || true)" = "$USER ALL=(ALL:ALL) NOPASSWD: ALL" ] \
      && [ "$(stat -c '%a %U:%G' /etc/ssh/sshd_config.d/50-dotagents-rabbit.conf 2>/dev/null || true)" = '644 root:root' ] \
      && sudo -n sshd -T 2>/dev/null | grep -Fqx 'pubkeyauthentication yes' \
      && sudo -n sshd -T 2>/dev/null | grep -Fqx 'passwordauthentication no' \
      && sudo -n sshd -T 2>/dev/null | grep -Fqx 'kbdinteractiveauthentication no' \
      && sudo -n sshd -T 2>/dev/null | grep -Fqx 'permitrootlogin no' \
      || return 1
  fi
}

ensure_node24() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1090,SC1091 # nvmは端末の公式installerが配置する。
    . "$NVM_DIR/nvm.sh"
  fi
  local node_major installer
  node_major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\\1/' || true)"
  [ -z "$node_major" ] || [ "$node_major" -lt 24 ] || return 0
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    installer="$(mktemp)"
    mkdir -p "$NVM_DIR"
    echo 'INFO: nvm公式installerでNode管理を準備します'
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.7/install.sh -o "$installer" \
      || { rm -f "$installer"; die 'nvm公式installerを取得できない'; }
    bash "$installer" || { rm -f "$installer"; die 'nvm公式installerが失敗した'; }
    rm -f "$installer"
    # shellcheck disable=SC1090,SC1091 # nvmは端末の公式installerが配置する。
    . "$NVM_DIR/nvm.sh"
  fi
  nvm install 24
  nvm alias default 24
  nvm use 24
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\\1/')"
  [ "$node_major" -ge 24 ] || die 'nvmのNode.js 24導入結果を確認できない'
}

ensure_linux_prerequisites() {
  [ "${DOTAGENTS_SETUP_SKIP_PREREQUISITES:-0}" != 1 ] || return 0
  local root_helper="$ROOT/bin/setup-linux-prerequisites-root.sh"
  [ -x "$root_helper" ] || die "root prerequisite helperが実行可能でない: $root_helper"
  if ! linux_root_prerequisites_ready; then
    if sudo -n true >/dev/null 2>&1; then
      sudo -n "$root_helper" "$USER" "$HOST_PROFILE"
    elif [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v pkexec >/dev/null 2>&1; then
      echo 'INFO: Ubuntu前提packageの導入にDesktop認証ダイアログを使用します'
      pkexec "$root_helper" "$USER" "$HOST_PROFILE"
    else
      [ -t 0 ] && [ -t 1 ] || die '初回導入は対話terminalまたはDesktop Polkit認証が必要'
      echo 'INFO: Ubuntu前提packageを一撃入口から導入するためsudo認証を行います'
      sudo "$root_helper" "$USER" "$HOST_PROFILE"
    fi
  fi

  export PATH="$HOME/.local/bin:$PATH"
  ensure_node24
  if ! command -v uv >/dev/null 2>&1; then
    echo 'INFO: Astral公式installerからuvを導入します'
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi

}

ensure_github_auth() {
  if ! gh auth status --hostname github.com >/dev/null 2>&1; then
    echo 'INFO: GitHub認証を一撃入口内で開始します。表示されるdevice flowを完了してください'
    printf 'y\n' | gh auth login --hostname github.com --git-protocol https --web
  fi
  gh auth status --hostname github.com >/dev/null 2>&1 || die 'GitHub CLI認証を確認できない'
  gh auth setup-git
}

ensure_main_server_ssh() {
  [ "$HOST_PROFILE" = linux ] || return 0
  local ssh_dir="$HOME/.ssh" key="$HOME/.ssh/id_ed25519" public_key
  install -d -m 700 "$ssh_dir"
  if [ ! -s "$key" ] || [ ! -s "$key.pub" ]; then
    echo 'INFO: rabbit用のEd25519 SSH keyを一撃入口内で生成します'
    ssh-keygen -q -t ed25519 -N '' -C "${USER}@rabbit" -f "$key"
  fi
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$MAIN_SERVER_SSH_TARGET" true 2>/dev/null; then
    return 0
  fi
  [ -t 0 ] && [ -t 1 ] || die 'main-serverへrabbitの公開鍵を登録する対話作業が必要'
  public_key="$(<"$key.pub")"
  printf '%s\n' 'INFO: main-serverの /home/kite/.ssh/authorized_keys へ次の公開鍵を1行追加してください:'
  printf '%s\n' "$public_key"
  read -r -p '追加後にEnterを押してください: ' _
  ssh -o BatchMode=yes -o ConnectTimeout=5 "$MAIN_SERVER_SSH_TARGET" true 2>/dev/null \
    || die 'main-serverへの公開鍵認証を確認できない'
}

ensure_main_server_reverse_ssh() {
  [ "$HOST_PROFILE" = linux ] || return 0
  [ "${DOTAGENTS_SETUP_SKIP_REVERSE_SSH:-0}" != 1 ] || return 0
  [[ "$RABBIT_SSH_HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] \
    || die "rabbit SSH hostがIPv4形式でない: $RABBIT_SSH_HOST"
  ensure_main_server_ssh

  local ssh_dir="$HOME/.ssh" authorized_keys authorized_tmp
  local public_key key_type key_blob
  local host_key_type host_key_blob
  public_key="$(ssh "$MAIN_SERVER_SSH_TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
ssh_dir="$HOME/.ssh"
key="$ssh_dir/id_ed25519_rabbit"
install -d -m 700 "$ssh_dir"
if [ -e "$key" ] || [ -e "$key.pub" ]; then
  [ -s "$key" ] && [ -s "$key.pub" ] \
    || { echo 'rabbit専用SSH keyが不完全です' >&2; exit 1; }
else
  ssh-keygen -q -t ed25519 -N '' -C 'main-server-to-rabbit' -f "$key"
fi
chmod 600 "$key"
chmod 644 "$key.pub"
derived="$(ssh-keygen -y -f "$key" | awk '{print $1 " " $2}')"
recorded="$(awk '{print $1 " " $2}' "$key.pub")"
[ "$derived" = "$recorded" ] || { echo 'rabbit専用SSH key pairが不一致です' >&2; exit 1; }
cat "$key.pub"
REMOTE
)" || die 'main-serverでrabbit専用SSH keyを準備できない'
  read -r key_type key_blob _ <<<"$public_key"
  [ "$key_type" = ssh-ed25519 ] && [[ "$key_blob" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] \
    || die 'main-serverのrabbit専用公開鍵が不正'

  install -d -m 700 "$ssh_dir"
  authorized_keys="$ssh_dir/authorized_keys"
  authorized_tmp="$(mktemp "$ssh_dir/authorized_keys.dotagents.XXXXXX")"
  if [ -f "$authorized_keys" ]; then
    awk -v blob="$key_blob" '
      { for (field = 1; field <= NF; field += 1) if ($field == blob) next }
      { print }
    ' "$authorized_keys" >"$authorized_tmp"
  fi
  printf '%s %s %s %s\n' \
    'no-agent-forwarding,no-port-forwarding,no-X11-forwarding,no-user-rc' \
    "$key_type" "$key_blob" 'main-server-to-rabbit' >>"$authorized_tmp"
  chmod 600 "$authorized_tmp"
  mv -f "$authorized_tmp" "$authorized_keys"

  read -r host_key_type host_key_blob _ </etc/ssh/ssh_host_ed25519_key.pub
  [ "$host_key_type" = ssh-ed25519 ] && [[ "$host_key_blob" =~ ^[A-Za-z0-9+/]+={0,2}$ ]] \
    || die 'rabbitのSSH host公開鍵が不正'
  # 値は直前の厳格なIPv4／base64検証を通した単語だけをremote引数へ渡す。
  # shellcheck disable=SC2029
  ssh "$MAIN_SERVER_SSH_TARGET" \
    "bash -s -- '$RABBIT_SSH_HOST' '$host_key_blob'" <<'REMOTE'
set -euo pipefail
rabbit_host="$1"
host_key_blob="$2"
ssh_dir="$HOME/.ssh"
config="$ssh_dir/config"
known_hosts="$ssh_dir/known_hosts"
install -d -m 700 "$ssh_dir"
touch "$config" "$known_hosts"
chmod 600 "$config" "$known_hosts"
config_tmp="$(mktemp "$ssh_dir/config.dotagents.XXXXXX")"
known_hosts_tmp="$(mktemp "$ssh_dir/known_hosts.dotagents.XXXXXX")"
trap 'rm -f "${config_tmp:-}" "${known_hosts_tmp:-}"' EXIT
awk '
  $0 == "# dotagents-rabbit begin" { managed=1; next }
  $0 == "# dotagents-rabbit end" { managed=0; next }
  !managed { print }
  END { if (managed) exit 2 }
' "$config" >"$config_tmp"
{
  printf '\n%s\n' '# dotagents-rabbit begin'
  printf 'Host rabbit %s\n' "$rabbit_host"
  printf '  HostName %s\n' "$rabbit_host"
  printf '%s\n' '  User kite'
  printf '%s\n' '  IdentityFile ~/.ssh/id_ed25519_rabbit'
  printf '%s\n' '  IdentitiesOnly yes'
  printf '%s\n' '# dotagents-rabbit end'
} >>"$config_tmp"
chmod 600 "$config_tmp"
mv -f "$config_tmp" "$config"
cp "$known_hosts" "$known_hosts_tmp"
for host in rabbit "$rabbit_host"; do
  ssh-keygen -q -f "$known_hosts_tmp" -R "$host" >/dev/null 2>&1 || true
done
printf 'rabbit,%s ssh-ed25519 %s\n' "$rabbit_host" "$host_key_blob" >>"$known_hosts_tmp"
chmod 600 "$known_hosts_tmp"
mv -f "$known_hosts_tmp" "$known_hosts"
ssh -G rabbit >/dev/null
REMOTE

  ssh "$MAIN_SERVER_SSH_TARGET" 'bash -s' <<'REMOTE'
set -euo pipefail
[ "$(ssh -o BatchMode=yes -o ConnectTimeout=5 rabbit hostname)" = rabbit ]
ssh -o BatchMode=yes -o ConnectTimeout=5 rabbit 'sudo -n true'
REMOTE
  echo "INFO: main-server -> rabbit SSH / passwordless sudo: OK ($RABBIT_SSH_HOST)"
}

reporter_config_ready() {
  [ -s "$REPORT_CONFIG" ] && [ -s "$FACTORY_CREDENTIAL_FILE" ] || return 1
  node - "$REPORT_CONFIG" "$HOST_PROFILE" "$FACTORY_CREDENTIAL_FILE" <<'NODE'
const fs = require('fs');
const [path, profile, credential] = process.argv.slice(2);
try {
  const value = JSON.parse(fs.readFileSync(path, 'utf8'));
  const endpoint = new URL(value?.reporting?.endpoint);
  process.exit(value?.schema_version === '1.0'
    && value?.host?.id === 'rabbit' && value?.host?.profile === profile
    && value?.collection?.enabled === true && value?.reporting?.enabled === true
    && endpoint.origin === 'http://192.168.1.2:39310'
    && endpoint.pathname === '/api/factory/v8/reports'
    && value?.reporting?.credential_file === credential ? 0 : 1);
} catch { process.exit(1); }
NODE
}

ensure_factory_reporter_enrollment() {
  [ "${DOTAGENTS_SETUP_SKIP_ENROLLMENT:-0}" != 1 ] || return 0
  [ "$HOST_PROFILE" = linux ] || return 0
  reporter_config_ready && return 0
  ensure_main_server_ssh
  local config_dir credential_dir staging_tmp config_tmp
  config_dir="$(dirname "$REPORT_CONFIG")"
  credential_dir="$(dirname "$FACTORY_CREDENTIAL_FILE")"
  install -d -m 700 "$config_dir" "$credential_dir"
  echo 'INFO: main-serverのBugHub管理CLIでrabbit/linux credentialを発行します'
  ssh "$MAIN_SERVER_SSH_TARGET" \
    'set -e; install -d -m 700 /home/kite/bughub/data/credentials; if test ! -s /home/kite/bughub/data/credentials/rabbit.token; then cd /home/kite/bughub && docker compose exec -T bughub node src/factory-admin.js provision --host-id rabbit --profile linux --token-output /app/data/credentials/rabbit.token; fi'
  staging_tmp="$(mktemp "$credential_dir/factory.token.XXXXXX")"
  if ! ssh "$MAIN_SERVER_SSH_TARGET" 'cat /home/kite/bughub/data/credentials/rabbit.token' >"$staging_tmp"; then
    rm -f "$staging_tmp"
    die 'rabbit credentialをmain-serverから転送できない'
  fi
  [ -s "$staging_tmp" ] || { rm -f "$staging_tmp"; die 'rabbit credentialが空'; }
  chmod 600 "$staging_tmp"
  mv -f "$staging_tmp" "$FACTORY_CREDENTIAL_FILE"
  ssh "$MAIN_SERVER_SSH_TARGET" 'rm -f /home/kite/bughub/data/credentials/rabbit.token'

  config_tmp="$(mktemp "$config_dir/factory-reporter.json.XXXXXX")"
  node - "$ROOT/examples/factory-reporter/rabbit.json" "$config_tmp" "$FACTORY_CREDENTIAL_FILE" <<'NODE'
const fs = require('fs');
const [source, output, credential] = process.argv.slice(2);
const value = JSON.parse(fs.readFileSync(source, 'utf8'));
value.collection.enabled = true;
value.reporting = {
  enabled: true,
  endpoint: 'http://192.168.1.2:39310/api/factory/v8/reports',
  credential_file: credential,
};
fs.writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
NODE
  chmod 600 "$config_tmp"
  mv -f "$config_tmp" "$REPORT_CONFIG"
  reporter_config_ready || die 'rabbit reporter configのreadbackに失敗'
}

is_target_host() {
  [ "${DOTAGENTS_SETUP_LINUX_FORCE:-0}" = 1 ] && return 0
  [ "$(uname -s 2>/dev/null || true)" = Linux ] || return 1
  if grep -qiE '(microsoft|wsl)' /proc/sys/kernel/osrelease 2>/dev/null; then
    return 1
  fi
  return 0
}

validate_report_config() {
  [ -f "$REPORT_CONFIG" ] || die "factory reporter configがない: $REPORT_CONFIG"
  node - "$REPORT_CONFIG" "$HOST_PROFILE" <<'NODE' || exit 1
const fs = require('fs');
const path = process.argv[2];
let value;
try { value = JSON.parse(fs.readFileSync(path, 'utf8')); }
catch (error) { process.stderr.write(`FAIL: factory reporter configを読めない: ${error.message}\n`); process.exit(1); }
let endpoint;
try { endpoint = new URL(value?.reporting?.endpoint); }
catch { process.stderr.write('FAIL: factory reporter endpointが不正\n'); process.exit(1); }
if (value?.host?.profile !== process.argv[3]
  || value?.reporting?.enabled !== true || endpoint.pathname !== '/api/factory/v8/reports') {
  process.stderr.write(`FAIL: factory reporterは${process.argv[3]} profileのenabledなwire v8でなければならない\n`);
  process.exit(1);
}
NODE
}

fresh_report_id() {
  node -e '
    try {
      const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      if (typeof value.report_id === "string") process.stdout.write(value.report_id);
    } catch {}
  ' "$REPORT_STATE/latest-report.json" 2>/dev/null || true
}

new_batch_token() {
  if [ -r /proc/sys/kernel/random/uuid ]; then
    tr -d '\r\n' </proc/sys/kernel/random/uuid
  else
    python3 -c 'import uuid; print(uuid.uuid4())'
  fi
}

validate_delivery_receipt() {
  local prior_report_id="$1" batch_token="$2"
  node --input-type=module - \
    "$ROOT/lib/factory/delivery-receipt.mjs" \
    "$REPORT_STATE/latest-report.json" \
    "$REPORT_STATE/delivery-receipt.json" \
    "$prior_report_id" "$batch_token" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [contractPath, reportPath, receiptPath, priorReportId, batchToken] = process.argv.slice(2);
const { assertDeliveryReceipt } = await import(pathToFileURL(contractPath).href);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
assertDeliveryReceipt({ report, priorReportId: priorReportId || null, receipt, batchToken });
process.stdout.write(`${report.report_id}\n`);
NODE
}

validate_factory_products() {
  node --input-type=module - \
    "$ROOT/lib/factory/deployment-contract.mjs" \
    "$REPORT_STATE/latest-report.json" "$HOST_PROFILE" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [contractPath, reportPath, expectedProfile] = process.argv.slice(2);
const { CURRENT_WIRE_PRODUCT_IDS, hostProjection, postUpdateFailures } =
  await import(pathToFileURL(contractPath).href);
const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const facts = { profile: report.host_profile, os: report.platform?.os, arch: report.platform?.arch };
if (report.schema_version !== '8.0' || facts.profile !== expectedProfile || facts.os !== 'linux') {
  throw new Error(`${expectedProfile} wire v8 reportでない`);
}
const actualIds = Object.keys(report.products ?? {}).sort();
const expectedIds = [...CURRENT_WIRE_PRODUCT_IDS].sort();
if (actualIds.length !== expectedIds.length || actualIds.some((id, index) => id !== expectedIds[index])) {
  throw new Error('factory reportが固定15製品をすべて含まない');
}
const projection = hostProjection(facts);
let failures = postUpdateFailures(report, facts, { postUpdate: false });
if (expectedProfile === 'server') {
  // self-ingest鮮度はdelivery後のverify-installがloopback readinessで受け入れる。
  failures = failures.filter((failure) => failure !== 'servermanager:compatibility'
    && failure !== 'servermanager:readiness_factory_ingest');
}
for (const [id, expectation] of Object.entries(projection.expected)) {
  const product = report.products[id];
  if (expectation === 'unsupported'
    && (product.presence_status !== 'not_applicable' || product.compatibility_status !== 'unsupported')) {
    failures.push(`${id}:unsupported_projection`);
  }
  if (expectation === 'not_applicable' && product.presence_status !== 'not_applicable') {
    failures.push(`${id}:not_applicable_projection`);
  }
}
const grok = report.products['grok-build'];
if (!['installed', 'not_applicable'].includes(grok.presence_status)
  || grok.compatibility_status === 'incompatible'
  || grok.checks.some((item) => item.status === 'fail')) {
  failures.push('grok-build:optional_health');
}
if (failures.length) throw new Error(`factory product verification failed: ${failures.join(',')}`);
process.stdout.write(String(actualIds.length));
NODE
}

run_scheduled_update() {
  need node
  need python3
  validate_report_config
  local prior_report_id batch_token report_id checked_products
  prior_report_id="$(fresh_report_id)"
  batch_token="$(new_batch_token)"
  AGENTS_UPDATE_BATCH_TOKEN="$batch_token" \
    FACTORY_REPORTER_RUNNER="$HOME/.local/bin/factory-reporter-v8-schedule-runner" \
    env -u THROUGHLINE_CODEX_THREAD_ID -u CODEX_THREAD_ID "$ROOT/bin/agents-update.sh" "$@"
  [ -f "$UPDATE_LOG" ] || die "agents-update logがない: $UPDATE_LOG"
  grep -Fq "agents-update batch-token: $batch_token" "$UPDATE_LOG" \
    || die '今回のbatch tokenがagents-update logにない'
  grep -Fq 'agents-update end:' "$UPDATE_LOG" || die 'agents-update完了行がlogにない'
  report_id="$(validate_delivery_receipt "$prior_report_id" "$batch_token")" \
    || die 'fresh v8 reportとBugHub delivery receiptが一致しない'
  checked_products="$(validate_factory_products)" \
    || die 'factory全製品の正規診断が受入条件を満たさない'
  printf '{"ok":true,"mode":"scheduled-update","batch_token":"%s","report_id":"%s","delivery_acknowledged":true,"factory_products_checked":%s}\n' \
    "$batch_token" "$report_id" "$checked_products"
}

backup_managed_config() {
  local -a paths=()
  local path
  for path in .gitconfig .gitignore_global .claude.json .claude/settings.json \
    .codex/config.toml .codex/hooks.json .grok/config.toml; do
    [ ! -e "$HOME/$path" ] || paths+=("$path")
  done
  [ "${#paths[@]}" -gt 0 ] || return 0
  local backup_dir="$HOME/Archives"
  local backup_file
  mkdir -p "$backup_dir"
  backup_file="$(mktemp "$backup_dir/dotagents-pre-$SETUP_VARIANT-setup-$(date +%Y%m%d-%H%M%S)-XXXXXX.tar.gz")"
  tar -czf "$backup_file" -C "$HOME" "${paths[@]}"
}

ensure_git_identity() {
  git config --global user.name quolu
  git config --global user.email 226230081+quolu@users.noreply.github.com
  git config --global init.defaultBranch main
  if [ ! -f "$HOME/.gitignore_global" ] || ! grep -Fqx '.DS_Store' "$HOME/.gitignore_global"; then
    printf '.DS_Store\n' >>"$HOME/.gitignore_global"
  fi
  git config --global core.excludesfile "$HOME/.gitignore_global"
}

ensure_toolchain_bootstrap() {
  local npm_bin npm_prefix
  npm_prefix="$(npm prefix -g)" || die 'npm global prefixを取得できない'
  npm_bin="$npm_prefix/bin"
  mkdir -p "$npm_bin"
  export PATH="$npm_bin:$PATH"
  if ! npm list -g --depth=0 @anthropic-ai/claude-code >/dev/null 2>&1; then
    npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code@latest
  fi
  if ! npm list -g --depth=0 @openai/codex >/dev/null 2>&1; then
    npm install -g @openai/codex@latest
  fi
  install -d -m 700 "$HOME/.local/bin"
  for command_name in claude codex; do
    [ -x "$npm_bin/$command_name" ] || die "公式npm CLIのbinがない: $command_name"
    if [ "$npm_bin/$command_name" != "$HOME/.local/bin/$command_name" ]; then
      ln -sfn "$npm_bin/$command_name" "$HOME/.local/bin/$command_name"
    fi
  done
  claude --version >/dev/null 2>&1 || die 'Claude Codeを公式npm経路で復旧できない'
  codex --version >/dev/null 2>&1 || die 'Codex CLIを公式npm経路で復旧できない'
}

grok_is_logged_in() {
  [ -n "${XAI_API_KEY:-}" ] && return 0
  [ -s "$HOME/.grok/auth.json" ]
}

maybe_apply_grok_config() {
  if ! grok_is_logged_in; then
    echo "INFO: Grok未login。apply-grok-config をスキップする（toolchain optional）"
    return 0
  fi
  "$ROOT/bin/apply-grok-config.sh" --apply
}

apply_cursor_config() {
  "$ROOT/bin/apply-cursor-config.sh" --apply
}

cron_quote() {
  printf "'%s'" "${1//\'/\'\\\'\'}"
}

install_cron() {
  mkdir -p "$(dirname "$UPDATE_LOG")"
  if ! systemctl is-enabled cron >/dev/null 2>&1 \
    || ! systemctl is-active cron >/dev/null 2>&1; then
    sudo -n systemctl enable --now cron
  fi
  local cron_tmp current candidate installed backup_dir backup_file setup_bin scheduler_log line
  cron_tmp="$(mktemp -d)"
  current="$cron_tmp/current"
  candidate="$cron_tmp/candidate"
  installed="$cron_tmp/installed"
  trap 'rm -rf "${cron_tmp:-}"' RETURN
  crontab -l >"$current" 2>/dev/null || true
  backup_dir="${XDG_STATE_HOME:-$HOME/.local/state}/dotagents/backups"
  mkdir -p "$backup_dir"
  backup_file="$(mktemp "$backup_dir/crontab-pre-$SETUP_VARIANT-setup-$(date +%Y%m%d-%H%M%S)-XXXXXX")"
  cp "$current" "$backup_file"
  awk -v marker="$CRON_MARKER" '
    index($0, marker) { next }
    $0 ~ /(^|[[:space:]\047"])([^[:space:]\047"]*\/)?agents-update(\.sh)?([[:space:]\047"]|$)/ { next }
    $0 ~ /(^|[[:space:]\047"])([^[:space:]\047"]*\/)?update-npm-globals(\.sh)?([[:space:]\047"]|$)/ { next }
    { print }
  ' "$current" >"$candidate"
  setup_bin="$HOME/.local/bin/$SETUP_COMMAND"
  scheduler_log="${XDG_STATE_HOME:-$HOME/.local/state}/agents-update/scheduler.log"
  line="0 2 * * * $(cron_quote "$setup_bin") --scheduled-update >> $(cron_quote "$scheduler_log") 2>&1 $CRON_MARKER"
  printf '%s\n' "$line" >>"$candidate"
  crontab "$candidate"
  crontab -l >"$installed"
  [ "$(grep -Fxc "$line" "$installed")" -eq 1 ] \
    || die '毎日2:00のagents-update cronを読み戻せない'
}

run_setup() {
  is_target_host || die "このスクリプトは$SETUP_VARIANT専用"
  # 親AI sessionは ~/.local/bin を持たないことがある。uv tool（markitdown）と
  # install.sh の配布面はここへ置くので、入口自身が PATH を完結させる。
  export PATH="$HOME/.local/bin:$PATH"
  ensure_linux_prerequisites
  local node_major
  local command_name
  for command_name in git gh node npm docker python3 uv crontab sudo systemctl; do
    need "$command_name"
  done
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
  [ "$node_major" -ge 24 ] || die 'Node.js 24以上が必要（入口がnvm公式経路で導入する）'
  python3 -c 'print(1)' >/dev/null || die 'python3を実行できない'
  if ! docker info >/dev/null 2>&1; then
    if ! systemctl is-active docker >/dev/null 2>&1 \
      || ! id -nG "$USER" | tr ' ' '\n' | grep -Fqx docker; then
      die 'docker daemonまたはdocker groupの導入を確認できない'
    fi
    echo 'INFO: docker groupはこのlogin sessionへ未反映。root bootstrapでdaemon smoke済みです'
  fi
  ensure_github_auth
  # workstation runnerの組織登録権限は時間のかかる製品配線より先に検証する。
  ensure_github_actions_runner
  ensure_main_server_reverse_ssh

  backup_managed_config
  ensure_git_identity
  ensure_factory_reporter_enrollment
  ensure_toolchain_bootstrap
  "$ROOT/bin/apply-codex-config.sh" --apply
  "$ROOT/bin/apply-claude-config.sh" --apply
  maybe_apply_grok_config
  apply_cursor_config
  "$ROOT/install.sh" --profile official
  install_cron
  run_scheduled_update --setup
  if [ "$HOST_PROFILE" = server ]; then
    # server readinessはfactory ingest鮮度も含む。先に今回のreportを届けてから検証する。
    SERVERMANAGER_READY_URL="${SERVERMANAGER_READY_URL:-http://127.0.0.1:39310/readyz}" \
      DOTAGENTS_FACTORY_HOST_PROFILE=server \
      "$ROOT/bin/verify-install.sh" --profile official
  else
    DOTAGENTS_FACTORY_HOST_PROFILE="$HOST_PROFILE" \
      "$ROOT/bin/verify-install.sh" --profile official
  fi
  echo "$SETUP_COMMAND: OK"
}

case "${1:-}" in
  '') run_setup ;;
  --scheduled-update)
    [ "$#" -eq 1 ] || die "使い方: $SETUP_COMMAND.sh [--scheduled-update]"
    is_target_host || die "このスクリプトは$SETUP_VARIANT専用"
    run_scheduled_update
    ;;
  *) die "使い方: $SETUP_COMMAND.sh [--scheduled-update]" ;;
esac
