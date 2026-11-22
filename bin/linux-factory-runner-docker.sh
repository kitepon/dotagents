#!/usr/bin/env bash
# Rabbit host apply (run by the host owner as the existing operator with sudo): rootless Docker owned by factory-runner (for the
# installed Engine, docker-ce or Ubuntu's docker.io; the Engine itself is never replaced),
# host arm64 binfmt with the F flag, DOCKER_HOST in every pool root's .env. Contract: docs/feature-map/runner-capacity.md
# ("Rootless Docker"). It never adds factory-runner to a group and never edits the runner/scaler unit.
# Idempotent. Exit 3 = a Runner.Worker is running: nothing was changed (or the listeners were not recycled); rerun when idle.
#   bin/linux-factory-runner-docker.sh                     apply
#   bin/linux-factory-runner-docker.sh --rollback [--purge] remove the unit and every DOCKER_HOST line (--purge: image data too)
set -euo pipefail
set +x
# apt/dpkg/sysctl output is parsed below; a Japanese Rabbit printed "候補:" for "Candidate:" and the precheck refused (2026-11-22).
export LC_ALL=C
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
HELPER="$ROOT/bin/factory-runner-docker.mjs"
RUNNER_USER=factory-runner
RUNNER_HOME=/home/factory-runner
UNITS=/etc/systemd/system
ROOTLESSKIT_PROFILE=/etc/apparmor.d/usr.bin.rootlesskit
ARM64_CONF=/etc/binfmt.d/qemu-aarch64.conf
ARM64_PROC=/proc/sys/fs/binfmt_misc/qemu-aarch64
MARK='# dotagents factory-runner rootless Docker'

mode=apply
purge=0
case "${1:-}" in
  '') ;;
  --rollback) mode=rollback; [ "${2:-}" != --purge ] || purge=1; [ "$#" -le $((1 + purge)) ] || { echo 'usage: see header' >&2; exit 2; } ;;
  *) echo 'usage: see header' >&2; exit 2 ;;
esac

IFS=$'\t' read -r SERVICE SOCKET DOCKER_HOST_VALUE < <(node "$HELPER" config)
mapfile -t roots < <(node --input-type=module -e '
  const { POOL_INSTANCES } = await import(process.argv[1]);
  for (const item of POOL_INSTANCES) console.log(item.root);
' "$ROOT/lib/factory/runner-profile.mjs")
[ "${#roots[@]}" -gt 0 ] || { echo 'no pool roots in the contract' >&2; exit 2; }

runner() { sudo -n -u "$RUNNER_USER" -H "$@"; }
workers_running() { pgrep -u "$RUNNER_USER" -x Runner.Worker >/dev/null; }
dpkg_ok() { dpkg-query -W -f='${db:Status-Abbrev}' "$1" 2>/dev/null | grep -Fq 'ii '; }
arm64_flags() { sed -n 's/^flags: //p' "$ARM64_PROC" 2>/dev/null || true; }
# Listeners read .env only at start; the scaler restarts a stopped one on its next tick (minimum 1), so recycle idle ones.
recycle_listeners() {
  if workers_running; then
    echo 'a Runner.Worker is running: listeners keep the old environment until each restarts; rerun when idle (exit 3)'
    return 3
  fi
  # Signal first (procps and BSD agree); exit 1 = no listener matched, anything else is a real failure.
  local status=0
  sudo -n pkill -INT -u "$RUNNER_USER" -x Runner.Listener || status=$?
  [ "$status" -le 1 ] || { echo "pkill Runner.Listener failed ($status)" >&2; return 1; }
}

sudo -n true
[ "$(id -nG "$RUNNER_USER")" = "$RUNNER_USER" ] || { echo 'factory-runner has extra groups; refuse' >&2; exit 2; }
if runner sudo -n true 2>/dev/null; then echo 'factory-runner can sudo; refuse' >&2; exit 2; fi
if workers_running; then echo 'swap pending (a Runner.Worker is running); nothing changed; rerun when idle'; exit 3; fi

if [ "$mode" = rollback ]; then
  sudo -n systemctl disable --now "$SERVICE" 2>/dev/null || true
  sudo -n rm -f "$UNITS/$SERVICE"
  sudo -n rm -rf "$UNITS/$SERVICE.d"   # a host-made drop-in (e.g. 50-cgroupfs.conf) goes with the unit
  if grep -Fqx "$MARK" "$ARM64_CONF" 2>/dev/null; then sudo -n rm -f "$ARM64_CONF"; fi
  if grep -Fqx "$MARK" "$ROOTLESSKIT_PROFILE" 2>/dev/null; then sudo -n rm -f "$ROOTLESSKIT_PROFILE"; sudo -n systemctl reload apparmor.service || true; fi
  sudo -n systemctl daemon-reload
  sudo -n systemctl restart systemd-binfmt.service || true
  for root in "${roots[@]}"; do
    sudo -n -u "$RUNNER_USER" -H bash --noprofile --norc -c 'f=$1/.env; [ -f "$f" ] || exit 0; grep -v "^DOCKER_HOST=" "$f" >"$f.new" || true; mv "$f.new" "$f"' _ "$root"
  done
  [ "$purge" = 0 ] || sudo -n rm -rf "$RUNNER_HOME/.local/share/docker" "$RUNNER_HOME/.config/docker"
  status=0; recycle_listeners || status=$?
  echo "rollback done (packages, subuid/subgid and, without --purge, image data stay). Revert the dotagents PR too, or setup's rootless-Docker check fails."
  exit "$status"
fi

# 1. Engine and packages. The existing Engine is kept (docker-ce from Docker's apt repository, or Ubuntu's docker.io); the rootless
#    pieces come from the same origin: docker-ce-rootless-extras (pinned to the Engine's version), or for docker.io Ubuntu's own
#    rootlesskit + docker-buildx with the launcher shipped under /usr/share/docker.io/contrib. Everything missing is named and the
#    apply stops before any change.
if dpkg_ok docker-ce; then engine=docker-ce; elif dpkg_ok docker.io; then engine=docker.io
else echo 'neither docker-ce nor docker.io is installed; report: dpkg -l | grep -i docker' >&2; exit 2; fi
launcher=$(node "$HELPER" scripts | awk -F'\t' -v engine="$engine" '$1 == engine { print $2 }')
[ -n "$launcher" ] || { echo "no rootless launcher known for $engine" >&2; exit 2; }
need=()
for package in uidmap slirp4netns; do dpkg_ok "$package" || need+=("$package"); done
# qemu-user-static is a virtual package on Ubuntu 26.04 (provided by qemu-user-binfmt, which depends on the static qemu-user).
if ! dpkg_ok qemu-user-static && ! dpkg_ok qemu-user-binfmt; then
  if apt-cache show qemu-user-binfmt >/dev/null 2>&1; then need+=(qemu-user-binfmt); else need+=(qemu-user-static); fi
fi
if [ "$engine" = docker-ce ]; then
  engine_version=$(dpkg-query -W -f='${Version}' docker-ce)
  dpkg_ok docker-ce-rootless-extras || need+=("docker-ce-rootless-extras=$engine_version")
else
  dpkg_ok rootlesskit || need+=(rootlesskit)
  dpkg_ok docker-buildx || dpkg_ok docker-buildx-plugin || need+=(docker-buildx)
  [ -x "$launcher" ] || { echo "docker.io does not ship $launcher; stop (nothing changed)" >&2; exit 2; }
fi
has_candidate() { [ -n "$(LC_ALL=C apt-cache policy "${1%%=*}" 2>/dev/null | awk '/Candidate:/ && $2 != "(none)" { print $2 }')" ]; }
missing=()
# Arrays are only expanded when non-empty: bash 3.2 (the macOS CI that runs this script's test) aborts on an empty one under set -u.
if [ "${#need[@]}" -gt 0 ]; then
  for attempt in 1 2; do
    missing=()
    for package in "${need[@]}"; do has_candidate "$package" || missing+=("$package"); done
    if [ "${#missing[@]}" -eq 0 ]; then break; fi
    if [ "$attempt" = 1 ]; then sudo -n apt-get update; fi   # refreshes the package index only; the second look is final
  done
fi
[ "${#missing[@]}" -eq 0 ] || { echo "not installable from the configured apt sources (nothing changed): ${missing[*]}" >&2; exit 2; }
if [ "${#need[@]}" -gt 0 ]; then
  sudo -n env DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 apt-get install -y --no-remove "${need[@]}"
fi
[ -x "$launcher" ] || { echo "$launcher is missing after install" >&2; exit 2; }
command -v rootlesskit >/dev/null || { echo 'rootlesskit is not on PATH after install' >&2; exit 2; }

# 2. subuid/subgid: 65536 ids for factory-runner after every existing range.
add_subid() {
  local start status=0
  start=$(node "$HELPER" subid-start <"$1") || status=$?
  case $status in
    0) sudo -n usermod "$2" "$start-$((start + 65535))" "$RUNNER_USER" ;;
    3) ;;
    *) echo "cannot read $1" >&2; exit 2 ;;
  esac
}
add_subid /etc/subuid --add-subuids
add_subid /etc/subgid --add-subgids

# 3. Ubuntu 24.04+ denies user namespaces to unprivileged programs unless an AppArmor profile allows them (Docker rootless docs).
if [ "$(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] && ! grep -rqs '/usr/bin/rootlesskit' /etc/apparmor.d; then
  printf '%s\n' "$MARK" 'abi <abi/4.0>,' 'include <tunables/global>' '' '/usr/bin/rootlesskit flags=(unconfined) {' '  userns,' '' '  include if exists <local/usr.bin.rootlesskit>' '}' \
    | sudo -n tee "$ROOTLESSKIT_PROFILE" >/dev/null
  sudo -n apparmor_parser -r "$ROOTLESSKIT_PROFILE"
fi

# 4. arm64 emulation on the host with the F (fix-binary) flag: the interpreter is opened at registration, so containers in
#    the rootless user namespace need no qemu copy and no --privileged setup-qemu-action. Keep the packaged flags, add F.
case "$(arm64_flags)" in
  *F*) ;;
  *)
    [ -f /usr/lib/binfmt.d/qemu-aarch64.conf ] || { echo 'qemu-aarch64 is not registered and /usr/lib/binfmt.d/qemu-aarch64.conf is missing' >&2; exit 2; }
    sudo -n install -d -m 755 /etc/binfmt.d
    { printf '%s\n' "$MARK"; sed -E '/:[A-Z]*F[A-Z]*$/! s/:([A-Z]*)$/:\1F/' /usr/lib/binfmt.d/qemu-aarch64.conf; } | sudo -n tee "$ARM64_CONF" >/dev/null
    sudo -n systemctl restart systemd-binfmt.service
    ;;
esac
case "$(arm64_flags)" in *F*) ;; *) echo "qemu-aarch64 is not registered with the F flag: $(cat "$ARM64_PROC" 2>&1 | head -n 3)" >&2; exit 1 ;; esac

# 5. The daemon unit (no NoNewPrivileges: newuidmap is setuid) and its socket.
node "$HELPER" unit "$launcher" | sudo -n tee "$UNITS/$SERVICE" >/dev/null
# The generated unit carries the cgroupfs option itself; the 2026-11-22 host drop-in that added it is redundant, so it goes
# (any other drop-in file stays, and keeps the directory).
sudo -n rm -f "$UNITS/$SERVICE.d/50-cgroupfs.conf"
if [ -d "$UNITS/$SERVICE.d" ]; then sudo -n rmdir --ignore-fail-on-non-empty "$UNITS/$SERVICE.d"; fi
sudo -n chmod 644 "$UNITS/$SERVICE"
sudo -n systemctl daemon-reload
sudo -n systemctl enable "$SERVICE"
sudo -n systemctl restart "$SERVICE"
for _ in $(seq 60); do runner test -S "$SOCKET" && break; sleep 1; done
runner test -S "$SOCKET" || { echo "no socket at $SOCKET after 60 s"; sudo -n journalctl -u "$SERVICE" -n 30 --no-pager; exit 1; } >&2

# 6. DOCKER_HOST in every pool root, then recycle idle listeners so the next job inherits it.
for root in "${roots[@]}"; do
  runner test -f "$root/.runner" || { echo "pool root is not registered: $root" >&2; exit 2; }
  { runner cat "$root/.env" 2>/dev/null || true; } | node "$HELPER" set-env \
    | sudo -n -u "$RUNNER_USER" -H bash --noprofile --norc -c 'cat >"$1.new" && mv "$1.new" "$1"' _ "$root/.env"
done
status=0; recycle_listeners || status=$?

# 7. Readback (the job-side readback is in docs/feature-map/runner-capacity.md).
systemctl is-active "$SERVICE"
runner stat -c '%U %F %n' "$SOCKET"
info=$(runner env DOCKER_HOST="$DOCKER_HOST_VALUE" docker info --format '{{json .SecurityOptions}} cgroup={{.CgroupDriver}} root={{.DockerRootDir}}')
echo "$info"
case "$info" in *name=rootless*) ;; *) echo 'docker info does not report rootless' >&2; exit 1 ;; esac
head -n 3 "$ARM64_PROC"
echo "groups: $(id -nG "$RUNNER_USER")"
for root in "${roots[@]}"; do runner grep -H '^DOCKER_HOST=' "$root/.env"; done
exit "$status"
