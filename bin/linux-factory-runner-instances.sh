#!/usr/bin/env bash
# Rabbit host apply (run by the host owner as the existing operator with sudo and gh admin:org).
# Registers the runner pool from FACTORY_RUNNERS and replaces the fixed per-instance units with the one load-driven
# scaler unit. Contract: docs/feature-map/runner-capacity.md.
# Idempotent; exit 3 = a Runner.Worker was running, so the unit swap is pending and a rerun completes it.
set -euo pipefail
set +x
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
RUNNER_USER=factory-runner
RUNNER_HOME=/home/factory-runner
RUNNER_NODE=$RUNNER_HOME/.local/bin/node
PROFILE=/etc/dotagents/factory-runner-profile.json
UNITS=/etc/systemd/system
SCALER=/usr/local/libexec/dotagents/factory-runner-scaler.mjs
CONFIG=/etc/dotagents/factory-runner-scaler.json
SERVICE=factory-runner-scaler.service
LOG=$RUNNER_HOME/factory-runner-scaler.log

sudo -n true
[ "$(id -nG "$RUNNER_USER")" = "$RUNNER_USER" ] || { echo 'factory-runner has extra groups; refuse' >&2; exit 2; }
if sudo -n -u "$RUNNER_USER" -H sudo -n true 2>/dev/null; then echo 'factory-runner can sudo; refuse' >&2; exit 2; fi
sudo -n -u "$RUNNER_USER" test -x "$RUNNER_NODE"

mapfile -t instances < <(node --input-type=module -e '
  const { FACTORY_RUNNERS } = await import(process.argv[1]);
  for (const item of FACTORY_RUNNERS.find((runner) => runner.label === "linux-workstation").instances) console.log([item.name, item.root].join("\t"));
' "$ROOT/lib/factory/deployment-contract.mjs")
IFS=$'\t' read -r first_name first_root <<<"${instances[0]}"
first_unit="$UNITS/actions.runner.kitepon.$first_name.service"

# 1. Pool roots: runner layout without identity, credentials, logs or work; symlinked bin/externals copied as content.
for line in "${instances[@]:1}"; do
  IFS=$'\t' read -r name root <<<"$line"
  sudo -n -u "$RUNNER_USER" test -f "$root/.runner" && continue
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
done

# 2. Scaler file and config, root-owned (the runner principal reads them only).
sudo -n install -d -m 755 "$(dirname "$SCALER")" /etc/dotagents
sudo -n install -m 644 -o root -g root "$ROOT/lib/factory/runner-scaler.mjs" "$SCALER"
node "$ROOT/bin/factory-runner-scaler-config.mjs" linux-workstation "$LOG" | sudo -n tee "$CONFIG" >/dev/null
sudo -n chown root:root "$CONFIG"
sudo -n chmod 644 "$CONFIG"

# 3. Scaler unit: the first runner unit's hardening; listeners outlive scaler restarts (KillMode=process) and are adopted.
if [ -f "$first_unit" ]; then
  unit=$(sed -e 's#^Description=.*#Description=Load-driven GitHub Actions runner pool for kitepon (dotagents)#' \
    -e "s#^WorkingDirectory=.*#WorkingDirectory=$RUNNER_HOME#" -e "s#^ExecStart=.*#ExecStart=$RUNNER_NODE $SCALER $CONFIG#" \
    -e 's#^KillMode=.*#KillMode=process#' -e 's#^Restart=.*#Restart=always#' -e 's#^UMask=0022$#UMask=0022\nNice=10\nCPUWeight=20#' "$first_unit")
  printf '%s\n' "$unit" | sudo -n tee "$UNITS/$SERVICE" >/dev/null
  sudo -n chmod 644 "$UNITS/$SERVICE"
fi
[ -f "$UNITS/$SERVICE" ] || { echo "neither $first_unit nor $UNITS/$SERVICE exists" >&2; exit 2; }

# 4. Swap only while no job runs; a running job is never cancelled.
if pgrep -u "$RUNNER_USER" -x Runner.Worker >/dev/null; then echo 'swap pending (a Runner.Worker is running); rerun later'; exit 3; fi
for line in "${instances[@]}"; do
  IFS=$'\t' read -r name _ <<<"$line"
  service="actions.runner.kitepon.$name.service"
  [ -f "$UNITS/$service" ] || continue
  sudo -n systemctl disable --now "$service"
  sudo -n rm -rf "$UNITS/$service" "$UNITS/$service.d"
done
sudo -n systemctl daemon-reload
sudo -n systemctl enable "$SERVICE"
sudo -n systemctl restart "$SERVICE"

# 5. Profile v3 after the pool exists, so setup never sees an instance it cannot verify.
node --input-type=module -e '
  const { POOL_INSTANCES, SCALER_SERVICE } = await import(process.argv[1]);
  console.log(JSON.stringify({ schema: "dotagents.runner-profile.v3", mode: "dedicated", state: "active", user: "factory-runner", label: "linux-workstation", service: SCALER_SERVICE, instances: POOL_INSTANCES }));
' "$ROOT/lib/factory/runner-profile.mjs" | sudo -n tee "$PROFILE" >/dev/null
sudo -n chown root:root "$PROFILE"
sudo -n chmod 644 "$PROFILE"
node "$ROOT/bin/factory-runner-profile.mjs" >/dev/null

# 6. Readback: scaler active, its first decisions, pool registrations.
sleep 40
systemctl is-active "$SERVICE"
sudo -n -u "$RUNNER_USER" tail -n 5 "$LOG"
gh api orgs/kitepon/actions/runners --jq '.runners[]|select(.name|startswith("factory-linux-rabbit-u"))|{name,status,busy,labels:[.labels[]|select(.type=="custom")|.name]}'
