# Factory runner capacity: parallel instances per host

[Overall index](../09_feature-map.md) / [factory-ci runbook](../../shared/runbooks/factory-ci.md) / [contract](../../lib/factory/deployment-contract.mjs) / [current state](../factory-current-state.md) / [setup](setup.md) / [CI](ci-distribution.md)

Why: on 2026-11-08 the Owner directed parallel CI on existing factory hardware (delivered by Shiratsuru). Fox (`windows-native`) had one runner and five PR runs queued behind a ~2.5 h job. Each seat now runs several independent runner instances under the SAME host label and the SAME dedicated non-admin principal, each pinned to a disjoint CPU set. Products keep sizing their parallelism from `os.availableParallelism()`, which follows the set. The Mac seat is unchanged (one instance, no CPU set).

## Instances (source of truth: `FACTORY_RUNNERS[].instances` in `lib/factory/deployment-contract.mjs`)

| Seat label | Instance | Root | CPU set | Owner CPUs |
| --- | --- | --- | --- | --- |
| `linux-workstation` (Rabbit, 24 logical, 30 GiB) | `factory-linux-rabbit-u` | `/home/factory-runner/actions-runner` | 8-15 | 0-7 (interactive GUI seat) |
| | `factory-linux-rabbit-u2` | `/home/factory-runner/actions-runner-2` | 16-23 | |
| `windows-native` (Fox, 32 logical, 61.6 GB) | `factory-windows-fox-u` | `C:\actions-runner-dotagents-u` | 8-15 | 0-7 (Owner console) |
| | `factory-windows-fox-u2` | `C:\actions-runner-dotagents-u2` | 16-23 | |
| | `factory-windows-fox-u3` | `C:\actions-runner-dotagents-u3` | 24-31 | |

Count basis: about 8 CPUs per job. RAM was checked against current samples only (Fox 01:27 JST Lattice full: 1.51 GB working set with 32 GB free; Rabbit 22 GiB available). No full-job PEAK RSS has been measured, so the RAM fit is an expectation recorded at the first concurrent observation, not a measured guarantee. Fall back to 2 x 12 on Fox only if that observation shows memory pressure.

## Function diagram

| Owner / function | Inputs | Output and state owned | Refusal / failure |
| --- | --- | --- | --- |
| Dotagents, `deployment-contract.mjs:FACTORY_RUNNERS` | Source edit | Seat label, full-CI flag, instances `{name, root, cpus}` | `render-current-docs` refuses empty/duplicate names, labels or instance names. |
| Dotagents, `bin/windows-factory-runner-job-started.ps1` (host copy `C:\ProgramData\dotagents\factory-runner\job-started.ps1`, admin/SYSTEM-writable) | Runner job-started hook (via the dedicated relay) with `RUNNER_NAME` from the job environment | Runner.Worker affinity = pinned set for that name, priority BelowNormal | Unknown name: previous rule (all but the first 8). Any error: warning, exit 0, job continues. |
| Dotagents, `bin/windows-factory-runner-task-entry.ps1` (host copy `C:\ProgramData\dotagents\factory-tools\native-task-entry.ps1`) | Existing task `\dotagents-factory-runner-dedicated` (factory-runner, Password, Limited) at startup | For each pinned root: registers it if it has no `.runner` and the registration pipe is offered, then starts `run-dedicated.ps1 -Root` with a clean environment; waits for all children | Unregistered root without pipe: skipped (logged), others still start. Registration failure: that root stays unregistered, others run. |
| Dotagents, `bin/windows-factory-runner-run.ps1` (host copy `...\factory-tools\run-dedicated.ps1`) | `-Root` from the pinned list; registration token on stdin when registering | `config.cmd` with `--name <instance> --labels factory,windows-native`, then `run.cmd` in that root | Root outside the pinned list or token missing: exit non-zero. |
| Dotagents, `bin/windows-factory-runner-instances.ps1` (run elevated by Dorothy after Owner approval) | Staged repo files, token from the existing admin API broker | New roots (copy of the registered root's runner layout and ACL, without identity/state files), installed helpers/hook, one task restart while idle, registration over a FirstPipeInstance pipe, API readback | Not elevated, factory account admin/unexpected SID, task credential type changed, Runner.Worker present: exit without change. It never resets the factory password (that would destroy the user DPAPI key protecting `.credentials_rsaparams`). |
| Dotagents, `lib/factory/runner-profile.mjs` + `bin/factory-runner-profile.mjs` | `/etc/dotagents/factory-runner-profile.json` (root-owned) | Normalized `{mode, user, label, instances[{name, service, root}]}`; v1 = one instance, v2 = contract instances | Foreign identity, trial state, partial instance list, writable/symlink: refuse (no legacy fallback). |
| Dotagents, `bin/setup-linux-common.sh:ensure_github_actions_runner` | Profile | Per instance: User/Group/groups/NNP/capabilities/active and online+labels | Any instance failing: setup stops; it never starts, registers or relabels a dedicated instance. |
| Dotagents, `bin/linux-factory-runner-instances.sh` (Rabbit host apply by Sorin) | Contract instances, kite's `gh` (admin:org), sudo | New root copy as factory-runner, registration (token on stdin), unit per instance (same hardening as rabbit-u), `CPUAffinity=` drop-in per instance, profile v2, enable new units, restart an existing unit only while idle | Busy existing instance: exits 3 after the idle-independent steps; rerun completes the restart. Any registration/readback failure stops; nothing already registered is removed. |
| Product repo workflows | `runs-on: [self-hosted, factory, <label>]` | Their own tests | Fixed ports / global paths that collide between concurrent jobs are product defects (reported to Shiratsuru, not repaired here). |

## Data flow

| Stage | Producer → consumer | Transform / state | Failure behavior |
| --- | --- | --- | --- |
| Contract | `FACTORY_RUNNERS` → `factory-current-state.md`, profile parser, Linux apply script, hook test | instance names/roots/CPU sets | Hook map and contract are compared by `tests/factory-reporter/windows-runner-job-started-hook.test.mjs`. |
| Fox registration | Elevated script → pipe `dotagents-factory-runner-register` (FirstPipeInstance; Admins/SYSTEM full, factory RW) → task entry → `run-dedicated.ps1` stdin → `config.cmd` env `ACTIONS_RUNNER_INPUT_TOKEN` | token never on disk, argv or log; result lines per root back over the pipe | Squatted pipe name: server create fails, no token sent. |
| Fox job start | GitHub → instance listener → Worker → hook (`RUNNER_NAME`) | affinity mask from the pinned set | warning only. |
| Rabbit registration | `gh api POST registration-token` (kite) → stdin → `config.sh` as factory-runner | same as the 2026-10-15 install | token unset after use. |
| Rabbit job start | systemd unit + `cpu.conf` drop-in → runsvc.sh → Listener → Worker → steps | `sched_getaffinity` = set, inherited by every step | none (kernel-enforced). |

## Deployment, admission and rollback

Order per host: (1) prepare and register new instances while the existing one keeps working; (2) apply CPU sets; (3) restart the existing instance only when it has no Runner.Worker. Running jobs are never cancelled. A job assigned in the seconds between the idle check and the restart is the residual risk documented in Shiratsuru's requeue contract (it fails as a runner shutdown and is re-run normally).

- Fox: one Owner + Approval Box admin step runs `windows-factory-runner-instances.ps1 -Mode Apply`. Rollback: restore the previous entry/run/hook files (their SHA-256 are printed by `-Mode Inspect`), restart the task while idle, remove the u2/u3 registrations with the normal remove token. Roots may be deleted after deregistration.
- Rabbit: Sorin runs `bin/linux-factory-runner-instances.sh` from the merged checkout on Rabbit. Rollback: disable u2, remove its registration, delete the `cpu.conf` drop-ins, restore profile v1, restart rabbit-u while idle.
- Acceptance: on each host, one observation of two naturally queued jobs running at the same time on different instances, with the hook/affinity line and memory recorded. No manual CI dispatch for this proof.

## Verification

- `tests/install/runner-profile.test.mjs`: v1 and v2 parse; partial/foreign v2 refused.
- `tests/install/linux-runner-registration.sh`: setup checks every profile instance.
- `tests/factory-reporter/windows-runner-job-started-hook.test.mjs`: pinned map equals the contract; on Windows CI, an unknown name keeps the old rule.
- `tests/docs/current-docs.test.mjs`: instance rendering.
- The Fox/Rabbit apply scripts are parsed/linted in CI but run only on the hosts; their real effect is proven by the readback and the concurrency observation, not by tests.
