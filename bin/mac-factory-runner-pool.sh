#!/bin/bash
# shellcheck disable=SC2016 # single-quoted scripts below are expanded by the inner shell
# Mac host apply, run as root through the Owner-allowed sudo route:
#   mac-factory-runner-pool.sh <dotagents checkout> <factory node binary>
# Registers the runner pool from FACTORY_RUNNERS (the registration token is read from stdin, only when a pool root is
# unregistered) and replaces the per-runner LaunchDaemon with the one load-driven scaler.
# Contract: docs/feature-map/runner-capacity.md. Idempotent; exit 3 = a Runner.Worker was running before the first
# supervisor swap, so the swap is pending and a rerun completes it. After the swap a rerun only restarts the scaler.
# Work folder `_work.noindex`: Spotlight skips `*.noindex` folders (`.metadata_never_index` is ignored for folders).
set -euo pipefail
set +x
SRC=$1
NODE=$2
RUNNER_USER=factory-runner
RUNNER_HOME=/Users/factory-runner
SCALER=/usr/local/libexec/dotagents/factory-runner-scaler.mjs
CONFIG=/etc/dotagents/factory-runner-scaler.json
LABEL=com.kitepon.factory-runner-scaler
PLIST=/Library/LaunchDaemons/$LABEL.plist
LOG=$RUNNER_HOME/factory-runner-scaler.log
as_runner() { sudo -u "$RUNNER_USER" -H env -i HOME="$RUNNER_HOME" PATH=/usr/bin:/bin:/usr/sbin:/sbin "$@"; }

[ "$(id -u)" = 0 ] || { echo 'run as root' >&2; exit 2; }
if dseditgroup -o checkmember -m "$RUNNER_USER" admin >/dev/null 2>&1; then echo 'factory-runner is an admin; refuse' >&2; exit 2; fi
as_runner test -x "$NODE"
# $NODE is factory-runner-owned, so it only ever runs as factory-runner (never as root); $SRC must be world-readable.

instances=()
while IFS= read -r line; do instances+=("$line"); done < <(as_runner "$NODE" --input-type=module -e '
  const { FACTORY_RUNNERS } = await import(process.argv[1]);
  for (const item of FACTORY_RUNNERS.find((runner) => runner.label === "macos-native").instances) console.log([item.name, item.root].join("\t"));
' "$SRC/lib/factory/deployment-contract.mjs")
IFS=$'\t' read -r first_name first_root <<<"${instances[0]}"
old_label="actions.runner.kitepon.$first_name"
WORK=_work.noindex

# 1. Pool roots: runner layout without identity, credentials, logs or work; symlinked bin/externals copied as content.
for line in "${instances[@]:1}"; do
  IFS=$'\t' read -r name root <<<"$line"
  as_runner test -f "$root/.runner" && continue
  [ -n "${registration_token:-}" ] || IFS= read -r registration_token
  [ -n "$registration_token" ] || { echo 'registration token missing on stdin' >&2; exit 1; }
  as_runner /bin/bash -c 'umask 077 && mkdir -p "$2" && cd "$1" && cp -R -L -p bin externals config.sh env.sh run.sh run-helper.sh.template run-helper.cmd.template safe_sleep.sh .env .path "$2"/' _ "$first_root" "$root"
  printf '%s\n' "$registration_token" | as_runner /bin/bash -c '
    set -euo pipefail; set +x
    IFS= read -r ACTIONS_RUNNER_INPUT_TOKEN; export ACTIONS_RUNNER_INPUT_TOKEN
    cd "$1" && ./config.sh --unattended --url https://github.com/kitepon --name "$2" --labels factory,macos-native --work "$3"
  ' _ "$root" "$name" "$WORK"
done
unset registration_token

# 1b. Work folder out of Spotlight: .runner workFolder (UTF-8 BOM JSON, read by every new Worker) first, then the old
#     _work only while that root has no Runner.Worker (a running job keeps its folder; a rerun removes it later).
for line in "${instances[@]}"; do
  IFS=$'\t' read -r name root <<<"$line"
  as_runner "$NODE" -e '
    const fs = require("fs"); const [file, work] = process.argv.slice(1);
    const settings = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/u, ""));
    if (settings.workFolder !== work) {
      settings.workFolder = work;
      fs.writeFileSync(file + ".tmp", "\uFEFF" + JSON.stringify(settings, null, 2), { mode: 0o644 });
      fs.renameSync(file + ".tmp", file);
    }
  ' "$root/.runner" "$WORK"
  as_runner test -d "$root/_work" || continue
  sleep 2
  if pgrep -u "$RUNNER_USER" -f "^$root/bin[^/]*/Runner.Worker" >/dev/null; then echo "$name: old _work kept (job running); rerun later"; continue; fi
  as_runner rm -rf "$root/_work"
done

# 2. Scaler file and config, root-owned (the runner principal reads them only).
install -d -o root -g wheel -m 755 "$(dirname "$SCALER")" /etc/dotagents
install -o root -g wheel -m 644 "$SRC/lib/factory/runner-scaler.mjs" "$SCALER"
as_runner "$NODE" "$SRC/bin/factory-runner-scaler-config.mjs" macos-native "$LOG" >"$CONFIG"
chown root:wheel "$CONFIG"
chmod 644 "$CONFIG"

# 3. Scaler LaunchDaemon: same principal, environment and ProcessType as the old runner plist; Nice 10 lets the Owner's
#    work go first. Listeners run in their own process group and outlive a scaler restart (adopted by the next one).
cat >"$PLIST.new" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key><array><string>$NODE</string><string>$SCALER</string><string>$CONFIG</string></array>
	<key>UserName</key><string>$RUNNER_USER</string>
	<key>GroupName</key><string>$RUNNER_USER</string>
	<key>WorkingDirectory</key><string>$RUNNER_HOME</string>
	<key>EnvironmentVariables</key><dict><key>HOME</key><string>$RUNNER_HOME</string><key>PATH</key><string>/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
	<key>ProcessType</key><string>Interactive</string>
	<key>Nice</key><integer>10</integer>
	<key>Umask</key><integer>63</integer>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>AbandonProcessGroup</key><true/>
	<key>StandardErrorPath</key><string>$RUNNER_HOME/factory-runner-scaler.err</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST.new"
chmod 644 "$PLIST.new"
plutil -lint "$PLIST.new" >/dev/null

# 4. First swap only while no job runs; a running job is never cancelled. The old plist stays as .disabled for rollback.
#    Once swapped, restarting the scaler is safe with jobs running: listeners live in their own process groups.
if [ -f "/Library/LaunchDaemons/$old_label.plist" ]; then
  if pgrep -u "$RUNNER_USER" -x Runner.Worker >/dev/null; then rm -f "$PLIST.new"; echo 'swap pending (a Runner.Worker is running); rerun later'; exit 3; fi
  launchctl bootout "system/$old_label" 2>/dev/null || true
  mv "/Library/LaunchDaemons/$old_label.plist" "/Library/LaunchDaemons/$old_label.plist.disabled"
fi
launchctl bootout "system/$LABEL" 2>/dev/null || true
mv "$PLIST.new" "$PLIST"
launchctl bootstrap system "$PLIST"

# 5. Readback: scaler running and its first decisions.
sleep 40
launchctl print "system/$LABEL" | grep -E '^\s*(state|pid) ='
as_runner tail -n 5 "$LOG"
