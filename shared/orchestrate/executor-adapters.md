# Executor Adapter Optional Interface Catalog

`lib/orchestrate/executor-adapters.mjs` は、Executorを共通の一枚岩lifecycleへ押し込まないための、
versionedかつ純粋なcatalogである。schemaは`dotagents.executor-adapter.v1`で、descriptorは
`adapter_id / contract_version / lane / interfaces / restrictions`だけを持つ。

## 所有境界

- catalogとlookupはdescriptorを検証・解決するだけで、filesystem、process、network、MCP、host toolを
  実行しない。
- `codex-native`の`spawn_agent`、`followup_task`、`interrupt_agent`はparent host toolであり、Node CLIが
  実行するinterfaceではない。
- adapter製品はsession/job/credential/retry/cancelの正本を所有する。Control Recordはopaque handleと観測を
  相関するだけである。

## Optional interfaces

各interfaceは製品固有のoperation集合を持つ。全adapterに必須のoperationやlifecycleは存在しない。

| Adapter | Lane | Interface | Operations |
| --- | --- | --- | --- |
| `codex-sidecar@v1` | worker | `durable-work` | start、result、cancel、read-only recovery inspection、明示確認付きquarantine |
| `codex-native@v1` | worker | `native-agent` | `spawn_agent`, `followup_task`, `interrupt_agent` |
| `aiterm@v1` | worker | `interactive-session` | `codex_agent`, `grok_agent`, `composer_agent`, `pty_read`, `pty_send`, `pty_key`, `pty_close`, `pty_list` |
| `claude-native@v1` | worker | `headless-session` | `start`, `resume` |
| `claude-native@consult-v1` | consultation | `consultation-session` | `start`, `resume` |
| `codex-sidecar@consult-v1` | consultation | `consultation-opinion` | `consult`（`codex_opinion`） |
| `gpt-connector@v1` | consultation | `consultation-job` | `consult`, `sessions` |
| `claude-internal@v1` | host-projection | `appendix-projection` | observation projection only |

`gpt-connector`はWorker laneへ登録できない。catalogの一意キーは`adapter_id×contract_version`であり、
consultation laneは同一adapter_idの**別contract entry**（`consult-v1`）として追加する（ADR 0045）。
`consult-`で始まるcontract_versionのdescriptorは`lane="consultation"`必須で、Worker laneへの登録は
`LANE_FORBIDDEN`でfail closedにする。`claude-internal`はCodexからdispatchできるinterfaceを持たず、
appendix由来の観測projectionだけを表す。未知adapter/interface/operationはtyped errorでfail closedにする。
sidecar recoveryは同じ`codex_work_recover` toolでも、既定のread-only inspectionと
`confirmNoRunningProcesses=true`を要するquarantine mutationを別operationとして扱う。

CodexのA配置は、親とtightに結合した作業では`codex-native`を既定にする。隔離worktree、durable work、
harness固有機能、独立capacityのいずれかが必要かつ適合する時だけ`codex-sidecar`または`aiterm`を選ぶ。
これは親のdispatch裁定であり、catalogやCLIが自動admission・自動dispatchすることはない。

## Adapter契約の追加・廃止とrollback

adapterの追加、廃止、またはcontract versionの切替では、まず新規admissionを止める。activeまたは`unknown`の
handleが残る間は、そのhandleを検証・観測・回収するvalidatorを維持し、`unknown`を別terminal stateへ暗黙変換しない。
全handleが正規入口でterminalまたは明示的なoperator裁定になってから、旧validatorと旧adapterを廃止する。

fixtureだけの追加・削除は、実adapterのmanifest schema migrationを意味しない。manifest schemaを変える時だけ、
versioned contract、validator、migration、互換fixture、rollback手順を同じwaveで明示する。

## Codex Sidecar durable work projection

`codexSidecarStartRequest`、`codexSidecarResultRequest`、`codexSidecarCancelRequest`、
`codexSidecarRecoveryInspectionRequest`、`codexSidecarQuarantineRequest`は、host tool invocation
requestを返す純粋関数である。start requestはsource workspaceを`projectRoot`へ渡し、
caller固定の22〜128文字base64urlまたはUUIDの`idempotencyKey`、commit SHAの`baseRef`、
Task scope由来の`allowedPaths / denyPaths`、`allowWork=true`、`preserveWorktree=true`を必須にする。
sidecar固有のstructured resultを架空のWorker Report schemaで上書きせず、親がterminal projectionと
Controlのstrict Worker Report importを相関する。これらの関数はMCPを呼ばず、Control Recordの
worktree bindも行わない。result／cancel／recoverは製品契約どおり毎回
`projectRoot + idempotencyKey`で同じdurable Runを参照する。

`projectCodexSidecarObservation`はboundedなprovider observationをControlに渡せる形へ投影する。
caller所有のidempotency keyと、実provider unionの`run_handle`、`run_pending`、`run_terminal`、
`run_interrupted`、`run_error`を相関し、run ID、terminal worktree path、changed files、canonical result
digestだけをbounded projectionへ残す。`interrupted / orphaned / run_error`は`unknown`、resultの
`partial / failed / refused / dry-run`は`failed`であり、`completed`へ昇格しない。成功は
`run_terminal.state=completed`、`result.status=ok`、`worktreePreserved=true`、worktree path有りを
すべて必須とする。recoverはactionを省略したread-only inspection、quarantineは
`action=quarantine`と明示`confirmNoRunningProcesses=true`を別requestとして要求する。

成功terminalのsidecar projectionは、Control bind用の`workspace_binding_candidate`も返す。これは
`executor_handle / provider_run_id / worktree_path / observed_state=completed / result_digest`だけを持ち、
raw run directoryやprovider logを複製しない。

cancelとrecoveryの戻り値はresult unionへ混ぜない。`projectCodexSidecarCancelObservation`は実際の
`run_cancel_ack`を検証するが、`accepted`や`terminal=true`だけでRunを`cancelled`へ確定せず、同一Runの
result再観測が必要な`unknown`として残す。`projectCodexSidecarRecoveryObservation`は実際の
`work_recovery_inspection`と内包されたstatusのrun ID一致を検証し、`runDirectory`は保存せずoutcomeと
quarantine publicationだけを残す。

## Codex native host-tool packet / projection

`codexNativeSpawnRequest`、`codexNativeFollowupRequest`、`codexNativeInterruptRequest`は、parentが
host toolへ渡す invocation packet を返す純粋関数である。Node CLIは`spawn_agent`、`followup_task`、
`interrupt_agent`を呼ばない。`gpt-connector`やaitermなど別laneへ変換することもない。

spawn packetは`agent_type`を必須にし、`fork_turns="none"`と固定のhandshake-only messageを使う。
このmessageは本作業を含めず、agent path・role認識・待機可否の報告だけを求める。followup packetは
既存の`agent_path`とtaskだけを渡すが、その生成前に`verify-codex-agent-routing`が発行したgreen receiptを
要求する。receiptは`agent_path / agent_role / model / effort / developer_instructions=applied / verified_at /
verification_ref`を持ち、そのcanonical payloadを`verification_digest`が拘束する。follow-up対象はreceiptの
`agent_path`と一致しなければならない。host tool引数は
実schemaどおり`target`へ同じpathを渡す。interrupt packetも既存の`agent_path`を`target`にする。
このhandshakeとreceiptはControl配下の書込みWorkerだけの契約であり、通常のnative audit・refuter・
sorterへ事前gateとして適用しない。

`projectCodexNativeObservation`はagent path、状態（`created`、`running`、`completed`、`failed`、`unknown`、
`interrupted`）、green routing receipt、report参照、evidence参照だけをboundedに投影する。Controlへ渡す
handleは`{agent_path}`であり、Controlの`codex-native.agent-path.v1`と同じshapeである。raw prompt、
raw log、shell commandやhost tool実行結果の任意payloadはschema外として拒否する。`completed`は空でない
strict Worker Report参照を要求し、`buildWorkerControlObservation`はcaller提供resultによる直接成功化を
`WORKER_REPORT_IMPORT_REQUIRED`で拒否する。成功の記録は後続のstrict Worker Report importだけが行う。

## aiterm interactive-session packet / projection

配布済みaitermの一次source（`dist/index.js`）に従い、`aitermAgentStartRequest`は
`codex_agent`、`grok_agent`、`composer_agent`の実schemaへ、prompt、`cwd`、`session_name`、model、
`reasoning_effort`を投影する。managed completionはlauncherが常時有効化するため、存在しない`agent_done`
tool引数を生成しない。対応modelとeffortはAitermが起動時のlive catalogへ照合し、
不在・非対応を別modelへfallbackせず明示エラーにする。起動後のopaque handleはControl契約と同じ
`session_id / agent_kind`だけで相関し、`workspace_cwd`はlaunch observationのmetadataとして分離する。
別sessionへfollow-upしない。

`aitermFollowupRequest`は同じhandleの`session_id`へ`pty_send`を作り、`wait="agent_done"`、
`enter=true`、`screen=true`、`raw=false`を固定する。timeout後の`aitermTimeoutRecoveryRequest`は同じ
sessionの`pty_read(screen=true, wait=false)`を返すだけで、timeoutをfailedやcompletedへ昇格しない。
`aitermKeyRequest`、`aitermCloseRequest`、`aitermListRequest`も同様に純粋なrequestである。

`projectAitermLaunchObservation`はsession作成を`running`としてだけ表し、agent起動・batch exit status・
terminal成功を捏造しない。`projectAitermObservation`はhandle、`running / completed / failed / unknown /
interrupted`、report/evidence参照だけをboundedに保持する。`completed`は空でないstrict Worker Reportの
`report_ref`と、aiterm正規入口でterminalを確認したprovider由来evidence参照を1件以上必須とする。
ただしこのprojectionやcaller提供の任意`result`だけではControlの成功を確定しない。
`buildWorkerControlObservation`はaitermの`completed`を`WORKER_REPORT_IMPORT_REQUIRED`で拒否し、
後続のstrict Worker Report importだけが成功を記録する。raw terminal、log、secret、任意のhost resultは
schema外として拒否する。adapterはPTY/MCPを実行せず、aitermが保証しないread-only強制やworktree隔離も
主張しない。

## Claude native headless-session packet / projection

`claudeNativeStartRequest`と`claudeNativeResumeRequest`は、親が自ら`claude` CLIをheadlessで起動する
ためのinvocation packetを返す純粋関数である（transport `pty`）。processの生成、stdin投入、timeout、
terminal回収は親が所有し、adapterはfilesystem・process・networkを実行しない。startはcaller生成の
lowercase UUIDを`--session-id`へ、resumeは同じUUIDを`--resume`へ渡し、start/resumeを通して同一session
IDだけを使う。隔離workspaceの絶対path、明示model、明示effort（`low|medium|high|xhigh|max`）、明示tool
policyを必須とし、暗黙既定を作らない。

tool policyは`permission_mode="dontAsk"`固定で、`tools`は承認済みbuilt-in Worker tool
（`Read / Glob / Grep / Bash / Edit / Write / NotebookEdit`）だけ、`allowed_tools`は`tools`で選択済みの
tool名（引数指定形を含む）に束縛される。生成argvは`--print --verbose --output-format stream-json
--input-format text`と`--disable-slash-commands --no-chrome`を固定し、`--continue`、`--fallback-model`、
`--bare`、`--safe-mode`、`--no-session-persistence`を生成しない。Claude Code 2.1.211の`--bare`は
OAuth／keychainを読まずAPI key経路だけを使うため、subscription route（OAuth）へ使わない。
`--safe-mode`はproject正典とhookを無効化するため暗黙既定にしない。adapterはcredentialを読まず、
親が所有する既存Claude CLI環境を変更しない。

`projectClaudeNativeObservation`はhandle、`running / unknown / completed / failed`、exit code、signal、
report/evidence参照だけをboundedに投影する。`completed`は`exit_code=0`かつ空でないstrict Worker Report
参照とevidence参照1件以上、`failed`は非成功のterminal receipt（非0 exitまたはsignal）を必須とし、
非terminalへterminal fieldを混ぜない。caller timeoutは`projectClaudeNativeTimeoutObservation`で
`state="unknown"`／`raw_status="caller_timeout"`として保持し、成功・失敗へ丸めない。同じsession IDの
process状態を回収してからresume可否を決め、別sessionや別providerへの切替は元Runのterminal Decision後に
新Runとして記録する。`buildWorkerControlObservation`はcompleted projectionとcaller提供resultだけの
成功確定を`WORKER_REPORT_IMPORT_REQUIRED`で拒否し、成功の記録は後続のstrict Worker Report importだけが
行う。`claude-internal`はhost projection専用のまま維持し、このadapterへ昇格させない。

## gpt-connector consultation packet / projection

配布済み`gpt-connector`の一次source（`dist/src/contract.js`、`dist/src/mcp-server.js`）に従い、
`gptConnectorConsultRequest`はstrictな`consult` schemaへprompt、caller既知のslug、model、effort、
`keepOpen=false`、`dryRun=false`を投影する。製品schemaではmodel/effortはoptionalだが、このadapterは
オーナー契約どおり両方を必須にする。files／workspaceRootを受け付けないため、添付やworkspace読取を
暗黙に開始しない。未知slugの推測・置換、Oracle／OpenAI API／prompt再送へのfallbackは持たない。

`gptConnectorSessionsRequest`と`gptConnectorTimeoutRecoveryRequest`は、ともに同じcaller既知slugだけを
`sessions`へ渡す純粋requestである。caller timeoutは`projectGptConnectorTimeoutObservation`で`unknown`
として保持し、failedへ昇格しない。MCPの実呼出し、login、送信、添付、MCP登録をこのadapterは行わない。

`projectGptConnectorObservation`の入力は実 `ConsultSnapshot` のstrict shape、すなわち
`slug / state / createdAt / updatedAt / result / error`をそのまま検証する。成功resultは
`text / status / endTurn=true / resolvedModel / resolvedEffort / sessionId? / attachments / archived`、
failureは`code / message / retry / partialUpload?`の実shapeを要求する。成功時はresolved model／effort、
session ID、archive状態だけを残し、回答本文・attachment names・MIME typeを捨てる。失敗時もcodeとretry
だけを残し、error message、raw prompt、raw log、secretはprojectionに残さない。これはConsultationであり、
Worker capacity、実行票、worker reportには変換しない。

`queued / uploading / submitted`はControlの初回遷移に使える`dispatched`、`running`だけを`running`へ
投影する。`buildConsultationControlObservation`はこのprojectionをControl Recordが受理するexact shapeへ
変換し、completed時のDecision参照とfailed時のterminal evidenceを混同しない。

## claude-native consultation packet / projection（consult-v1）

`claudeNativeConsultStartRequest`／`claudeNativeConsultResumeRequest`はWorker laneと同じ
同一UUID start/resume契約のまま、相談専用のrequest（`dotagents.claude-native.consult-request.v1`）を
純粋に投影する。tool policyは固定で`--permission-mode dontAsk`＋`--tools ""`（全tool無効。
Claude Code 2.1.211のCLI helpに明記。`-p`＋全tool無効のlive挙動は後続live H gateで実測）とし、
`--allowedTools`を生成しない。禁止flag（`--continue`／`--fallback-model`／`--bare`／`--safe-mode`／
`--no-session-persistence`）はWorker laneと同様に生成しない。**Consultation recordはworkspace
fieldを持たないが、request builderはCLI実行のためのcwdを要求し、Controlへは複製しない**（ADR 0045）。

`projectClaudeNativeConsultObservation`は専用observation schema
（`dotagents.claude-native.consult-observation.v1`）で`consultation_handle`（同一session ID）と
状態を残す。**`completed`はstream-jsonの`type:result`受信を指す`result_receipt`（bounded string）を
必須とし、process exitだけでcompletedを作れない**（ADR 0045 §7のadapter層強制。O3 Phase監査
採用指摘）。caller timeoutは`projectClaudeNativeConsultTimeoutObservation`で`unknown`として
保持する。Worker用observation schemaとは相互に受理されない（lane逆流の遮断はControl Record bridge参照）。

## codex-sidecar consultation packet / projection（consult-v1）

`codexSidecarOpinionRequest`は配布済み`codex-sidecar-mcp`の`codex_opinion` tool契約
（`readonly: true`、required `projectRoot`、effort enum `low|medium|high|xhigh`——`max`なし）へ
prompt、model、effortを投影する。read-only性は製品側tool descriptorの`readonly: true`と、
request builderがwrite系引数（`allowWork`／`preserveWorktree`／`idempotencyKey`等）を一切
生成しないことで担保する。存在しない「catalog上のread-only capability field」を根拠にしない。
effort語彙はconnectorごとに製品契約へ束縛し、共通語彙を捏造しない。

同期consultはdurable handleを持たないため、projection（`dotagents.codex-sidecar.consult-observation.v1`）
は`consultation_handle: null`を固定し、consultation_id＋request相関で結果を照合する。
`projectCodexSidecarOpinionObservation`は`workflow="opinion"`の実result shapeを検証して
completed（`ok`）／failed（`partial|failed|refused`）へ投影し、`projectCodexSidecarOpinionErrorObservation`／
`projectCodexSidecarOpinionTimeoutObservation`がcaller観測のMCPエラー／timeoutを表す。
read-only opinionのresultに**write痕跡（非空`changedFiles`・`worktreePath`・`worktreePreserved`）が
載っていたら製品契約違反の兆候としてfail closed**にする（空の`changedFiles`だけ許容）。結果喪失時は
製品terminal状態を取得できないため、failed終端のterminal evidenceにはcaller観測の`command`または
`executor-receipt` descriptorをconnector条件付きで認める（ADR 0045 §7）。

## Claude internal appendix projection

`claude-internal`はcatalogどおり`host-projection` laneかつ`projection-only` restrictionを維持する。
`projectClaudeInternalAppendixObservation`はClaude appendix
（`claude/skills/orchestrate/SKILL.md`）由来であること、canonical ISO UTCの観測時刻、`unknown`状態、handleなし、terminalなし
だけを同じControl向けのbounded projectionへ残す。appendixはClaude親が固有入口でdispatchし、共通dispatch
APIやExecutor state複製を前提にしないことを明記しているため、request／dispatch／cancel／follow-up packet、
host tool名、capacity、execution-verified、Worker成功をこのadapterは表現しない。raw prompt、log、secretや
任意payloadはstrict schema外として拒否する。

## Adapter-specific typed failure matrix

`lookupAdapterFailureSupport`、`projectAdapterFailure`、`projectAdapterCallerTimeout`は製品固有の失敗を
共通lifecycleへ押し込まず、型付きの最小projectionだけを返す。supportは`mapped / caller-event /
unknown / not-applicable`と根拠を返す。credentialとrate limitは製品所有のままとし、秘密・account quota・
raw messageをControlへ複製しない。providerが公開していないcodeをcallerが自己申告する入口は持たない。
**キー粒度は`adapter_id×lane`**（ADR 0045）——同一adapter_idでもworker laneのdurable回収契約を
consultation laneへ返さない。lane未定義の組はcodeを捏造せず`ADAPTER_UNKNOWN`で拒否する。

| Adapter×Lane | credential-missing | rate-limited | timeout | non-zero-exit | malformed-report | workspace-missing | unsupported-capability | timeout recovery |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `codex-sidecar`×worker | mapped | unknown | mapped | unknown | mapped | unknown | mapped | 同一idempotency keyの`result` |
| `codex-sidecar`×consultation | unknown | unknown | caller-event | not-applicable | caller-event | caller-event | unknown | なし（同期consultに再照会入口なし。unknownのまま親が終端裁定） |
| `codex-native`×worker | unknown | unknown | caller-event | not-applicable | caller-event | unknown | caller-event | 確認済み再照会toolなし |
| `aiterm`×worker | unknown | unknown | caller-event | unknown | caller-event | unknown | unknown | 同一sessionの`pty_read` |
| `claude-native`×worker | unknown | unknown | caller-event | caller-event | caller-event | caller-event | caller-event | 確認済み再照会toolなし（親が同一session IDのprocess状態を回収） |
| `claude-native`×consultation | unknown | unknown | caller-event | caller-event | caller-event | not-applicable（recordはworkspaceを持たない） | caller-event | 確認済み再照会toolなし（親が同一session IDのprocess状態を回収） |
| `gpt-connector`×consultation | mapped | unknown | mapped/caller recovery | not-applicable | caller-event | not-applicable | mapped | 同一slugの`sessions` |
| `claude-internal`×host-projection | not-applicable | not-applicable | not-applicable | not-applicable | not-applicable | not-applicable | caller-event | なし |

caller timeoutはterminal failedへ丸めず、`state="unknown"`とadapter固有のrecovery operationだけを
残す。providerがterminal failureとして返した`UPLOAD_TIMEOUT`はfailedのまま保持する。既存の`codexSidecarResultRequest`、`aitermTimeoutRecoveryRequest`、
`gptConnectorTimeoutRecoveryRequest`が同一handleを実際の製品入口へ渡す。`ADAPTER_NON_ZERO_EXIT`や
`ADAPTER_RATE_LIMITED`のような架空の共通codeは受理せず、実provider codeがないfamilyは`unknown`のまま
成功も失敗も主張しない。

## Control Record bridge

`buildWorkerControlObservation`と`buildConsultationControlObservation`はadapter projectionをControl Recordの
exact observation payloadへ変換する純粋関数である。Workerは`executor_handle`を同じshapeのまま渡し、
dispatched／completed／failed・cancelledの証拠fieldを状態ごとに一つだけ要求する。sidecar completedでは
Control result digestとprovider result digestの一致も要求する。Consultationはconnector別observation
schema（gpt-connector／claude-native consult／codex-sidecar consult）をdispatchして受理し、
completedのDecision参照とfailedのterminal evidenceを分離する。bridge出力はprojectionの
`consultation_handle`を保持し、`observeConsultation`がrecordのconnector・handleとの一致を
mutation時に検証する（O3 Phase監査採用指摘）。**consultation observation schemaは
`buildWorkerControlObservation`が`PROJECTION_UNSUPPORTED`で拒否し、Worker observation schemaも
consultation側へ入らない**——consultationの結果がWorker control observationへ流入する経路を作らない
（ADR 0045）。どちらもfilesystem、network、host toolを実行しない。
