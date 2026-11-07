# Mac factory Node runtime: functions, data flow and states

[Overall index](../09_feature-map.md) / [factory-ci runbook](../../shared/runbooks/factory-ci.md) / [script](../../lib/factory/mac-node-runtime.sh) / [test](../../tests/factory-node-runtime/node-runtime.test.mjs)

Standard toolchain provided by dotagents to product CI on `factory-macos-m5-u` (`macos-native`). Generalised from Snow White's Lattice installer (Lattice `snowwhite/ci-macos-node-path` @ `5751bea2`, `scripts/ci-macos-node-runtime.sh`), which was proven on the real host on 2026-11-08 (job 128453751727). Why it exists: ESET on the Mac allows inbound LAN connections per exact executable path, and the ESET chooser running as the console user cannot traverse the runner home `/Users/factory-runner` (0700). The Owner approved `/Users/Shared` (1777, sticky) as the location on 2026-11-08 00:58 JST.

No exclusive physical-cache allocation or all-consumer exit handoff exists on the Mac (see `docs/factory-mac-cache-contract-20261108.md` in Dorothy's project). This design therefore never replaces, renames over or deletes a tree another job may be running.

## Function diagram

| Owner / function | Callers and inputs | Output and state owned | Refusal / failure |
| --- | --- | --- | --- |
| Dotagents, `lib/factory/mac-node-runtime.sh` (source; not linked into HOME by install.sh) | dotagents repo; deployed copy only | Pinned `version sha256` case table (one line per pin) | An unpinned pair exits 2 before touching the filesystem. |
| Dotagents, host copy `/usr/local/libexec/dotagents/factory-node-runtime.sh` (root:wheel 0755, dir root:wheel 0755) | Product workflow step on the Mac runner (UID 600), or the deployment staging run (`sudo -u factory-runner`) with `<version> <sha256>` | Selected or newly published generation; receipt JSON on stdout; `directory=` and `node=` appended to `GITHUB_OUTPUT` when set | Not darwin-arm64, relative base, unpinned pair, no safe root creatable, download/SHA/extract/verify failure: non-zero exit; only the process's own unpublished `gN` is removed. |
| Product repo workflow | Calls the host copy with the version+SHA it needs; consumes `steps.<id>.outputs.node` | Its own tests | Products do not install Node under the runner home, do not pass a base, do not delete generations. |
| ESET rule (Brid / Owner) | Exact `execPath` from the receipt | Allow rule for that one path | Not part of this script. A new generation path needs a new rule. |
| Retirement (Dorothy, environment work) | Positive consumer-exit accounting | Removal of a retired generation or of `/Users/Shared/lattice-node` | Never done by the script. `/Users/Shared/lattice-node` is a separate namespace and is untouched until the factory runtime is accepted and no consumer can use it. |

## Data flow

| Stage | Producer → consumer | Transform / state | Failure behavior |
| --- | --- | --- | --- |
| Pin | Caller args → pin table | `<version> <sha256>` must equal one pinned line | exit 2, nothing created. |
| Root | Script → `$FACTORY_NODE_BASE` (default `/Users/Shared`) | Names `factory-node`, `factory-node.2`, `factory-node.3`, … in order; use the first real (non-symlink) directory owned by the caller UID with no group/other write. If none, `mkdir -m 755` the next unused name (EEXIST → next). | Unsafe pre-existing names (other owner, symlink, group/other writable, non-directory) are skipped and never modified. |
| Select | Root → `v<version>-<sha16>/g1, g2, …` ascending | Candidate needs `.factory-complete` equal to `version=<v> sha256=<64 hex> uid=<uid>` and must pass verify (Node version, binary owner = caller UID, no group/other write). First passing candidate wins. | Failing candidates are left untouched and skipped. |
| Reserve | Script → identity dir | `mkdir -m 755 g<max+1>`; EEXIST → next number. `mkdir` is the exclusive create. | Other mkdir errors fail. |
| Build | nodejs.org official darwin-arm64 archive → own `gN` | download, `shasum -a 256` check against the pin, `tar --no-same-owner`, archive removal, verify | EXIT trap removes only this process's own unpublished `gN`. |
| Publish | Own `gN` → marker | write `.factory-complete.tmp`, same-directory `mv` to `.factory-complete`, then clear the trap | Before the rename the generation is never selectable. |
| Receipt | Selected generation → caller | JSON `{node, execPath, identity, generation, sha256, uid, mode, marker}`; `directory=`/`node=` to `GITHUB_OUTPUT` if set | Receipt is printed only after a final verify. |

Directories are created with `mkdir -m 755` under `umask 022`; files carry no group/other write; the owner is the calling UID (600 on the runner). The group is inherited from `/Users/Shared` (wheel) and carries no write bit.

## Durable states

| State | Entry | Next invocation |
| --- | --- | --- |
| `/Users/Shared/lattice-node/...` present | Lattice PR53 jobs | Different root name; never selected, never touched. |
| Root name squatted or unsafe | Another user or a symlink | Skipped untouched; next sibling name used or created. |
| Empty root / identity dir | Interrupted after mkdir | Already safe by creation mode; next call reserves `g1`. |
| `gN` without marker, or only `.factory-complete.tmp` | Interrupted build, or another writer still building | Not selected, not deleted, not waited on. |
| Published `gN` that now fails verify | Damage after publication | Skipped untouched; later number used or reserved. |
| Several complete generations | Concurrent first builds | All kept; the lowest verifying number is selected from then on, so the ESET rule stays on one path. |

No lock, daemon, sweep or wait-for-human guard. Every invocation ends using a verified tree or building a new one; a failure fails only that job and the next normal job retries from the state above. Integrity strength equals the Lattice installer: the archive SHA is checked once at build; selection checks marker identity, version, owner and mode, not a re-hash.

## Deployment and rollback (host copy)

1. From the merged `origin/main` commit, `sudo install -d -o root -g wheel -m 0755 /usr/local/libexec/dotagents` and `sudo install -o root -g wheel -m 0755 lib/factory/mac-node-runtime.sh /usr/local/libexec/dotagents/factory-node-runtime.sh`. Read back owner, mode and SHA-256 of the installed file against the commit blob.
2. Stage the first generation as the runner principal: `cd / && sudo -u factory-runner -H env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME=/Users/factory-runner /usr/local/libexec/dotagents/factory-node-runtime.sh <version> <sha256>`. The receipt JSON is what Brid selects in the ESET chooser.
3. Rollback of the host copy: remove `/usr/local/libexec/dotagents/factory-node-runtime.sh`. Published generations are not removed by rollback; they are retired only after consumer-exit accounting.

## Verification

`tests/factory-node-runtime/node-runtime.test.mjs` runs only on darwin-arm64 (skipped elsewhere) inside `make test-factory-core`. It copies the script with a test pin for the CI Node version and uses fake runtimes that are copies of the CI Node binary (so the owner is the test UID; `lib` is linked for Homebrew's `@loader_path/../lib`) and a failing `curl` stub. Cases: unpinned pair refused with nothing created; `lattice-node` namespace and squatted roots skipped untouched; unpublished `g1` skipped and complete `g2` reused; mismatched marker or failed verify skipped untouched; build failure removes only its own reservation. The real download/SHA/extract path is proven by the host staging run, not by the test.
