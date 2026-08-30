# Factory reporter credential・設定ランブック

更新日: 2026-08-29
正本: dotagents  
対象: Mac / main-server / FOX WSL2 / FOX Windows native

## 安全境界

- config未配置または`reporting.enabled=false`ではenqueueとnetwork送信を行わない。
- token、実config、outboxはgitへ入れない。tokenを引数、query parameter、通常JSON出力へ出さない。
- host identityはtop-level `host.id / host.profile`で固定し、tokenのserver-side bindingと一致させる。
- credential fileは所有者限定。POSIXはdirectory `0700`・file `0600`、Windowsは継承ACLを除去して現在userだけにする。
- **本番BugHubの入口は[工場の現行状態](factory-current-state.md)に生成する**。4 hostはいずれも同ページのendpointを使う。`FACTORY_V<N>_INGEST_ENABLED=true`を明示するまで各majorの入口は404にする。host別rollback用の入口と履歴は独立して維持し、wire majorを暗黙変換しない。作業前にhost configの`reporting.endpoint`を同ページと照合する。
- Pi5からのServerManager outageは、main-server上の`factory-external-event`だけで記録する。任意本文・path・URLは受け取らず、固定`check`/`reason`とcanonical UTCだけを保存する。

## 1. 送信OFFでconfigを配置

雛形は [examples/factory-reporter/](../examples/factory-reporter/) にある。秘密は含まず、collection/reportingともOFFである。

POSIX:

```bash
install -d -m 700 ~/.config/dotagents
install -m 600 examples/factory-reporter/mac.json ~/.config/dotagents/factory-reporter.json
```

main-serverは`main-server.json`、FOX WSL2は`fox-wsl.json`を使う。Windows nativeは`windows-workstation.json`を`%LOCALAPPDATA%\dotagents\factory-reporter\config.json`へコピーし、PowerShellでACLを限定する。

```powershell
$dir = "$env:LOCALAPPDATA\dotagents\factory-reporter"
New-Item -ItemType Directory -Force $dir | Out-Null
Copy-Item examples\factory-reporter\windows-workstation.json "$dir\config.json"
icacls $dir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F"
```

## 2. host credentialを発行

新codeをmain-serverへdeployした後、factory入口をONにする前でも発行できる。token staging directoryはrepo外のBugHub data bind内に作る。

```bash
ssh main-server 'install -d -m 700 /home/kite/bughub/data/credentials'
ssh main-server 'cd /home/kite/bughub && docker compose exec -T bughub node src/factory-admin.js provision --host-id mac-kite --profile mac --token-output /app/data/credentials/mac-kite.token'
```

4組の固定対応:

| host id | profile | token staging名 |
|---|---|---|
| `mac-kite` | `mac` | `mac-kite.token` |
| `main-server` | `server` | `main-server.token` |
| `fox-wsl` | `wsl` | `fox-wsl.token` |
| `windows-workstation` | `windows-native` | `windows-workstation.token` |

commandのJSON出力に含まれる`credential_id`は秘密ではない。revoke用に運用記録へ残す。token本文はstdoutへ出ない。

## 3. tokenを対象hostへ配置

POSIXの配置先:

```bash
install -d -m 700 ~/.config/dotagents/credentials
ssh main-server 'cat /home/kite/bughub/data/credentials/mac-kite.token' > ~/.config/dotagents/credentials/factory.token
chmod 600 ~/.config/dotagents/credentials/factory.token
```

対象hostでbyte数が0でないことだけを確認し、内容は表示しない。配置確認後、server上の平文staging fileを削除する。

```bash
test -s ~/.config/dotagents/credentials/factory.token
ssh main-server 'rm -f /home/kite/bughub/data/credentials/mac-kite.token'
```

Windows nativeは`scp`で`%LOCALAPPDATA%\dotagents\factory-reporter\credential`へ直接保存し、directoryとfileへ現在userだけのACLを設定する。WSL側tokenとWindows native tokenを共用しない。

## 4. 明示ON

reporter configの`reporting`を次の形へ編集する。tokenが存在するだけではONにならない。

```json
{
  "enabled": true,
  "endpoint": "http://192.168.1.2:39310<factory-current-stateのendpoint>",
  "credential_file": "/home/kite/.config/dotagents/credentials/factory.token"
}
```

Windowsでは`credential_file`にWindows nativeの絶対pathをJSON escapingして指定する。`endpoint`のplaceholderは[工場の現行状態](factory-current-state.md)の本番BugHub endpointへ置換する。host clientをONにする前に、次のserver-first順序を完了する。rollback入口と履歴はmajorごとに独立して残す。

## 4a. 旧wireのserver-first履歴とhost別rollback

wire v6導入時は、main-serverでv5入口を維持したまま`FACTORY_V6_INGEST_ENABLED=false`でschema v6対応codeを先行deployし、server flagをONにしてからhostを1台ずつdual-runした。この順序は完了履歴であり、新規hostをv6へ導入する手順ではない。現役は§4cのv8である。

v6からそのhostだけをrollbackする時は、次の順序を守る。

1. host configを退避する。
2. configの`reporting.endpoint`を`/api/factory/v5/reports`へ変更する。
3. `factory-reporter-scheduler install --wire-major v5 --dry-run --platform <OS>`でartifactを確認し、H承認後に`--apply`でv5 schedulerを登録する。v6 state/outboxは削除しない。
4. v5 scan → enqueue → flushを実行し、BugHubのcurrent viewと履歴を確認する。v6 payloadをv5へ再送・変換しない。

v6へ復帰する時はconfigの`reporting.endpoint`を`/api/factory/v6/reports`へ戻し、`factory-reporter-scheduler install --wire-major v6 --dry-run --platform <OS>`を確認後、H承認済みの`--apply`でv6 schedulerを登録する。最初のfull snapshotは固定14製品集合として送信する。serverのv6 flagを戻す必要がある場合は、先に全hostをv5へ戻して受理を確認し、退避した`.env`からflagだけを復元する。どちらのrollbackでも履歴・issue・releaseを削除しない。

## 4b. 旧wire v7と完了済み段階cutover

peertable編入に伴うwire v7は、§4aと同じserver-first順序で2026-08-10に移行を完了した。当時の必須集合は固定14製品（observerキーなし）。契約は[wire v7設計](wire-v7-design.md)、承認記録は[H承認記録](evidence/2026-08-10-peertable-wire-v7-H-approval.md)が正。

**v7完了時のhost別状態（2026-08-10）**: 全4現役host（mac-kite・main-server・fox-wsl・windows-workstation）がv7へcutover済み。各hostにv6退避config（`*.bak-v6-<timestamp>`）とv6 state/outboxが残っており、rollbackは§4a同様に即応できる。

host別cutoverの順序（全4現役hostで実測済みの形）:

1. **対象端末で`./install.sh`を再実行する**。v7 binのsymlinkが`~/.local/bin`へ無いと実行できない（2026-08-10実被弾）。同日修理済みの`scheduler install --apply`はrunner binが解決できない時`runner_unresolved`のtyped errorで登録前に拒否するので、このerrorが出たら`./install.sh`を再実行してから`--apply`し直す。
2. host configを`factory-reporter.json.bak-v6-<timestamp>`へ退避する。
3. `reporting.endpoint`を`/api/factory/v7/reports`へ変更する。
4. `factory-reporter-scheduler install --wire-major v7 --dry-run --platform <OS>`でartifactを確認し、H承認後に`--apply`する。**v6 state/outbox（`~/.local/state/dotagents/factory-reporter-v6/`）は削除しない**——rollback即再開の前提になる。
5. scan → enqueue → flushを1回手動実行し、BugHubのcurrent viewで対象hostの14製品が`contract_version 7.0`で反映されることを確認する。`products.observer`が無いことを確認する。

v6へ戻す時は退避configを書き戻し、`--wire-major v6`で再installする（state/outboxが無傷なら即再開できる。v6経路のpayloadは`schema_version="6.0"`・endpoint `/api/factory/v6/reports`のまま変えない）。§4aと同じく、全hostを一括切替しない。

## 4c. wire v8とunaiの編入記録

unai編入のwire v8は、v7 endpointを維持したままserver-firstで配備した。編入時の必須集合は固定15製品で、契約は[wire v8設計](wire-v8-design.md)が正である。現在の入口は[工場の現行状態](factory-current-state.md)から読む。

host別cutoverは次の順序で行う。

1. ServerManagerで`FACTORY_V8_INGEST_ENABLED=true`を有効化し、v8 endpointが認証境界まで到達し、v7 endpointが不変であることを確認する。
2. 対象端末で`./install.sh`を再実行し、v8 binと共通指示を各host面へ配る。公式unai installerを実行し、`unai factory-diagnostics --json`がreadyであることを確認する。
3. host configを`*.bak-v7-<timestamp>`へ退避し、endpointを`/api/factory/v8/reports`へ変更する。
4. `factory-reporter-scheduler install --wire-major v8 --dry-run --platform <OS>`を確認後、`--apply`で登録する。v7 state/outboxは削除しない。
5. scan → enqueue → flushを1回実行し、BugHub current viewで15製品、`contract_version 8.0`、unai installed/compatibleを確認する。

rollbackはhost単位で退避configを戻し、schedulerを`--wire-major v7`へ再登録する。v8 reportをv7へ変換しない。

## 5. rotation

既定24時間は旧tokenも有効にし、新tokenの配置成功後に切り替える。

```bash
ssh main-server 'cd /home/kite/bughub && docker compose exec -T bughub node src/factory-admin.js rotate --host-id mac-kite --grace-hours 24 --token-output /app/data/credentials/mac-kite.next.token'
```

新tokenを対象hostの一時fileへ転送し、`0600` / ACLを確認してからcredential fileへatomic renameする。送信成功を確認後、server staging fileを削除する。旧tokenの即時無効化が必要なら、発行時に記録した旧`credential_id`を使う。

```bash
ssh main-server 'cd /home/kite/bughub && docker compose exec -T bughub node src/factory-admin.js revoke --credential-id <旧credential_id>'
```

## 6. 紛失・停止・rollback

- credentialだけを止める: `factory-admin.js revoke --credential-id <id>`。
- host全体を廃止する: `factory-admin.js retire-host --host-id <host>`。active credentialを同時にrevokeする。
- reporter送信だけを止める: configの`reporting.enabled=false`。既存outboxは削除しない。
- v6だけをrollbackする: 全hostをv5へ戻した後、`FACTORY_V6_INGEST_ENABLED=false`にしてdry-run後に再deployする。schema v6対応codeとv5入口、共有履歴viewは継続する。
- factory入口を全停止する: 全wireのingest flagをfalseにして再deployする。host schedulerを先に停止し、outboxを保持する。
- token漏洩時はrotation猶予を使わず旧credentialを即revokeし、server staging・対象host tokenを置換する。

秘密を含むfileの削除・転送、`.env`変更、factory入口ON、本番deployは端末ごとのH確認を伴う。通常のinstall/updateがこれらを暗黙に実行してはならない。

## 7. 日常の正規実行順序

scan、preview、enqueue、flushは別操作である。`reporting.enabled=false`のままでもscan/previewは実行でき、いずれもnetwork I/Oを行わない。

```bash
# 1. read-only scan。outputはcredential/outboxと別の所有者限定pathへ置く。
umask 077
factory-scan-v8 --config ~/.config/dotagents/factory-reporter.json \
  --output ~/.local/state/dotagents/factory-reporter-v8/latest-report.json \
  --ack-output ~/.local/state/dotagents/factory-reporter-v8/latest-acks.json

# 2. 送らずにschema・host identity・privacyを確認する。
factory-reporter-v8 preview \
  --config ~/.config/dotagents/factory-reporter.json \
  --report ~/.local/state/dotagents/factory-reporter-v8/latest-report.json

# 3. 明示ON済みの時だけoutboxへ保存する。OFFなら成功終了でもenqueued=false。
factory-reporter-v8 enqueue \
  --config ~/.config/dotagents/factory-reporter.json \
  --report ~/.local/state/dotagents/factory-reporter-v8/latest-report.json \
  --ack-metadata ~/.local/state/dotagents/factory-reporter-v8/latest-acks.json

# 4. 明示ON済みの時だけnetwork送信。accepted確認後だけoutboxから削除する。
factory-reporter-v8 flush --config ~/.config/dotagents/factory-reporter.json
```

`preview`は常にnetworkゼロである。`enqueue`と`flush`はOFFならnetworkゼロで、既存outboxを消さない。v8 ACKはBugHub accepted後だけ公開ACK entryへ実行する。tokenの存在、scheduler、過去のON状態は送信許可にならない。

### Pi5 external outage event

Pi5の監視がServerManager outageを検知したら、**main-server上**で次の固定イベントを記録する（Pi5から実行する運搬経路は運用側が所有し、dotagentsは新しいschedulerやSSH鍵を作らない）。時刻はUTCミリ秒表記だけを受け付ける。

```bash
factory-external-event open --check availability --reason unreachable \
  --observed-at 2026-07-13T00:00:00.000Z --json

# 回復確認後。同じfingerprintのopenが必要で、openより前の時刻では解決できない。
factory-external-event resolve --check availability --reason unreachable \
  --observed-at 2026-07-13T00:01:00.000Z --json
```

このPi5 external eventのstateはPOSIXで`~/.local/state/dotagents/factory-reporter/`（directory `0700`、file/lock `0600`）にあり、symlink・schema改ざん・同時書込みを拒否する。これは固定external eventの互換stateであり、通常の現役reporter outboxは`factory-reporter-v8/`を使う。open/resolveは冪等でappend-only sequenceを持ち、同一fingerprintはopen phaseをBugHubが受理してackするまでresolve phaseを送らない。`snapshot --json`と`status --json`は運用確認専用、`ack --cursor N --json`はreporterだけがBugHub accepted後に実行する。reporting OFFまたはack失敗時もstateは保持される。

### exitと出力の扱い

- `factory-scan-v8`非0: config/profile、dotagents revision、report schema、atomic outputのいずれかに失敗した。outputの成功扱い・enqueueはしない。個別製品CLIの不在・非対応はreport全体を偽成功/失敗へ丸めず、その製品を`unverified`として残す。
- `factory-reporter-v8`非0: stdoutの`{ok:false,code:"FACTORY_REPORTER_V8_ERROR"}`とstderrを確認する。409/413/422はdead-letter、401/403/429/5xx/timeout/network/backoffはoutbox保持であり、いずれも成功ではない。
- stdout JSONは機械判定用で、token本文を出さない。report JSONには秘密・prompt・absolute pathを入れない。
- config、credential、wire別state/outbox、scan outputは0700 directory/0600 fileにする。Windows nativeではstate root、outbox/dead-letter/retry/lock、生成fileの継承を遮断し、現在SIDだけにFullControlを許可する。ACL設定失敗は非0であり、pathや秘密を成功JSONへ出さない。reportを共有・git add・チャット貼付けしない。

## 8. 定期scheduler（dry-runから開始）

`factory-reporter-scheduler` は毎時17分に起動するOS別schedulerを管理する。本番登録では[工場の現行状態](factory-current-state.md)のmajorを`--wire-major v<N>`へ明示し、同じmajorのschedule runnerとstateを使う。引数省略時のv4は既存利用者向け互換であり、新規登録には使わない。手動rollback時だけ旧majorを指定する。runnerは該当wireの契約に従ってscan → enqueue → flush を行い、設定を作成・変更せず、`collection.enabled`／`reporting.enabled`をONにしない。送信OFFならrunnerのenqueue/flushはnetwork I/Oをしない。

最初は必ずdry-runで生成物・登録commandを確認する。実登録は明示`--apply`だけであり、通常のinstall/updateはschedulerを登録しない。configが未配置または不正ならinstall/runnerはfail closedで、scheduler登録もscanも行わない。停止のためのuninstallだけはconfigなしでも実行できる。

```bash
# macOS
factory-reporter-scheduler install --dry-run --platform darwin --wire-major v<N>
# Linux / WSL2
factory-reporter-scheduler install --dry-run --platform linux --wire-major v<N>
# Windows native PowerShell
factory-reporter-scheduler install --dry-run --platform win32 --wire-major v<N>
```

承認済みの対象hostだけで、dry-runの出力を確認してから同じcommandに`--apply`を付ける。`--apply`は実行中OSと一致するplatformだけを受け付ける。uninstallは登録済みの共通launchd label / cron marker / Task Scheduler名を外すためwire-major非依存である。

- macOS: `~/Library/LaunchAgents/com.kite.factory-reporter.plist`を`launchctl bootstrap gui/$UID`で登録する。`node`の絶対path → 選択wireのrunnerをXML escapeした引数配列で起動する。runner state/logはwireごとのstateで0700、control artifactはmajor非依存である。
- Linux / WSL2: 現在userのcrontabに`# dotagents-factory-reporter`で終わる**完全一致の自管理行だけ**を置換する。cron最小環境でもNodeとrunnerの絶対pathをPOSIX single-quoteして起動する。control artifactは`factory-reporter-scheduler/`配下でmajor非依存、runner state/outboxは削除しない。WSL2ではcron service自体を別途常設する。
- Windows native: `%LOCALAPPDATA%\dotagents\factory-reporter-scheduler\scheduler\dotagents-factory-reporter.xml`をUTF-16LE BOMで生成し、毎時のTaskを`schtasks.exe /Create /TN dotagents-factory-reporter /XML <file> /F`で登録する。control artifactはmajor非依存で、runner state/outboxは削除しない。apply時は継承・既存明示ACEを外し、現在userのSIDだけを許可するprivate ACLをPowerShell/.NETの`Access`面だけで設定する。

停止はoutboxを消さずschedulerだけ外す。`factory-reporter-scheduler uninstall --dry-run --platform <OS>`で対象commandを確認し、承認後に`--apply`を付ける。

## 9. agents-updateとの接続

`agents-update`はcurated package、MarkItDown、unaiの更新をすべて試した後、host configのendpointが指すwire majorの`factory-reporter-vN-schedule-runner --config <host config>`を必ず1回呼ぶ。現役4 hostではv8 runnerになる。MarkItDownは`uv tool`、unaiは公式installerだけで更新する。runnerが担う順序は該当wireのscan → enqueue → flushであり、更新途中の失敗でもreporter呼び出しを省略しない。

常設更新の正規入口はhost別一撃展開が所有する。

- macOS: `setup-macos-factory.sh`がLaunchAgent `com.kite.agents-update`を毎週月曜04:00で登録し、初回実行中に全15製品とfresh v8 deliveryを検証する。
- Linux: `setup-linux-factory.sh`が`setup-linux-factory --scheduled-update`を毎日02:00の専用cronへ登録する。server profile、ServerManager local readiness/revision、全15製品とfresh v8 deliveryを検証する。他hostの`factory_ingest`鮮度はBugHub集約監視が所有し、main-server展開を阻害しない。
- WSL2: `setup-wsl-factory.sh`が`setup-wsl-factory --scheduled-update`を毎日02:00のcronへ登録する。scheduled runはbatch token、全15製品、同一tokenのdelivery receiptを検証する。
- Windows native: `setup-windows-native-factory.ps1`が`agents-update-scheduler`を通じて`dotagents-agents-update`を毎日02:00に登録する。初回は登録した実Taskを起動してdelivery receiptまで確認する。WSL2側のcronで代用せず、WSL／Docker／仮想化の状態をWindows native reportの前提・証拠にしない。

Windows nativeの常設更新は`agents-update-scheduler`が所有する。`install|status|uninstall`はdry-run既定で、専用task `dotagents-agents-update`、現在SIDの`UserId`と`InteractiveToken`を組にしたUTF-16LE BOM XML、locale非依存の`Get-ScheduledTask`照会、Create後の読み戻し、runner preflight、DACL `Access`だけのowner-only ACLを使う。`--apply`とTask手動起動はH承認が必要である。scheduled runnerは実行ごとに新しいbatch tokenを発行して`agents-update`へ渡し、終了codeだけでなく、BugHub accepted後にv8 runnerが原子的に保存した同一report_id・同一tokenのdelivery receiptを確認する。runtime-error acknowledgement metadataはdelivery証拠に使わない。rollbackはtaskだけを`uninstall --apply`で外し、report/outboxを削除しない。
Taskのactionは公式PowerShell 7を直接起動し、Git Bashが必要な子処理もGit for Windowsのnative executableへ限定する。`wsl.exe`やWSL側credential／receiptへfallbackしない。

- 既定configはPOSIXで`~/.config/dotagents/factory-reporter.json`、Windows nativeで`%LOCALAPPDATA%\dotagents\factory-reporter\config.json`。
- `collection.enabled=false`ならrunnerがscan前に正常skipする。`reporting.enabled=false`ならenqueue/flushはnetworkへ出ない。
- config欠落・runner欠落・scan/report失敗はreport失敗としてログに残す。更新成功をreport成功で代用せず、report成功を更新成功で代用しない。
- 最終行直前の`agents-update result: update=<success|failed> report=<success|failed>`で両系統を判定でき、どちらかが`failed`なら終了codeは1。
- 試験時だけ`FACTORY_REPORTER_RUNNER`と`FACTORY_REPORTER_CONFIG`で入口を差し替えられる。通常運用でこのoverrideを使わない。

Claude Code、Codex、Grok Build は更新ごとにowner-onlyのtoolchain ledgerへ `before`、`latest`、`operation`、`after`、`post_gate`、`reason`、UTC観測時刻を記録する。Claude/Codexはnpm registryのsemverと`npm install -g @latest`、Grokは`grok update --check --json`とstable updateを正規入力とする。解決されたpost-update runnerが失敗すれば全3製品の`post_gate=failed`となり、更新自体の成功を全体成功へ丸めない。

この接続はschedulerを新規登録せず、configを作成・変更せず、collection/reportingをONにしない。実hostへのconfig・credential配置とON操作は前節までのH手順で別途行う。

### 現役wireのcomponent healthとpost-update gate

`agents-update`のpost-update gateが使うrunnerは、hostの実configの`reporting.endpoint`が指すwire majorから
解決される（2026-08-10修理済み。env `FACTORY_REPORTER_RUNNER`の明示が最優先、endpointが読めない時は現役v8 runnerを選び、runner側でconfig欠落を明示失敗にする）。
host別段階cutover中でも、cutover済みhostは自動でそのmajorのrunnerがgateを回す。

現役v8 reportは各製品のnative diagnosticsを単一の`native_diagnostics`へ縮約しない。各componentの`pass` / `fail` / `unverified` / `skipped`とreasonをそのまま送る。通常定期実行はscan → enqueue → flushの成否だけでexitを決め、component healthの判定はraw reportとBugHubのhost matrixに委譲する。

`--post-update` だけは default-deny gate を適用する。`fail` は常時 blocking、`unverified` は次の完全一致 tuple だけ non-blocking とする: Spotter `codex_hooks/trust_not_machine_verifiable`、Throughline `evidence_restore_smoke/diagnostic_unverified` と `claude_connector/diagnostic_unverified`、aiterm-mcp `pty_list/pty_list_unverified`、claude-code / codex-cli `last_update/post_gate_failed`（前回gate失敗の残響。実際の更新失敗は`operation_status=failed`→failでblockingのまま）、gpt-connector `cdp/chrome_idle`と`official_origin`・`auth`・`runtime_bridge`の`cdp_not_inspected`（専用Chrome未起動＝on-demand設計のidle平常状態。0.4.12+のchrome_idle意味論）。未知の check、reason 違い、別 product は blocking である。`post_gate_pending` の既存例外は維持する。

更新自体は成功しgateだけ失敗したtoolchainの`last_update`は、failでなく`unverified: post_gate_failed`として報告する（2026-08-10修理。gate失敗が全toolchainのfailとして増幅・残響し、根本3件が9件fail表示になる実測を受けた）。

現 ServerManager は fail を中心に issue 化するため、critical な `unverified` が直ちに通知されない限界がある。reporter は通知のために `unverified` を `fail` へ変換しない。

## 10. 定常実行値

定常値は次で固定する。変更時はscheduler生成fixture、runner/adapterのtimeout fixture、ServerManagerの通知fixture、本文を同じwaveで更新する。

| 項目 | 固定値 | 失敗時 |
|---|---|---|
| 定期scan | 全hostで毎時17分 | 次回へ黙って持ち越さず、そのrunを非0・local logへ残す。outboxは保持 |
| post-update gate | `agents-update`の全更新試行後に毎回1回。更新失敗時も実行 | update/reportを別々に失敗記録し、どちらか失敗ならjob非0 |
| 通常製品command | 1 command 5秒、stdout+stderr 64KiB | 固定`timeout`/`output_limit`へ写像し、生出力を送らない |
| runtime error snapshot | 1製品3秒 | scan全体を偽greenにせず、adapter failureとして非0 |
| BugHub外部probe | 外側7秒、内部HTTP 5秒 | `availability:unreachable`等の固定checkへ写像 |
| BugHub送信 | 1 HTTP attempt 10秒 | 同じbody bytesをoutboxへ保持し、次runで再送 |
| BugHub即時通知cooldown | 既定6時間。`COOLDOWN_HOURS`をHで明示する場合だけ1〜168時間の整数 | 同一fingerprint・同一severityを成功送信後に抑止。severity上昇は抑止せず、送信false/例外はcooldownを開始しない |
| Pi5外部通知 | 既存の監視抑止に入る時は未trigger観測窓だけを切り、Layer監視と別の固定60秒tickerで抑止解除後2回連続failureを観測して初回通知を試行 | 通常約120秒。trigger済みeventは抑止中も保持する。配送時刻は保証せず、Discord HTTP timeout後もevent stateを保持してDiscordとBugHubを別々に再試行。時限cooldownで消さない |

runner全体へ別の強制timeoutは重ねない。各外部境界を上表でboundedにし、single-flight lockで重複runを拒否する。環境変数は表で明示した`COOLDOWN_HOURS`以外を暗黙の値変更手段にせず、変更はcode・fixture・runbookの明示改訂として行う。`COOLDOWN_HOURS`の変更も`.env`のH操作として記録し、範囲外は起動時にfail closedする。

## 11. BugHub wire schema major互換matrix

通常経路のschema・endpoint・rollback先は[工場の現行状態](factory-current-state.md)から読む。payloadは`report_mode="full"`である。旧majorのcommand/state/endpointは手動rollbackとretention対象であり、未知major/minor、未知field、deltaを推測・黙示変換しない。

| client | server入口 | 結果 | rollout可否 |
|---|---|---|---|
| v8 | v8 endpoint | v8 schema/semantic fixtureとcredential契約がgreenの時だけ受理 | v8 cutover完了時の本番 |
| v7 | v7 endpoint | v7契約のまま受理 | host別rollback時だけ |
| v6 | v6 endpoint | v6契約のまま受理 | v7からの二段目rollback時だけ |
| v5 | v5 endpoint | v5契約のまま受理 | v6からの二段目rollback時だけ |
| v8 payload | v7 endpoint | `422`、clientはdead-letter。v7へ自動downgradeしない | 本番送信禁止 |
| v7 payload | v8 endpoint | 明示reject。v8へ自動upgradeしない | v8 cutover中の送信禁止 |
| v1 / v4 | 対応する旧endpoint | 履歴・既存outbox保持用。新規登録しない | retentionだけ |
| 未知major | 任意の既知endpoint | 明示reject。fallback、field削除、再serializeをしない | 不可 |

major変更は既存endpointの意味を差し替えず、新endpointとschemaを追加する。順序は次で固定する。

1. ServerManagerへ旧majorを保持したまま新endpoint、validator、dedupe、notification、rollback fixtureを追加し、新major flagをOFFでdeployする。
2. `/readyz`と旧major report受理を確認後、新major flagをONにしてcanaryを通す。履歴tableを削除しない。
3. dotagentsへmajor別client/outboxを追加し、失敗を別majorの成功へ偽装しない。新規runner binを追加したら、schedulerの`install --apply`より前に`./install.sh`を再実行してグローバル`~/.local/bin/`へsymlinkを配る（怠ると`launchctl kickstart`等が`Cannot find module`で落ちる。実被弾: v7 canary cutover時に`factory-reporter-v7-schedule-runner`のsymlinkが無くkickstart失敗）。
4. 1 hostずつHでdual-run、rollback、再cutoverを実測し、current・履歴・resolve/reopen・通知・`/ai`の意味を照合する。
5. 全host移行、旧outbox drain、最大offline/dedupe保持期間、rollback drill完了後にだけ旧major retireを別waveで承認する。

後方互換なoptional field追加でもschemaは`additionalProperties:false`なのでserverを先に更新し、旧client fixtureを保持する。config schema、製品native diagnostics schema、BugHub readiness schemaはwire majorとは別契約であり、同時にまとめてversionを上げない。
