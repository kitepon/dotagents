#!/usr/bin/env bash
# Rabbit host apply (run by the host owner as the existing operator with sudo and gh admin:org).
# Adds the pinned parallel runner instances and CPU sets from FACTORY_RUNNERS. Contract: docs/feature-map/runner-capacity.md.
# Idempotent; exit 3 = an existing instance was busy, so its restart is pending and a rerun completes it.
set -euo pipefail
set +x
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUNNER_USER=factory-runner
RUNNER_HOME=/home/factory-runner
PROFILE=/etc/dotagents/factory-runner-profile.json
UNITS=/etc/systemd/system

sudo -n true
[ "$(id -nG "$RUNNER_USER")" = "$RUNNER_USER" ] || { echo 'factory-runner has extra groups; refuse' >&2; exit 2; }
if sudo -n -u "$RUNNER_USER" -H sudo -n true 2>/dev/null; then echo 'factory-runner can sudo; refuse' >&2; exit 2; fi

mapfile -t instances < <(node --input-type=module -e '
  const { FACTORY_RUNNERS } = await import(process.argv[1]);
  for (const item of FACTORY_RUNNERS.find((runner) => runner.label === "linux-workstation").instances) console.log([item.name, item.root, item.cpus].join("\t"));
' "$ROOT/lib/factory/deployment-contract.mjs")
IFS=$'\t' read -r first_name first_root _ <<<"${instances[0]}"
first_unit="$UNITS/actions.runner.kitepon.$first_name.service"
systemctl is-active --quiet "actions.runner.kitepon.$first_name.service"

busy() {  # true when a Runner.Worker runs in the service's cgroup
  local group pid
  group=$(systemctl show -p ControlGroup --value "$1")
  [ -n "$group" ] && [ -r "/sys/fs/cgroup$group/cgroup.procs" ] || return 1
  while read -r pid; do
    [ "$(cat "/proc/$pid/comm" 2>/dev/null)" = Runner.Worker ] && return 0
  done <"/sys/fs/cgroup$group/cgroup.procs"
  return 1
}
affinity() { taskset -pc "$(systemctl show -p MainPID --value "$1")" | sed 's/.*: //'; }

pending=0
for line in "${instances[@]}"; do
  IFS=$'\t' read -r name root cpus <<<"$line"
  service="actions.runner.kitepon.$name.service"
  if [ "$root" != "$first_root" ]; then
    if ! sudo -n -u "$RUNNER_USER" test -f "$root/.runner"; then
      # Runner layout without identity, credentials, logs or work; symlinked bin/externals are copied as content.
      sudo -n -u "$RUNNER_USER" install -d -m 700 "$root"
      sudo -n -u "$RUNNER_USER" bash --noprofile --norc -c 'cd "$1" && cp -R -L -p bin externals config.sh env.sh run.sh run-helper.sh.template run-helper.cmd.template runsvc.sh safe_sleep.sh .env .path "$2"/' _ "$first_root" "$root"
      registration_token=$(gh api --method POST orgs/kitepon/actions/runners/registration-token --jq .token)
      # The token travels over stdin only, as in the 2026-10-15 dedicated install.
      printf '%s\n' "$registration_token" | sudo -n -u "$RUNNER_USER" -H env -i HOME="$RUNNER_HOME" USER="$RUNNER_USER" LOGNAME="$RUNNER_USER" PATH="$RUNNER_HOME/.local/bin:/usr/bin:/bin" bash --noprofile --norc -c '
        set -euo pipefail; set +x
        IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN
        cd "$1" && ./config.sh --unattended --url https://github.com/kitepon --name "$2" --labels factory,linux-workstation --work _work
      ' _ "$root" "$name"
      unset registration_token
    fi
    # Same hardening as the first instance; only the root differs.
    unit=$(sed -e "s#^WorkingDirectory=$first_root\$#WorkingDirectory=$root#" -e "s#^ExecStart=$first_root/#ExecStart=$root/#" "$first_unit")
    if ! printf '%s\n' "$unit" | sudo -n cmp -s - "$UNITS/$service"; then
      printf '%s\n' "$unit" | sudo -n tee "$UNITS/$service" >/dev/null
      sudo -n chmod 644 "$UNITS/$service"
    fi
  fi
  sudo -n install -d -m 755 "$UNITS/$service.d"
  printf '[Service]\nCPUAffinity=%s\n' "$cpus" | sudo -n tee "$UNITS/$service.d/cpu.conf" >/dev/null
done
sudo -n systemctl daemon-reload

for line in "${instances[@]}"; do
  IFS=$'\t' read -r name _ cpus <<<"$line"
  service="actions.runner.kitepon.$name.service"
  sudo -n systemctl enable --now "$service"
  [ "$(affinity "$service")" = "$cpus" ] && continue
  if busy "$service"; then echo "restart pending (busy): $service"; pending=1; continue; fi
  sudo -n systemctl restart "$service"
done

# Profile v2 only after every instance exists, so setup never sees an instance it cannot verify.
node --input-type=module -e '
  const { DEDICATED_INSTANCES } = await import(process.argv[1]);
  console.log(JSON.stringify({ schema: "dotagents.runner-profile.v2", mode: "dedicated", state: "active", user: "factory-runner", label: "linux-workstation", instances: DEDICATED_INSTANCES }));
' "$ROOT/lib/factory/runner-profile.mjs" | sudo -n tee "$PROFILE" >/dev/null
sudo -n chown root:root "$PROFILE"
sudo -n chmod 644 "$PROFILE"
node "$ROOT/bin/factory-runner-profile.mjs" >/dev/null

for line in "${instances[@]}"; do
  IFS=$'\t' read -r name _ cpus <<<"$line"
  service="actions.runner.kitepon.$name.service"
  printf '%s active=%s affinity=%s wanted=%s\n' "$name" "$(systemctl is-active "$service")" "$(affinity "$service")" "$cpus"
done
gh api orgs/kitepon/actions/runners --jq '.runners[]|select(.name|startswith("factory-linux-rabbit-u"))|{name,status,busy,labels:[.labels[]|select(.type=="custom")|.name]}'
[ "$pending" = 0 ] || exit 3
