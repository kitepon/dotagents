# Factory runner capacity: load-driven runner pool per host

[Overall index](../09_feature-map.md) / [factory-ci runbook](../../shared/runbooks/factory-ci.md) / [contract](../../lib/factory/deployment-contract.mjs) / [current state](../factory-current-state.md) / [setup](setup.md) / [CI](ci-distribution.md)

Why: on 2026-11-08 the Owner directed parallel CI on existing factory hardware, then (11:1x JST) "decide the parallelism dynamically from real load, Mac too, minimum 1; CPUs dynamic too". The fixed design of the same morning (Rabbit 2 / Fox 3 instances, one pinned CPU set each, CPUs 0-7 reserved) is replaced: each seat keeps a POOL of registered runner instances under the SAME host label and the SAME dedicated non-admin principal, and ONE scaler per host decides from measured CPU idle, run-queue load (where the seat sets a limit) and available memory how many listeners run (1 to pool size). No CPU affinity anywhere; every job sees all CPUs (`os.availableParallelism()`) and runs at low priority, so the Owner's interactive work wins and also lowers the measured idle, which stops further scale-up.

## Pool (source of truth: `FACTORY_RUNNERS[]` in `lib/factory/deployment-contract.mjs`)

| Seat label | Pool (instances, roots) | Basis | `jobGiB` / `reserveGiB` / `maxLoadPerCpu` |
| --- | --- | --- | --- |
| `linux-workstation` (Rabbit, 24 logical, 30 GiB) | `factory-linux-rabbit-u`..`-u5`, `/home/factory-runner/actions-runner`, `-2`..`-5` | ~4 GiB largest job sample | 4 / 4 / none |
| `windows-native` (Fox, 32 logical, 61.6 GB) | `factory-windows-fox-u`..`-u8`, `C:\actions-runner-dotagents-u`, `-u2`..`-u8` | 1.86 GB private max per Lattice job (09:50-10:40 JST) | 3 / 4 / none (Windows has no load average) |
| `macos-native` (Mac M5, 10 logical, 24 GB, Owner laptop) | `factory-macos-m5-u`..`-u3`, `/Users/factory-runner/actions-runner`, `-2`, `-3` | one Lattice job tree 1.32 GB RSS (14:1x JST); laptop with swap in use, so 6 GiB stays for the Owner. Load: see "Mac load gate" | 3 / 6 / 1.0 |

Pool size is only a ceiling. The first instance keeps the existing name and root, so the existing registration and credentials stay.

Mac load gate (2026-11-08 18:0x JST, Shiratsuru/Snow): the first natural Mac pair (17:34-17:54 JST) failed two Lattice latency tests (1000 ms daemon identity probe, 5000 ms beforeEach) while the Mac's 1-minute load average was 50-520 on 10 CPUs (Nextcloud FileProvider, fileproviderd, Spotlight, media analysis, ESET). The scaler had started u3 at CPU idle 0.349 because background-QoS daemons queue on the efficiency cores while the performance cores show idle; idle alone does not show the queue. A second/third Mac job therefore also needs the 1-minute load average per logical CPU <= 1.0 (no run queue on average). Sample 17:59 JST with one job: load 50-60, idle 0.06-0.10 → hold. Linux/Windows keep idle + memory only.

Mac work folder: Spotlight indexed the runner roots, `_work` and `RUNNER_TEMP` (`_work/_temp`) (root `mdfind -name` hits, 18:0x JST). `.metadata_never_index` is not honored for folders on macOS 27 (probe: still indexed); a folder named `*.noindex` is excluded with all descendants (probe: control 1 hit, `.noindex` 0, nested 0). The Mac roots therefore use work folder `_work.noindex` (`.runner` `workFolder`; new registrations `--work _work.noindex`), which also moves `RUNNER_TEMP` and the tool cache. The roots' static `bin`/`externals` stay indexed (written only on runner update); moving the roots would need re-registration.

## Function diagram

| Owner / function | Inputs | Output and state owned | Refusal / failure |
| --- | --- | --- | --- |
| Dotagents, `deployment-contract.mjs:FACTORY_RUNNERS` | Source edit | Seat label, full-CI flag, `jobGiB`, `reserveGiB`, optional `maxLoadPerCpu`, instances `{name, root}` | `render-current-docs` refuses empty/duplicate names, labels or instance names and non-positive sizes. |
| Dotagents, `bin/factory-runner-scaler-config.mjs <label> <log>` | Contract | Scaler config JSON `{label, jobGiB, reserveGiB, maxLoadPerCpu?, log, instances}` written by the host apply step to a root/admin-owned path | Unknown label: exit 1. |
| Dotagents, `lib/factory/runner-scaler.mjs` (host copy: Rabbit/Mac `/usr/local/libexec/dotagents/factory-runner-scaler.mjs`, Fox `C:\ProgramData\dotagents\factory-tools\runner-scaler.mjs`; admin-owned) | Config path (argv); every 30 s: process table (Listener/Worker per root), `os.cpus()` deltas over >= 60 s, `os.loadavg()[0]` / logical CPUs, available memory, last run per root (newest `_diag` mtime, or the last tick that saw its listener) | Starts one listener (`<root>/bin/Runner.Listener run`, PATH from `<root>/.path`, own process group / own hidden console) or stops one idle listener (SIGINT; Windows Ctrl+Break into that listener's console); one JSON line per action, and one `hold` line whenever a scale-up is blocked (logged once per change of busy/running/gate). In-memory state only: idle-since per root. | Unregistered root (no `.runner`): never started. Spawn/stop failure: logged, next tick re-decides from the process table. Scaler exit: listeners keep running and are adopted by the next scaler. |
| `decide()` in the same module (pure, unit-tested) | Per root `{registered, running, busy, idleSince, lastRun}`, `cpuIdle`, `loadPerCpu`, `availGiB`, sizes, `maxLoadPerCpu`, now | `{action, name, reason, desired, gate}` (action = start, stop or none; `gate` = first failed headroom check: `cpu-window`, `cpu-idle`, `load`, `memory`, or null) | See state diagram. |
| Dotagents, `bin/linux-factory-runner-instances.sh` (Rabbit host apply by Sorin) | Contract, kite's `gh` (admin:org), sudo | Pool roots (copied layout + registration, token on stdin), scaler file + config, `factory-runner-scaler.service` derived from the first runner unit (same hardening; `KillMode=process`, `Nice=10`, `CPUWeight=20`, `Restart=always`), old per-instance units disabled and removed only while idle, profile v3 | Any old instance busy: exits 3 before disabling anything; rerun completes. Registration/readback failure stops; nothing registered is removed. |
| Dotagents, `lib/factory/runner-profile.mjs` + `bin/factory-runner-profile.mjs` | `/etc/dotagents/factory-runner-profile.json` (root-owned) | Normalized `{mode, user, label, instances[{name, service, root}]}`; v1 = one instance, v2 = per-instance units (prefix of the pool), v3 = whole pool under `factory-runner-scaler.service` | Foreign identity, trial state, wrong instance list, writable/symlink: refuse. |
| Dotagents, `bin/setup-linux-common.sh:ensure_github_actions_runner` | Profile | Every distinct service: User/Group/groups/NNP/capabilities/active; at least one pool instance online with the seat label | Any check failing: setup stops; it never starts, registers or relabels a dedicated instance. |
| Dotagents, `bin/windows-factory-runner-task-entry.ps1` (host `...\factory-tools\native-task-entry.ps1`) | Existing task `\dotagents-factory-runner-dedicated` (factory-runner, Password, Limited) | Registers roots without `.runner` when the elevated script offers the pipe (unchanged), then runs the scaler with a clean environment and waits for it | No registered root: exit 1. |
| Dotagents, `bin/windows-factory-runner-run.ps1` (host `run-dedicated.ps1`) | `-Root -Name -Register`, token on stdin | `config.cmd` for that root (registration only; listeners are started by the scaler) | Token missing: exit non-zero. |
| Dotagents, `bin/windows-factory-runner-job-started.ps1` (host `C:\ProgramData\dotagents\factory-runner\job-started.ps1`) | Job-started hook | Runner.Worker priority BelowNormal (inherited by steps); no affinity | Any error: warning, exit 0. |
| Dotagents, `bin/windows-factory-runner-instances.ps1` (elevated, Owner + Approval Box) | Staged repo files incl. scaler + generated config, token from the admin API broker | New pool roots (layout copy as before), helpers/hook/scaler installed, one task restart while idle, registration over the FirstPipeInstance pipe, readback | Not elevated, factory account admin, task principal changed, Runner.Worker present: exit without change. Never resets the factory password. |
| Dotagents, `bin/mac-factory-runner-pool.sh <checkout> <factory node>` (root via the Owner-allowed sudo helper) | Contract, registration token on stdin (from kite's `gh` on Rabbit) | Pool roots as factory-runner (layout copy + `config.sh --work _work.noindex`), every root's `.runner` `workFolder` → `_work.noindex` and the old `_work` removed only while that root has no Runner.Worker, scaler + config, LaunchDaemon `com.kitepon.factory-runner-scaler` (UserName factory-runner, ProcessType Interactive as before, `Nice` 10, `AbandonProcessGroup`), old per-runner plist booted out and kept as `.plist.disabled` only while idle; once swapped, a rerun only restarts the scaler (listeners are adopted, so no idle wait) | Busy Worker while the old plist still exists: exit 3 before unloading. Busy root: its old `_work` is kept and reported; a rerun removes it. Token missing for an unregistered root: exit 1. |
| Product repo workflows | `runs-on: [self-hosted, factory, <label>]` | Their own tests | Fixed ports / global paths that collide between concurrent jobs are product defects (reported to Shiratsuru, not repaired here). |

## State diagram (one pool instance, as seen by the scaler)

| From | Event / condition | To | Note |
| --- | --- | --- | --- |
| unregistered | host apply registers the root | stopped | Only the admin step registers. |
| stopped | `running < desired`, least-recent `lastRun` first | idle | start |
| stopped | headroom AND `lastRun` older than 7 days | idle | refresh: GitHub deletes self-hosted runners offline > 14 days; trimmed again after 120 s idle. New roots (no `_diag`) refresh first. |
| idle | Runner.Worker appears | busy | |
| busy | Worker exits (job end) | idle | self-exit of the "never stop busy" guard |
| idle | `running > desired` AND idle >= 120 s, longest idle first | stopped | SIGINT / Ctrl+Break: graceful, deletes the session |
| idle / busy | listener exits by itself (self-update, error, session conflict) | stopped | next tick re-decides |

`busy` = roots with a Runner.Worker. `headroom` = CPU idle >= 30 % (60 s window complete) AND (no `maxLoadPerCpu`, or 1-minute load average / logical CPUs <= `maxLoadPerCpu`) AND available memory >= `jobGiB + reserveGiB`. `desired = clamp(busy + (headroom ? 1 : 0), 1, registered)`. One action per tick. Guards (named protection): a busy listener is never stopped (running job = data loss); the count never goes below 1 (Owner minimum). Both leave by themselves: the job ends, or more load arrives.

Available memory: Linux `os.freemem()` (MemAvailable), Windows `os.freemem()` (available physical), macOS `kern.memorystatus_level` (the system's memory-free percentage, as `memory_pressure` prints) × physical memory; `vm_stat` free + inactive pages miss compressible memory (2026-11-08 14:1x JST, one Lattice job running: 5 GiB by pages vs 42 % = 10 GiB free, 5 GiB swap in use).

## Data flow

| Stage | Producer → consumer | Transform / state | Failure behavior |
| --- | --- | --- | --- |
| Contract | `FACTORY_RUNNERS` → `factory-current-state.md`, profile parser, scaler config generator, apply scripts, tests | names/roots/sizes | Tests compare the PowerShell maps with the contract. |
| Config | generator → admin-owned JSON next to the scaler | label, sizes, log path, instances | Scaler refuses a config without instances. |
| Load sample | OS → scaler | CPU idle fraction (>= 60 s window), 1-minute load average per logical CPU, available GiB, process table (`ps -A -o pid=,args=`; Windows CIM `Win32_Process` ExecutablePath) mapped to roots by path prefix | Sample failure: tick skipped. |
| Decision | `decide()` → action | start/stop one root | none |
| Action log | scaler → `<log>` | `{at, action, name, reason, busy, running, desired, gate, cpuIdle, loadPerCpu, availGiB}`; action `hold` = scale-up blocked by `gate` | Write failure ignored (logged to stderr). |
| Registration | Rabbit `gh` / Fox admin broker pipe / Rabbit `gh` → ssh → Mac sudo stdin → `config.*` as factory-runner | token never on disk, argv or log | same as before |

## Deployment, admission and rollback

Order per host: (1) register the new pool roots while the existing listeners keep working; (2) install scaler + config; (3) swap the supervisor (old units/plist/task children) only when no Runner.Worker exists. Running jobs are never cancelled. A job assigned in the seconds between the idle check and a stop is the residual risk in Shiratsuru's requeue contract.

- Rabbit (Sorin): `PATH="$HOME/.local/bin:$PATH" bin/linux-factory-runner-instances.sh` as kite from the merged checkout. Rollback: stop/disable the scaler unit while idle, restore the per-instance units for u/u2 from git history (bf8600f), profile v2.
- Fox (Owner + Approval Box): `windows-factory-runner-instances.ps1 -Mode Apply`. Rollback: restore the previous entry/run/hook (SHA-256 printed by `-Mode Inspect`), restart the task while idle.
- Mac (Dorothy, sudo helper): `bin/mac-factory-runner-pool.sh` with the token on stdin. Rollback: unload the scaler plist while idle, reload the old plist (kept as `.disabled`).
- Acceptance: per host, from the scaler log under natural load, one scale-up past 1 and one scale-down back to 1. No manual CI dispatch.

## Verification

- `tests/factory-reporter/runner-scaler.test.mjs`: `decide()` (scale up, headroom gates incl. the load gate and its `gate` name, max, minimum 1, idle 120 s, never busy, LRU, refresh), sampling parsers, config generator.
- `tests/install/runner-profile.test.mjs`: v1/v2/v3 parse; partial/foreign refused.
- `tests/install/linux-runner-registration.sh`: setup checks every service and needs one instance online.
- `tests/factory-reporter/windows-runner-instances.test.mjs` / `windows-runner-job-started-hook.test.mjs`: maps equal the contract; hook sets priority only.
- `tests/docs/current-docs.test.mjs`: pool rendering.
- Apply scripts are linted/parsed in CI and run only on the hosts; their effect is proven by readback and the scaler log.
