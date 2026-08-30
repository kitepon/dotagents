<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Sources: shared/orchestrate + docs/02_models.md + lib/orchestrate/lane-admission.mjs + claude/skills/orchestrate/references/workflow-templates.md -->
<!-- Regenerate: node bin/render-orchestrate-skill-references.mjs --write -->
# Orchestration Control Record v1

この文書は、[統括の共通契約](contract.md)を実行時に補助する一時Control Recordの
機械契約である。F/A/H、Role、Taskの意味、Finding、Decision、Approval、最終裁定の正本を
置き換えない。

## 所有境界

Control Recordが所有するのは、親が宣言したTask参照、Worker Run／Consultationの相関ID、
各Executorを再照会するためのopaque handle、最後に観測した状態、write予約、親の受入記録だけ。

- Taskの目的・docs計画正本（実行TODOの正本はtyped discoveryで解決）・仕様・Finding・Decisionは対象projectの`docs/`とgit履歴が正本。
- session、job、認証、cancel、retry、worktree lifecycle、migrationは各Executor製品が正本。
- H承認はオーナーとの会話が正本。approval snapshotは親が確認した承認のpurpose、impact、
  rollback、対象operation digest、有効期間への参照であり、CLIが承認の意味や真正性を
  判定したことを表さない。
- `executor_observation`は観測cacheであり、Executorの現在状態ではない。再開時はopaque handleで
  所有製品へ再照会し、親が新しい観測を記録する。
- CLIは親を認証しない。子にCLI更新をさせないことは統括契約で強制し、`actor_id`は監査用の
  attributionとする。競合更新はglobal mutation lockと`record_revision`で拒否する。

## 保存先と境界

git repositoryだけをMVP対象とする。

```text
<absolute git common dir>/dotagents/orchestrate/
├── lock-owners/
│   └── <token>.owner
└── controls/
    └── <control-id>/
        └── manifest.json
```

- common dirは`git rev-parse --path-format=absolute --git-common-dir`を実行し、`realpath`で確定する。
- main／linked worktreeは同じcommon dirを共有する。各Worker Runはさらに
  `git_dir_realpath`、`worktree_root_realpath`、予約時HEADを持つ。
- bare repositoryは`effect=read`のTaskだけを許可し、writerを拒否する。ConsultationはTaskの
  effectと独立して記録できるが、workspaceを持たない。
  declarationの`project_root_realpath`は`null`、`git_dir_realpath`と`common_dir_realpath`は
  bare repository root、unborn HEADの`base_sha`は`null`、`initial_dirty`は`false`とする。
- non-gitの暗黙fallbackは行わない。MVPでは明示エラーにする。
- state root、`controls`、control directory、manifest、lock ownerのsymlinkを拒否する。
- directoryはPOSIXで`0700`、fileは`0600`とし、read/save時にowner UIDとmodeを検証する。
  Windows owner-only ACLは未検証のため、現v1は`PLATFORM_UNVERIFIED`でfail closedにする。

### state配置とmode-fidelity probe（2026-07-17）

POSIX modeを保持・表示できないfilesystem（WSL2のmetadata無しDrvFS/9p mount等。`chmod 0700`が
成功を返すのに読み戻しが`0777`になる）では、repo内`.git`配下にowner-onlyのstateを置けない。
配置は次の規則で決める。0700/0600判定自体はどの配置でも弱めない。

- **mode-fidelity probe**: 作成時、`common dir`直下に**ランダム名の新品ディレクトリ**を
  `mkdir(0700)`→`chmod(0700)`→`lstat`読み戻し→`rmdir`して判定する。新品なら改ざんの窓が無いため、
  「capable FS上の0777＝改ざん」と「FSがmodeを表示できない」を区別できる。probeは**mode表示の
  忠実性**の証明であって、アクセス強制力の証明ではない（dmask等で0700を表示するmountは従来
  実装と同様に受け入れ、以後の異常は既存のlstat/uid/nlink検査が拾う）。
- **capable**: 従来どおり`<common dir>/dotagents/orchestrate/`。この配置での0700/0600違反は
  改ざんとして従来どおりfail closedする（probeで外部へ逃がさない）。
- **incapable**: `${XDG_STATE_HOME:-~/.local/state}/dotagents/orchestrate/repos/<key>/`へ置く。
  `<key>`は`common dir` realpathのSHA-256＝**repo identityからの決定的導出**であり、repo側に
  可変ポインタ（marker）を置かない（差し替え可能な参照自体を存在させない）。外部側にも同じ
  0700/0600判定を`orchestrate`層から下に適用し、そこでも証明できなければfail closedする。
  中間の`<XDG>/dotagents`はfactory-reporter等と同居する**共有namespace**であり、mode 0700は
  要求しない（dir実体・symlink拒否・owner一致のみ要求。in-repo配置で`.git`自体に0700を
  要求しないのと同じ構造。FOX実測: 既存namespaceは0775、各コンポーネントdirが0700）。
- **project binding**: 外部key directoryは`binding.json`（0600）に`common_dir_realpath`と
  `common_dir_file_id`（dev:ino）を保持し、アクセス時に実repoから再計算した値との**完全一致**を
  要求する。照合は**lock-owner書込みを含む一切の外部state書込みより前**に行う。不一致は
  fail closed（`STATE_PATH_UNSAFE`）。dev:inoの再起動跨ぎ安定性はWSL2実機で実測済み
  （FOX 2026-07-17、`wsl --shutdown`前後で`0:67:5348024557972214`一致）。
- **残骸と同居**: mode非忠実FS上の非空in-repo残骸は黙って無視せず、残骸pathを名指しして
  fail closedする（空の残骸だけ無視してよい）。in-repoと外部のstateが同居した場合、および
  capable FSでの新規作成時に外部stateが既存の場合は、silent orphanを作らず明示エラーにする。
  どちらを残すかは人が裁定して手動で除去する。

## Manifest

manifestは一つの統括作業を表す。許可key以外を拒否し、1 MiBを上限とする。

```json
{
  "schema_version": "dotagents.orchestration-control.v25",
  "record_revision": 0,
  "control_id": "elastic-phase1",
  "status": "active",
  "declaration": {
    "objective_ref": "docs/plan_elastic-orchestrator.md",
    "project_root_realpath": "/project",
    "common_dir_realpath": "/project/.git",
    "git_dir_realpath": "/project/.git",
    "git_dir_file_id": "16777234:12345678",
    "base_sha": "0123456789abcdef0123456789abcdef01234567",
    "initial_dirty": false,
    "initial_status_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "initial_workspace_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "created_at": "2026-07-14T00:00:00.000Z",
    "created_by": "parent-session-id"
  },
  "continuation": {
    "predecessor_control_id": null,
    "root_control_id": "elastic-phase1",
    "sequence": 0
  },
  "durability": {
    "protocol_version": "fsync-rename-fsync.v1",
    "file_sync": "required",
    "directory_sync": "required",
    "atomic_rename": "required"
  },
  "budget": {
    "max_worker_runs": 32,
    "max_consultations": 16,
    "max_external_runs": 24,
    "max_wall_time_seconds": 86400,
    "max_cost_microusd": 100000000,
    "max_runs_per_approach_family": 16,
    "max_retries_per_assignment": 3,
    "max_integration_runs": 8
  },
  "role_effect_policy": {
    "policy_version": "dotagents.role-effect.v1",
    "read_only_roles": ["refuter", "sorter", "verifier"],
    "approval_required_write_roles": ["integrator"]
  },
  "document_refs": ["docs/plan_elastic-orchestrator.md"],
  "registry_observations": [],
  "tasks": [],
  "task_cancellations": [],
  "worker_runs": [],
  "consultations": [],
  "campaigns": [],
  "phase_gate": null,
  "artifacts": [],
  "family_governance": [],
  "task_finalizations": [],
  "control_finalization": null,
  "transition_receipts": [
    {
      "revision": 0,
      "actor_id": "parent-session-id",
      "operation": "control-init",
      "subject": { "kind": "control", "id": "elastic-phase1" },
      "subject_digest": null,
      "previous_state": null,
      "next_state": "active",
      "evidence": [],
      "recorded_at": "2026-07-14T00:00:00.000Z",
      "previous_receipt_digest": null,
      "receipt_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "last_update": {
    "actor_id": "parent-session-id",
    "updated_at": "2026-07-14T00:00:00.000Z"
  }
}
```

v29 manifestは上記に加えてtop-level `lane_admission`を必須とする（ADR 0114）:

```json
  "lane_admission": {
    "contract_version": "dotagents.lane-admission.v1",
    "conditions": {
      "planned_interruption": false,
      "chained_acceptance": false,
      "multi_repo_write_coordination": false,
      "decision_evidence_required": true
    },
    "decision": { "type": "decision", "ref": "docs/adr/0114-typed-lane-admission-contract.md", "digest": "…", "observed_at": "…" },
    "declared_by": "parent-session-id",
    "declared_at": "2026-07-14T00:00:00.000Z"
  }
```

- `conditions`はADR 0061の4条件と1対1のexact booleanで、少なくとも1つがtrue（全falseはinitが
  `LANE_ADMISSION_NOT_ORCHESTRATED`で拒否し、Controlを作らない）。`lane` fieldは保存しない——
  Controlの存在自体が`orchestrated`の意味である。判断理由の自由文も保存しない——理由の正本は
  `decision`（type=decision evidence）が指すdocs側にある（ADR 0113 Decision 3）。
- `declared_by`は`declaration.created_by`と、`declared_at`は`declaration.created_at`と一致必須
  （actor無相関の宣言をvalidにしない）。`null`はv28からのmigration産だけの形で、readerは
  「migrate receiptがv29へ入っている場合だけnull可」を強制する。lane決定関数の入力は4 booleanの
  exact recordだけで、文字列を受け取らない（非classifier保証は型境界による）。

- `schema_version`は`{v25, v26, v27, v28, v29}`のclosed setをreaderが受理し、暗黙migrationしない。v2はWorkerの固定Executor文字列を
  versioned envelopeとworkflow参照へ置き換え、v3はworkflow capability snapshot、v4はBudget
  Envelope、v5はControl-level finalization、v6はH approval snapshot、v7はrole/effect policy
  snapshot、v8はbounded continuation、v9はignored/index fingerprint guard、v10はdurability
  protocol snapshot、v11はchanged fileのmode fingerprintとControl総数commit gate、v12は
  Executor Registry observation、v13はplacement reservationとsubject digest、v14はresume用の
  Control git directory generation、初期workspace digest、Worker記録時fingerprint、v15はTask取消と
  Worker cancel要求の分離、v16はparent-declared campaign gate、v17はsidecar durable workの
  遅延execution-worktree binding、v18はprovider binding相関とCodex native canonical agent path、
  v19はapproach family／assignment retry／integration Run上限をBudget、v20は明示fallback参照を
  Worker Runへ追加し、v21はmanual Worker生成identity／fallbackのreceipt digest束縛を追加し、v22は固定順の
  phase gateを追加し、v23はdocs artifactのID／digest／status projection、v24はapproach family governance、
  v25はCampaign宣言とmanual Worker lineageのreceipt束縛およびFinding共有境界を追加した。同じv1完成前の
  v25契約でTask／Control finalizationのsubject digest、文書evidence、Campaign親裁定境界をfail closedにした。
  v26はConsultationの`slug`をconnector別typed `consultation_handle`へ置換し、connectorを
  closed enumへ拡張した（ADR 0045）。v27はConsultationへ`cancelled` state（`consultation-cancel`）を、
  placement reservationへoptional keyの`selector_decision`を追加した（ADR 0054）。v28はdigest版付き
  docs artifactと単一receiptの原子的世代交代を追加した（ADR 0083）。v29はtop-levelへ
  `lane_admission`を追加した（ADR 0114）: v25〜v28はkeyの**不在**が正規形で、v29だけkeyを必須とする。
  新規initはv29で作成する。
  旧version active Controlは読取もmutationも従来契約のまま継続し、旧manifestを
  黙って書き換えない。versionの移動は明示の`control-migrate`だけが**隣接version間で**行い
  （v25→v27、v26→v28の直行なし）、mutation時の自動昇格を`SCHEMA_UPGRADE_REQUIRED`で拒否する。
  上記closed set外のversionは`INVALID_SCHEMA`で停止する。version能力の判定は単一version等値でなく
  **単調なpredicate**（当該機能を導入したversion以上）で行い、新versionを黙って旧契約へ落とさず、
  version追加が既存能力を後退させない（ADR 0114 Decision 5）。
- mutation成功ごとに`record_revision`を1増やす。全mutationは呼出側の
  `expected_revision`と現在値の一致を必須とする。
- `status`は`active | archived`。Control-level finalization後はarchive以外のmutationを拒否し、
  archived manifestは更新不可。
- `transition_receipts`はrevision 0の`control-init`から始まり、成功したmanifest mutationごとに
  1件だけ同じatomic更新へ追加する。件数は常に`record_revision + 1`である。
- `document_refs`はrepo相対参照だけ。prompt、output、secret、credential、環境変数、巨大log、
  Executor内部stateを保存しない。
- 通常repositoryでは`project_root_realpath`と`base_sha`は文字列、bareでは上記のとおり`null`を許す。
  `git_dir_file_id`はgit directoryのdevice/inode generation、`initial_status_digest`はinit時の
  porcelain v2 status bytes、`initial_workspace_digest`はHEAD、index、status、変更file内容を含む
  bounded fingerprintのSHA-256である。bareでは両digestを`null`とする。
- ID／slug／role／model／raw stateは128文字、文書・証拠参照とrepo相対pathは1024文字、
  title／reason／decision noteは4096文字、各配列は256件を上限とする。
- `control_id`、Task／Run／assignment／consultation IDはASCIIの
  `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`だけを許し、`.`と`..`単体を拒否する。path join後も
  `controls`直下の一segmentであることを検査する。lock tokenはcanonical UUIDだけを許す。

## Evidence descriptor

evidenceは参照文字列だけで流さず、次のexact objectとしてmanifestへ永続化する。

```json
{
  "type": "file",
  "ref": "evidence/run-001-result.json",
  "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "observed_at": "2026-07-14T00:00:00.000Z"
}
```

- `type`は`file | command | url | executor-receipt | decision`。
- `file | decision`の`ref`はrepo相対path、`url`は`https:` URL、その他はpromptやstdoutを含まない
  boundedなopaque referenceとする。
- `digest`は参照先または回収内容のSHA-256。内容本体、秘密、巨大logはControlへ複製しない。
- `observed_at`は親が参照を確認した時刻。descriptorの存在だけで内容十分とは判定しない。

## Transition receipt

別の`events.jsonl`を第二正本にせず、actor、operation、subject、state遷移、使用したevidenceを
同じmanifestへappend-only receiptとして保存する。

```json
{
  "revision": 4,
  "actor_id": "parent-session-id",
  "operation": "worker-observe",
  "subject": { "kind": "worker-run", "id": "R-001" },
  "subject_digest": null,
  "previous_state": "admitted",
  "next_state": "dispatched",
  "evidence": [
    {
      "type": "executor-receipt",
      "ref": "codex-sidecar:job-001",
      "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "observed_at": "2026-07-14T00:00:00.000Z"
    }
  ],
  "recorded_at": "2026-07-14T00:00:00.000Z",
  "previous_receipt_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "receipt_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

- operationは`control-init / task-record / task-cancel-record / registry-observation-record / placement-reserve / worker-run-record / consultation-record / worker-admit / worker-workspace-bind / worker-cancel-request /
  worker-report-import /
  worker-observe / consultation-observe / consultation-cancel / campaign-record / campaign-release / phase-gate-record / phase-gate-advance / worker-accept / worker-reject / task-finalize /
  control-migrate / control-finalize / control-archive`の固定集合。subject kindも固定集合で、任意event名を受理しない。
  `control-migrate`は両version（v25／v26）のreaderが受理する——rollback後のv25 manifestにも
  migrate系receiptは恒久に残るため、これを拒否すると「v25として有効」が成立しない。
  そのreceiptはsubjectがControl自身、`previous_state`／`next_state`がfrom/to schema versionである。
  readerはmigrate receiptの意味も検証する: subjectは当該Control・evidence空・両stateは
  既知schema versionかつ相異・複数receiptは連鎖（前のnextが次のprevious）・最後の
  `next_state`は現`schema_version`と一致。捏造migration履歴をdigest chainだけで有効化しない。
- `receipt_digest`は自身を除くreceiptのcanonical JSON SHA-256。revision 1以降は直前receiptのdigestを
  `previous_receipt_digest`へ持ち、read/save時に連番とchainを再計算する。過去receiptの書換え、欠落、
  並べ替えを`INVALID_SCHEMA`で拒否する。
- `subject_digest`は通常operationでは`null`。`placement-reserve`は保存した
  `placement_reservation` exact objectのcanonical JSON SHA-256を必須とし、candidate digest、Registry
  参照、評価結果、review Decision、親actor、選択時刻をcreation receiptへ結合する。manual
  `worker-run-record`も作成時のWorker／Task／assignment identityとfallback宣言をdigestへ結合し、
  fallback元RunとDecision参照を含む生成関係の妥当な値への差替えを拒否する。
  `worker-workspace-bind`はprovider binding digest、`phase-gate-record`はworkflow／risk／behavior lane
  宣言のdigestを結合する。`task-finalize`はTask finalization exact object、`control-finalize`はControl
  finalization exact objectをsubject digestへ結合し、actor、時刻、文書evidenceとの相関も検証する。
- evidenceを使わない管理mutationは空配列、dispatch／terminal／result／acceptanceはそのmutationで
  検証したtyped descriptorを保存する。内容本体は複製しない。
- failed mutationはrevisionもreceiptも増やさない。`last_update`は最後のreceiptのactor/timeと一致する。
- `recover-lock`はControl manifest mutationではなく、特定Controlを選ばないlock-owner保守操作なので
  receipt対象外。lock token、owner body、PID、file identityの検証結果がその操作の返却契約である。
- receiptは256件を上限とし、各mutationのcommit前に、全nonterminal Run／Consultationのterminal化、
  completed Workerの親Decision、未release Campaign、未完了phase gate、未finalizeかつ未cancelのTask、Control finalization、archiveに必要な最悪receipt数を
  予約する。閉鎖slotを侵食する拡張は`CONTROL_CAPACITY_RESERVED`で拒否し、古いreceiptを削除しない。
- archive済みControlだけを`predecessor_control_id`へ指定して後継Controlをinitできる。後継は同じ
  objective、root ID、単調増加sequenceを持ち、Task／Run IDは新規にする。predecessor manifestは
  chain検証とID予約のため保持し、archived IDを再利用しない。
- git common dirごとのControl manifestは256件をbounded scan上限とする。256件が存在する状態の
  新規initはcommit前に`CONTROL_CAPACITY_REACHED`で拒否し、257件目を作って既存Controlの
  global mutationを自己poisonしない。恒久retentionを拡張する場合は、ID予約とglobal conflictを
  欠落させない別schema／index契約を先に設計する。

## Executor Registry observation

Registryは各製品の正本や自動discovery engineではなく、親が確認したExecutor workflowの
期限付きread-only観測snapshotである。更新時は既存entryを書き換えず、新しい
`registry_observation_id`を発行する。IDはgit common dirの全Controlで一意とする。

```json
{
  "registry_observation_id": "registry-codex-native-001",
  "executor": {
    "adapter_id": "codex-native",
    "contract_version": "v1",
    "instance_id": "current-parent",
    "handle_schema_id": "codex-native.agent-path.v1"
  },
  "workflow_id": "native-subagent",
  "enabled": {
    "value": "true",
    "evidence": {
      "type": "command",
      "ref": "verify-codex-agent-routing refuter /root/refuter-smoke",
      "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "observed_at": "2026-07-14T00:00:00.000Z"
    }
  },
  "workflow_capabilities": [
    {
      "capability_id": "workspace.read",
      "value": "true",
      "evidence": {
        "type": "file",
        "ref": "docs/02_models.md",
        "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "observed_at": "2026-07-14T00:00:00.000Z"
      }
    }
  ],
  "capacity": {
    "admission": { "value": "true", "evidence": {
      "type": "command",
      "ref": "native routing smoke",
      "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "observed_at": "2026-07-14T00:00:00.000Z"
    } },
    "hard_inflight_limit": { "knowledge": "unknown", "value": null, "evidence": null },
    "soft_inflight_limit": { "knowledge": "known", "value": 3, "evidence": {
      "type": "file",
      "ref": "docs/02_models.md",
      "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "observed_at": "2026-07-14T00:00:00.000Z"
    } },
    "observed_inflight": { "knowledge": "known", "value": 1, "evidence": {
      "type": "command",
      "ref": "native agent list",
      "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "observed_at": "2026-07-14T00:00:00.000Z"
    } }
  },
  "verification": {
    "stage": "verified",
    "observed_version": "host-runtime",
    "observed_at": "2026-07-14T00:00:00.000Z",
    "evidence": {
      "type": "command",
      "ref": "verify-codex-agent-routing refuter /root/refuter-smoke",
      "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "observed_at": "2026-07-14T00:00:00.000Z"
    }
  },
  "expires_at": "2026-07-15T00:00:00.000Z"
}
```

- `enabled`と`capacity.admission`は`true | false | unknown`。known valueはtyped evidenceを必須とし、
  `unknown`は根拠があれば保持できるが、利用可能扱いしない。
- capacity数値は`knowledge=known | unknown`。knownは非負safe integerとevidence、unknownは
  `value=null`を必須とし、unknownの根拠evidenceは任意で保持できる。hard／soft limitのknown値は1以上、observed inflightは
  0以上とし、両limitがknownならsoftはhardを超えられない。`null`は無限を意味しない。
- `verification`はWorker Runと同じstage集合を使うが、観測時点の事実であり、製品のcredential、
  session、rate-limit stateを所有しない。全evidenceの時刻は`verification.observed_at`以下、
  `expires_at`はそれより後のcanonical UTCとする。
- capacity snapshotのscopeはexactなexecutor envelope（adapter／contract／instance／handle schema）と
  `workflow_id`の組である。provider／account全体の別rate limitを暗黙に同じ値へ畳み込まない。
- 未知adapterも観測として保存できるが、既知contractやdispatch許可へ昇格しない。
  `gpt-connector`は親直轄Consultation専用なのでWorker Registryへ記録せず、
  `EXECUTOR_FORBIDDEN`で拒否する。

## Deterministic placement dry-run

`placementDryRun`はTaskと親が列挙した候補を現在のControl／Registry snapshotへ照合する
read-only判定である。候補を自動生成・score・dispatchせず、manifest／receiptを変更しない。
global mutation lockで一貫した全Control snapshotを読み、callerが渡したcanonical `evaluated_at`を
expiry判定に使うため、同じsnapshotと入力から同じ結果を返す。

```json
{
  "cwd": "/project",
  "control_id": "elastic-phase1",
  "task_id": "T-001",
  "evaluated_at": "2026-07-14T00:10:00.000Z",
  "candidates": [
    {
      "candidate_id": "candidate-001",
      "registry_observation_id": "registry-codex-native-001",
      "assignment_id": "assignment-001",
      "workspace_cwd": "/project-worktree",
      "workspace_binding": "fixed",
      "write_mode": "direct",
      "operation_digest": null,
      "budget_reservation": { "wall_time_seconds": 3600, "cost_microusd": 1000000 },
      "lineage": {
        "parent_worker_run_id": null,
        "root_assignment_id": "assignment-001",
        "provider": "openai",
        "model": "<docs/02_models.md 順位表「実装」1位の現行値>",
        "prompt_family": "implementation-v1",
        "independence_group": "implementation-primary",
        "context_policy": {
          "share_objective": true,
          "share_current_candidate": false,
          "share_existing_findings": false,
          "share_failed_approaches": false,
          "share_test_results": true
        },
        "input_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "approach_family_ref": "implementation-primary",
        "shared_artifact_ids": []
      },
      "fallback": null,
      "executor_handle": null
    }
  ]
}
```

- executor envelope、workflow、capabilities、verificationは候補の自己申告でなく、参照した
  immutable Registry observationから導出する。roleとcontext policyはTask snapshotへ照合する。
- F/A/H、approval digest／expiry、Task dependency、role/effect、required capability、verification stage、
  Budget Envelope、assignment retry、workspace identity／isolation、write mode、全Control横断write conflict、
  Registry expiry／enabled／capacityを検査する。
- git common dir配下の全Controlで同じcapacity scopeへ複数snapshotがある場合、`evaluated_at`以前で最大の
  `verification.observed_at`を持つsnapshotだけを現行候補とする。古いIDは`registry-superseded`、
  評価時刻より未来のIDは`registry-not-yet-observed`で拒否する。最新時刻が同じなのに内容が異なる
  snapshotは順序を捏造せず`registry-refresh-ambiguous`として親reviewへ送る。
- capacity admissionがunknown、hard／soft limitまたはobserved inflightがunknown、既知soft limit到達は
  `review-required`。enabled unknown、hard limit到達、unknown adapter、verification不足その他hard gateは
  `ineligible`。全hard gateを満たしreview理由もなければ`eligible`。
- capacityの比較値はRegistryの`observed_inflight`だけにしない。同じexecutor envelope／workflowへ
  記録済みの`planned`／`admitted` Runを予約として加え、`dispatched`／`running`／`unknown` Runは
  不変のdispatch evidence frontierがinflight evidenceの観測後にあるものだけを加える。heartbeatで
  上書きされる現在のexecutor observation時刻は使わない。これにより外部runtime側への反映前の予約を
  見落とさず、観測時点ですでに数えたactive Runを二重加算しない。両evidenceの観測時刻が同一で
  前後関係を確定できない場合は`review-required`とする。
- 返却は`control_id / control_revision / task_id / evaluated_at / candidates`。候補は
  `candidate_id`順、reasonは固定codeのunique sortとし、意味的な優劣や多数決を出力しない。
- `eligible`はdispatchや予約の成立を意味しない。次のmutationで親が同じControl revisionと候補を
  reservation proposalとして明示記録するまで、Executorへ何も送らない。

### Placement reservation proposal

`reservePlacement`は候補をそのまま信じず、global lockと`expected_revision`の下で現在時刻を使って
同じplacement gateを再実行する。`ineligible`は常に`PLACEMENT_INELIGIBLE`で拒否する。
`review-required`は親が確認した`type=decision` evidenceを`review_decision`へ渡した場合だけ記録し、
未指定なら`PLACEMENT_REVIEW_REQUIRED`で拒否する。逆に`eligible`へ不要なreview decisionを添付して
意味を曖昧にすることも拒否する。

成功時は別の自由形式proposalを作らず、候補を`state=planned`のWorker Runへ原子的にmaterializeする。
`candidate_id`が`worker_run_id`となり、Workerの`placement_reservation`へ次を保存する。

```json
{
  "registry_observation_id": "registry-codex-native-001",
  "candidate_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "selected_from_revision": 4,
  "eligibility": "review-required",
  "review_reasons": ["capacity-review-required"],
  "review_decision": {
    "type": "decision",
    "ref": "docs/placement-decisions/candidate-001.md",
    "digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "observed_at": "2026-07-14T00:10:00.000Z"
  },
  "selected_by": "parent-session-id",
  "selected_at": "2026-07-14T00:10:00.000Z"
}
```

v27以降ではrate-aware selectorの決定（`dotagents.selector-decision.v1`——選択pool・4要素executor
envelope・評価時刻・reason・pool評価・snapshot evidence・reservation）を**optional keyの
`selector_decision`**として同objectへ保存できる（ADR 0054）。常在keyのnull可にはしない——
reservation objectはcanonical JSON全体が作成時receiptの`subject_digest`へ束縛されるため、
keyの後付け注入は既存Controlの読取を恒久破壊する。migrationは既存reservationを一切書き換えず、
selectorを経ないreservationにはkey自体が存在しない。v27未満のmanifestで本keyは`INVALID_SCHEMA`。

candidate digestはmaterialize後のWorkerから再構成したcandidate exact objectのcanonical JSON
SHA-256。workspaceは解決済みrealpathを使うため、入力時のsymlink表現には依存しない。manifest読込時に
毎回再計算し、記録時workspace fingerprintも同じdigestへ含める。さらに、WorkerへRegistryから転記した`executor`、`workflow_id`、
`workflow_capabilities`、`execution_verification`は、参照したRegistry observationとexactに一致しなければ
manifestを拒否する。Registry IDだけを残して派生snapshotを差し替えることはできない。
`selected_from_revision`はmutation直前revisionであり、dry-run後に別mutationが入れば
`REVISION_CONFLICT`となる。
planned Runはcapacity／budget予約として後続placementへ数えるが、write workspace reservationは
従来どおり`admitWorker`時に再検査して取得する。proposal記録自体はdispatchを行わない。

`workerRunRecord`は親がExecutor宣言を直接記録する既存の明示操作であり、Registry snapshotに基づく
placement eligibilityを主張する操作ではない。Registry評価済みとして扱う時は必ず`reservePlacement`を
使い、manual記録をeligible／review済みへ読み替えない。どちらの経路も当該ControlのBudget Envelopeと
明示admissionを迂回できず、全Control横断write conflictはadmission時に再検査する。

### Brief status and resume check

`status --brief`は`dotagents.orchestration-status-brief.v7`としてmanifest全体を複製せず、
次だけを親の再開用に固定shapeで返す。`resumeCheck`はこのbriefを含むため
`dotagents.orchestration-resume-check.v7`とする。v7はv6の`slug`直接投影を
`consultation_handle`投影へ置換したprojection bumpで、v25 manifestのconsultationも
`{ "slug": ... }`へ正規化して返す（silent shape変形を許さない。ADR 0045）。

- Control ID、schema/revision/status、objective、last update、Task／Registry／Worker／Consultation／Campaign件数
- Task取消件数、取消済みTask ID、未terminalのcancel要求済みWorker ID
- nonterminal WorkerのExecutor envelope、workflow、opaque handle、最終観測、cancel要求snapshot
- nonterminal Consultationのconnector、consultation_handle、model／effort、最終観測
- finalizationもcancellationも未記録のTask、completed未受入Worker、Control finalization未完
- Campaignごとのtype、all-terminal、audit-required、release有無と、未release Campaign ID
- stateが`unknown`のRun／Consultationと、値がunknownのRegistry field
- `dispatched | running | unknown`で所有Executorから未回収のRun／Consultation

`resumeCheck`はread-onlyでglobal lockを取り、全manifestの整合を再検証してから次を返す。

```text
outcome = ready | review-required | blocked
brief
current_workspace
evidence_retention
blocking_reasons
review_reasons
```

- Controlのproject/common/git directory realpathとgit directory generationを再照合する。realpathまたは
  inodeの変更は`blocked`。同じrealpath・inodeを保ったdevice番号だけの変化は、再起動やmount namespace
  差で起こり得るため`review-required`として親へ返す。HEAD、dirty boolean、porcelain status digest、
  bounded workspace fingerprintのinit時との差も`review-required`。dirtyのまま同じpathの内容だけが
  変わる場合もfingerprint差として見落とさない。
- nonterminal Workerのworkspace identity/generationを再解決する。予約中writerのHEAD変更、workspace消失、
  generation変更は`blocked`。全worktree Workerは記録時のbounded fingerprintを持ち、read／planned Workerの
  内容差は`review-required`。予約中writerのscope外差分、index／HEAD／ignored output driftは`blocked`、
  scope内の作業途中は`review-required`。read Worker等のHEAD変更も親reviewへ送る。
- `dispatched | running | unknown`のWorker／Consultationは、opaque handleまたはconsultation handleを一覧へ戻し、
  所有Executorへの再照会が必要なため`review-required`とする。timeoutをfailedへ変換しない。
- `file | decision` evidenceはproject rootの非symlink regular fileを合計64 MiBまで再hashする。欠損、
  digest不一致、unsafe path、hash上限超過、読取中driftは`blocked`。現内容が変わっていても、
  最大256 commitのgit履歴（到達可能ref）に同一path・regular blob・同一SHA-256が残る時だけ
  `retained-history`として保持し、任意の別pathやhash不一致へfallbackしない（2026-07-17に
  file型へも拡張。ADR 0060）。file型のpath消失＋履歴実在（archive退避等）は無音にせず
  `evidence-retained-history-missing`として`review-required`へ出す。履歴に無いdigest（未commitの
  dirty状態で観測した証拠）と256 commit超の深履歴は救済せず`blocked`のまま＝fail closed。
  履歴走査は64 MiB共有budgetに含まれ、超過は`unsafe`→`blocked`へ落ちる。
  **この救済はresume-checkの再開助言に限る**。finalization／archiveのfile型evidence検証は
  不変Decision（docs/elastic-orchestrator-archive-decision-history.md 2026-07-15）どおり
  厳格のまま変更しない——resume側とarchive側の非対称は意図であり、archive側の裁定変更は
  親計画の予約裁定（archive退避とevidence解決の正典衝突）でだけ行う。bareでworktree内容を
  検証できないlocal evidenceだけは`review-required`。
- `command | url | executor-receipt`は内容を複製せずtype/ref/digestだけをopaque一覧へ返す。v1 dogfood以前に
  provider URI（`native:`等）を誤って`decision`と記録したlegacy descriptorも内容をlocal fileと推測せず
  opaqueへ分離し、`evidence-legacy-decision-ref`として`review-required`にする。成功やretainedへ丸めない。
- `resumeCheck`は観測を更新せず、readyを捏造しない。親が所有Executorへ再照会し、既存のobserve operationで
  新しい事実を記録する。各製品のsession/job state、report、credentialをControlへ複製しない。

## Task declaration

Taskは意味と受入条件への参照であり、Executorへ直接結びつけない。一度記録したTaskは不変。
仕様、scope、成功条件が変わる場合は新しい`task_id`を作る。

以下は保存形である。`taskRecord`入力は`admission_digest`を持たず、libraryがTaskのexactな
機械契約をcanonical JSONへ変換してSHA-256を計算し、追加する。

```json
{
  "task_id": "T-001",
  "title": "Control Record coreを実装する",
  "classification": "A",
  "effect": "write",
  "doc_ref": "docs/plan_elastic-orchestrator.md",
  "role": "implementer",
  "lane": "behavior-preserving",
  "depends_on": [],
  "required_capabilities": ["workspace.write", "report.structured"],
  "isolation": "dedicated-worktree",
  "context_policy": {
    "share_objective": true,
    "share_current_candidate": false,
    "share_existing_findings": false,
    "share_failed_approaches": false,
    "share_test_results": true
  },
  "validation": ["node --test tests/orchestrate/*.test.mjs"],
  "non_goals": ["Executorを自動起動しない"],
  "known_traps": ["docs正本をruntime stateへ複製しない"],
  "read_scope": [{ "kind": "directory", "path": "shared/orchestrate" }],
  "write_scope": [{ "kind": "directory", "path": "lib/orchestrate" }],
  "approval": null,
  "alternative_group": null,
  "admission_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

- `classification`は`F | A | H`、`effect`は`read | write`。Task自体へWorker／Consultationの
  実行laneを焼き込まない。同じTaskを独立WorkerとCritic Consultationの双方が参照できる。
- readは`write_scope=[]`。writeは1件以上を必須とする。
- **`external_source`（v30・ADR 0116）**: v25〜v29のtaskはキー**不在**が正規形、v30以降はキー存在を
  必須とし`null`＝direct path（外部相関なし）。非nullは
  `namespace / contract_version / external_id / immutable_digest`のexact 4キーclosed tupleだけを許し、
  自由形式metadata・外部label・外部state・外部依存のcopyを拒否する。書けるのはtask-recordの一回だけで、
  更新・差替のmutation面は存在しない（外部側driftはbindingの書換でなくdispatch直前の公開status再読と
  digest照合で拒否する）。v29以下のmanifestへ`external_source`付きtask-recordは
  `SCHEMA_UPGRADE_REQUIRED`。`lattice.todo` namespaceでは`external_id`を
  `plan_key/plan_version/task_id`のcanonical合成、`immutable_digest`を対象memberの
  `member_heads.revision_digest`とし、unreconciled member（`revision_digest`がnull）への
  bindingを作らない。binding失効の正規回復路はtask-cancel-record＋新Taskの再recordだけとする。
- **digest正規化（ADR 0116 Decision 2）**: `admission_digest`と`packet_digest`の双方で、
  `external_source: null`はキー不在とdigest等価に正規化する。これによりv29→v30 migration
  （全taskへ`null`付与）は既存taskのadmission_digestも走行中workerのpacket_digest照合も一切変えない。
- Hは次のexact approval snapshotを必須とし、H以外では`null`を必須とする。親が承認の真正性と
  意味を確認し、Controlは対象operation digestと有効期限だけをadmission時に照合する。

```json
{
  "approval_ref": "docs/approval.md",
  "purpose": "対象操作の目的",
  "impact": "外部状態への影響",
  "rollback": "失敗時の戻し方",
  "operation_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "approved_by": "owner",
  "approved_at": "2026-07-14T00:00:00.000Z",
  "expires_at": "2026-07-15T00:00:00.000Z"
}
```

`expires_at`は`null`または`approved_at`より後のcanonical UTCとする。Worker Runは
`operation_digest`を持ち、H Taskでは完全一致しないRunを`APPROVAL_MISMATCH`、期限切れを
  `APPROVAL_EXPIRED`としてadmission前に拒否する。

### Task cancellation

`taskCancelRecord`はTaskの論理的な取消Decisionを記録する。入力は`task_id`と
`type=decision`のtyped evidenceを必須とし、保存時に`cancelled_from_revision / cancelled_by /
cancelled_at`を追加する。Task本体はimmutableのまま、取消記録を`task_cancellations`へ1件だけ追加する。

- 取消後は新しいplacement reservation、Worker Run、Consultation、planned Workerのadmission、
  planned Consultationのdispatchを拒否する。
- **取消済みTaskのplanned Consultationはv25/v26で閉鎖要求から除外する**（ADR 0053）: dispatchが
  恒久拒否されplanned→terminal遷移が存在しないため、Control finalization準備・closing receipt
  容量予約・campaign all-terminal判定の3箇所で孤児として除外する。stateは`planned`のまま
  書き換えず監査可能に保ち、`dispatched`以降のConsultationは従来どおりterminalへの回収を
  必須とする。**v27以降ではこの除外は適用されない**——明示の脱出経路は`consultation-cancel`であり、
  孤児plannedは親が取り消すまでfinalizeを正しくブロックする（ADR 0054）。
- 取消時点で存在するWorker／Consultationのstate、opaque handle、write reservationを変更しない。
  Task取消だけでExecutor上の処理をcancelled扱いにせず、既存Runは所有Executorの観測で閉じる。
- finalized Taskの取消、同一Taskの重複取消を拒否する。Task取消DecisionはWorker個別のcancel要求を
  代替せず、既存Runを止める場合はRunごとに`requestWorkerCancel`を記録する。
- cancelled TaskはControl閉鎖上のterminal Taskであり、別の`task_finalization`を要求しない。ただし取消時点の
  Run／Consultationは従来どおり個別にterminalへ回収し、cancelled Taskを依存Taskのready証拠にはしない。

- Fの外部writerを拒否する。Fのwriteは`executor=parent`だけ。
- `role_effect_policy`は`dotagents.role-effect.v1`のexact snapshotとし、`sorter | refuter | verifier`の
  writeを拒否する。`integrator`のwriteはH approval snapshotを持つTaskだけ許可する。roleの意味正本は
  既存agent／skill文書であり、Controlはこの最小effect gateだけを所有する。
- `role`はbounded identifier、`lane`は`behavior-preserving | behavior-change | not-applicable`、
  `isolation`は`none | dedicated-worktree`。role/effectの許可matrixとcapability照合は別gateで扱う。
- `depends_on`は同じControl内ですでに記録済みのTaskだけを参照する。self、重複、未知Taskを拒否し、
  保存manifest全体でもcycleを再検査する。Taskは不変かつ過去Taskだけを参照するため、通常のAPIから
  cycleは生成できない。
- `required_capabilities`はbounded identifierの集合。`context_policy`はobjective、current candidate、
  existing findings、failed approaches、test resultsの共有可否をexact booleanで固定する。
- `validation`は1件以上、`non_goals`と`known_traps`は0件以上のbounded文字列snapshotである。
  prompt全文、秘密、巨大logを入れない。意味と詳細は`doc_ref`のdocs正本が所有する。
- `admission_digest`は`admission_digest`自身を除くTask object全体のcanonical JSON SHA-256である。
  読込時にも再計算し、snapshot改ざんをfail closedにする。
- libraryはTask記録時に`doc_ref`が安全に取得可能であることだけを確認する。文書全体のOIDは保存せず、
  admission時にも再hashしない。無関係なdocs追記で既存Taskを停止させず、機械契約を変える場合は
  文書を更新して新しい`task_id`を作る。
- `task_id`は同じgit common dirにある全active manifestで一意。再開は新Controlを作らず、
  既存Controlを読む。
- 全manifest scanと各mutationのcommit直前に、Task／Worker Run／Consultation IDのglobal一意性、
  assignmentの`kind + task_id` immutable tuple、予約中writerのworktree／scope競合を再検証する。
  admission時だけの検査に依存せず、保存済みControl間の矛盾は`INVALID_SCHEMA`でfail closedにする。
- Workerの`planned -> admitted`とConsultationの`planned -> dispatched`は、全`depends_on`に
  `task_finalization`が存在する場合だけ許可する。未完了なら`DEPENDENCY_NOT_READY`で拒否する。

## Scope

scope entryは`kind=file | directory`とrepo相対`path`だけを持つ。

- `/`区切り、Unicode NFC、空でないliteral pathに正規化する。
- absolute path、空segment、`.`、`..`、backslash、NUL、glob記号を拒否する。
- `a/b`と`a/bc`は別segment。directoryは同一pathと子孫、fileは同一pathだけに重なる。
- macOS／Windowsではcase foldして競合側へ倒す。Linuxではcase-sensitiveとする。
- Worker Runのworkspaceに対し各path componentを`lstat`し、symlink componentを拒否する。
  missing childはnearest existing ancestorまで検査する。
- renameはsourceとdestinationの両方をwrite scopeへ宣言する。
- scopeは宣言同士の競合検査でありsandboxではない。実write制限はExecutorが所有し、親は
  回収後のdiffがscope内か別途検証する。
- symlink差替えのTOCTOUを狭めるため、予約時とaccept時にscopeを再検査する。

## Worker Run

Worker Runは一回のworker割当である。入力schemaはExecutorごとの判別unionにし、
`gpt-connector`を受理しない。

記録入力は次のexact fieldを持つ。`workspace_cwd`は既存directoryへの明示入力であり、保存しない。

```text
worker_run_id, task_id, assignment_id, executor, workflow_id, role_ref,
workflow_capabilities, budget_reservation,
workspace_cwd, workspace_binding, write_mode, operation_digest, execution_verification,
lineage, placement_reservation,
state, executor_handle, executor_observation, admission, cancel_request,
dispatch_evidence, dispatch_attempt_evidence, terminal_evidence,
result, acceptance
```

手動入力の初回記録は`workspace_cwd`を受け取り、保存時に`workspace`、
`recorded_workspace_fingerprint`、`baseline_workspace_fingerprint=null`へ変換する。
`recorded_workspace_fingerprint`はworktreeで必須、bareで`null`であり、resume時のdirty/content差を検出する。
write Taskではplanned段階からTaskのwrite scopeをfingerprint guardへ渡し、ignored成果物も記録時との差へ含める。
手動の初回記録は`placement_reservation=null`、`state=planned`、
`executor_observation=cancel_request=result=acceptance=null`だけを受理する。non-null reservationは
`reservePlacement`だけが作り、`workerRunRecord`からの偽装を拒否する。
`write_mode`はread Taskなら`none`、write Taskなら`direct | isolated-alternative`。
`operation_digest`は通常Taskでは`null`またはSHA-256、H Taskではapproval snapshotの
`operation_digest`と完全一致するSHA-256を必須とする。
scopeと`alternative_group`は参照Taskから取得し、Worker入力での上書きを許さない。
`role_ref`は参照Taskの`role`と完全一致しなければならない。
libraryは`workspace_cwd`から次のcanonical objectを解決し、保存時はこれに置き換える。
保存形は`workspace_cwd`を持たず、`workspace`と`baseline_workspace_fingerprint`を持つ。
後者は初期`planned`では`null`、通常write Runの`admitted`以降は必須、read Runでは常に`null`とする。
`admission`は初期`planned`では`null`、`admitted`以降は
`{ admitted_by, admitted_at, write_reservation }`を持つ。read Runは`write_reservation=false`、
write Runは`true`であり、後者だけがglobal writer reservationを保持する。

```json
{
  "workspace": {
    "kind": "worktree",
    "worktree_root_realpath": "/project",
    "git_dir_realpath": "/project/.git",
    "git_dir_file_id": "16777234:1234567",
    "common_dir_realpath": "/project/.git",
    "head_at_record": "0123456789abcdef0123456789abcdef01234567",
    "head_at_reservation": null
  }
}
```

`kind`は`worktree | bare`。`git_dir_file_id`はsymlinkでないgit directoryを`stat`した
`dev:ino`のdecimal文字列で、同じpathにworktreeをremove/re-addした世代差も検出する。
bareでは`worktree_root_realpath`と両HEADを`null`にする。
`head_at_reservation`は`planned -> admitted`のwrite admission時に同じlock内で再取得する。
Workerのcommon dirはControlのcommon dirと一致しなければならない。

`workspace_binding`入力は`fixed | executor-isolated`である。`fixed`は従来どおり上記`workspace`を
実行先とする。`executor-isolated`は`codex-sidecar/v1/work`のwrite RunかつTask
`isolation=dedicated-worktree`だけに許可し、上記`workspace`をsource／予約元として保持したまま、
保存時に次の遅延bindingへ変換する。sourceのdirtyは実行worktreeへ移らないが、固定`base_sha`と
Task snapshotで入力を確定するため一律拒否しない。

```json
{
  "workspace_binding": {
    "mode": "executor-isolated",
    "schema_version": "codex-sidecar.delayed-worktree.v1",
    "base_sha": "0123456789abcdef0123456789abcdef01234567",
    "preserve_worktree": true,
    "execution_workspace": null,
    "provider_binding": null,
    "bound_from_revision": null,
    "binding_evidence": [],
    "bound_by": null,
    "bound_at": null
  }
}
```

遅延Runも`admitted`からglobal write reservationを保持するが、実行worktreeがまだ存在しないため
source fingerprintをbaselineへ偽装せず`baseline_workspace_fingerprint=null`を維持する。
親がterminal sidecar resultの`worktreePath`を回収した後、record-only
`worker-workspace-bind`で実path、`idempotency_key / provider_run_id / worktree_path / result_digest`を
相関したprovider binding、evidenceを記録する。bindはactive Runだけに一度許可し、symlink、
source自身、別common dir、別HEAD、非worktreeを拒否する。実worktreeはsourceと同じcommon dir、
異なるroot、`HEAD=base_sha`、`preserve_worktree=true`でなければならない。ControlやCLIはworktreeを
生成・削除せず、sidecar commandも実行しない。provider bindingのhandle、path、result digestと
Worker Run／Reportが一致しなければ`REPORT_CORRELATION_MISMATCH`で拒否する。

- `assignment_id`は一つの論理割当を表す。同じTaskへ独立fan-outする時は別assignmentを使う。
  retryは同じassignmentを使う。先行Runが`failed | cancelled`、または
  `completed + rejected`になった場合だけ新Runを許可する。`unknown`を含むnonterminal、
  `completed + pending/accepted`が残る間は拒否する。
- provider障害後に別入口へfallbackする場合も既存Runを書き換えず、新しいWorker Runを作る。
  新Runの`fallback`は`{ from_worker_run_id, decision_ref }`または`null`で、非null時は同じControl・同じ
  Taskの`failed` Runとrepo相対の親Decisionを必須にする。参照元Runはfailedのまま保持し、unknownや
  completedをfallback元へ偽装しない。Delegation Packetにも同じsnapshotを含める。
- `executor`は`adapter_id / contract_version / instance_id / handle_schema_id`だけを持つexact envelope。
  `workflow_id`はadapter identityと分離する。同じ`codex-sidecar`でも`review`等の同期read-only系と
  durable `work`は異なるworkflow／handle contractであり、adapter名だけからwrite能力を推測しない。
- 現在の既知handle schemaは次のとおり。既知の組合せはexact shapeで検証する。
  - `parent.correlation.v1`: `{ "correlation_id": "..." }`
  - `codex-native.agent-path.v1`: `{ "agent_path": "/root/<task>" }`または予約時の`null`
  - `codex-sidecar.idempotency-key.v1`: `{ "idempotency_key": "..." }`。keyは製品契約どおり
    22〜128文字のbase64urlまたはUUID。
  - `codex-sidecar.synchronous.v1`: durable handleを持たず、予約・active・reportを通して`null`
  - `aiterm.session.v1`: `{ "session_id": "...", "agent_kind": "codex|grok|composer" }`または予約時の`null`
  - `claude-native.session.v1`: `{ "session_id": "..." }`または予約時の`null`。`session_id`は
    caller生成のlowercase UUIDだけを受理し、start/resumeを通して同一値を維持する。
- 未知のadapter／contract／workflow／handle schemaを含むmanifestは、bounded opaque handleとして
  structural validationを通し、`status`のJSON出力で回収できる。一方、そのControlへのmutationと
  新規Worker記録は`ADAPTER_UNKNOWN`でfail closedにする。未知handleを解釈、補完、dispatchしない。
  `gpt-connector`はenvelope化しても`EXECUTOR_FORBIDDEN`であり、Consultationだけを使う。
- `workflow_capabilities`は`capability_id / value / evidence`のcanonical sort済み配列。
  `value`は文字列`true | false | unknown`で、`true/false`はtyped evidenceを必須とし、`unknown`を
  0、false、無制限、対応済みへ丸めない。Taskの`required_capabilities`は全て`true`の場合だけ満たす。
  capability IDの重複と非canonical順序を拒否する。
- `codex-sidecar`の同期read-only workflow（`auditor / explore / generate / opinion / review /
  risk-check`）は`workspace.write=false`かつ`readonly.enforceable=true`を必須とする。durable `work`は
  `workspace.write=true`かつ`workspace.isolated=true`を必須とし、adapter名だけから能力を合成しない。
  同期workflowは製品側に再照会可能なdurable handleがないため、handleを捏造せず`null`のまま
  dispatch／report importを許す。Task／Run／assignment IDとDelegation Packet digestを完全一致させて
  結果を相関する。他の予約時nullableな契約はdispatch以降にtyped handleを必須とする。
- `budget_reservation`は`wall_time_seconds / cost_microusd`のexact object。各値は非負整数
  （wall timeの既知値は1以上）または`null=unknown`であり、actual usageや請求額を捏造しない。

## Budget Envelope

Controlの`budget`は`max_worker_runs / max_consultations / max_external_runs /
max_wall_time_seconds / max_cost_microusd / max_runs_per_approach_family /
max_retries_per_assignment / max_integration_runs`だけを持つ。件数上限は既知の非負整数を必須とする。
wall timeとcost上限は非負整数または`null=unknown`である。costは浮動小数を避けるため1 USDの
100万分の1を1 microusdとして保存する。

- Worker件数はparent／native／externalを含む全Worker Run、Consultation件数は別に数える。
  external Runは`parent`と`codex-native`以外のWorkerであり、`gpt-connector` Consultationを混ぜない。
- wall timeとcostは、Worker／Consultationの全予約上限を合算する。failed／cancelled／retryも記録済み
  Runとして消費し、黙ってbudgetを返却しない。
- approach family上限は同じ非null `lineage.approach_family_ref`の全Run、retry上限は初回を除く同じ
  assignmentのRun、integration上限はroleが`integrator`のTaskを参照する全Runを、いずれも当該
  Control内だけで数える。別Controlの履歴は当該Controlが所有するBudgetを消費しない。placementは
  `approach-family-limit / approach-family-blocked / approach-family-context-mismatch / retry-limit /
  integration-capacity-exhausted`をhard reasonとして返す。
  approach familyがnullの候補は`approach-family-unknown`でineligibleにし、無制限へ丸めない。
- `null`を0、未使用、無制限へ丸めない。read-only `status`はunknownを保持して読めるが、Control上限
  または新規予約がunknownのままRun／Consultationを追加するmutationは`BUDGET_UNKNOWN`で拒否する。
- 既知上限を件数または安全整数の合計が超えた場合は`BUDGET_EXCEEDED`。価格推測、自動最適化、
  provider間換算は行わない。
- `execution_verification`は`stage`、`observed_version`、`observed_at`、`evidence`だけを持つ。
  stageは`unverified | installed | registered | verified | execution-verified`。parent以外のRunは
  `verified`以上、外部writeは`execution-verified`だけを許可する。未知入口はwriterへ配置しない。
- workspace identityはlibraryがgitから解決し、入力の自己申告値をそのまま保存しない。
- `lineage`は次のexact objectとし、独立性scoreや票数を保存しない。

  ```json
  {
    "parent_worker_run_id": null,
    "root_assignment_id": "assignment-001",
    "provider": "openai",
    "model": "<docs/02_models.md 順位表「実装」1位の現行値>",
    "prompt_family": "implementation-v1",
    "independence_group": "implementation-primary",
    "context_policy": {
      "share_objective": true,
      "share_current_candidate": false,
      "share_existing_findings": false,
      "share_failed_approaches": false,
      "share_test_results": true
    },
    "input_digest": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    "approach_family_ref": null,
    "shared_artifact_ids": []
  }
  ```

  provider／modelは未解決なら文字列`unknown`を明示し、空や推測値で埋めない。root Runは
  `parent_worker_run_id=null`かつ`root_assignment_id=assignment_id`。子Runは同じControl内ですでに
  記録済みのparent Workerを参照し、root assignmentを継承する。`context_policy`はTask snapshotと
  完全一致する。`input_digest`は親が渡すpacket／入力構成のSHA-256であり、内容本体は保存しない。
  `approach_family_ref`はbounded identifierまたは`null`、`shared_artifact_ids`は同一Controlの
  finding artifact ID参照である。非空の共有IDは`share_existing_findings=true`の場合だけ許し、
  manual Workerの生成receiptはlineage全体をdigestへ束縛する。
- 同一worktreeはscopeが非交差でも予約済みwriterを最大1件とする。workspace全体fingerprintを
  共有するため、Phase 1では同一worktree並行writeを許可しない。別worktreeの重複scopeは、双方が
  `write_mode=isolated-alternative`かつ同じ非空`alternative_group`の場合だけ許可する。

### Worker state

```text
planned -> admitted | cancelled
admitted -> dispatched | cancelled
dispatched -> running | unknown | completed | failed | cancelled
running -> unknown | completed | failed | cancelled
unknown -> running | completed | failed | cancelled
```

`completed | failed | cancelled`はterminalで巻き戻さない。`unknown`は失敗でなく予約を保持する。
初期Runは`planned`で記録し、`admitted`への遷移をatomic admissionとする。read Runも明示admissionを
通り、write Runだけが同じtransactionでworkspace baselineとglobal write reservationを取得する。
CLIは実際のdispatch、poll、cancel、retryを行わない。

`requestWorkerCancel`は`admitted | dispatched | running | unknown`のWorkerへ親のcancel Decisionを
記録するだけで、Worker stateを変更しない。既存のnon-null Executor handleをexact snapshotとして
`cancel_request`へ束縛し、同じRunの重複要求、planned／terminal Runへの要求を拒否する。このoperationは
adapterのcancel API、signal、network、process操作を実行しない。親または後続adapterが所有Executorへ
要求を伝えた後も、Control上のterminal確定には別の`observeWorker`とExecutor由来evidenceが必要である。

保存manifestはread時とmutation後のsave前に次のtruth tableを満たすことを必須とする。

| state | admission | observation | result | acceptance | evidence |
|---|---|---|---|---|---|
| `planned` | `null` | `null` | `null` | `null` | 3配列とも空 |
| `admitted` | 必須 | `null` | `null` | `null` | 3配列とも空 |
| `dispatched` | 必須 | 必須 | `null` | `null` | dispatchのみ1件以上 |
| `running / unknown` | 必須 | 必須 | `null` | `null` | dispatchのみ1件以上 |
| `completed` | 必須 | 必須 | 必須 | 任意 | dispatchは1件以上、terminal／attemptは空 |
| `failed` | 必須 | 必須 | `null` | `null` | dispatchとterminalが1件以上、attemptは空 |
| `cancelled` | 経路依存 | 必須 | `null` | `null` | planned取消は全空、要求なしadmitted取消はattempt、cancel要求後はterminal、dispatch後はdispatch＋terminal |

write Runは`admitted`以降でbaseline必須、read Runは全stateでbaseline `null`。
`acceptance`は`completed`だけが持てる。表と矛盾する保存stateは、たとえJSON shapeが正しくても
`INVALID_SCHEMA`でfail closedにする。

`planned`はnonterminalでarchiveと同assignment retryを阻止するが、write予約は持たない。
予約済みwriterは`admitted | dispatched | running | unknown`である。write Runの`planned -> admitted`時に全Controlを
横断して競合を検査し、競合があれば状態を変えない。

`admitWorker`はExecutorへ何も送信せず、保存済みTask snapshotのdigest、依存完了、
workspace identity、scopeを同じlock内で検査する。文書全体のdigestは再検査しない。
write Runではさらに全Control競合を検査し、
通常bindingなら`baseline_workspace_fingerprint`も保存する。遅延bindingはscope reservationだけを
同じ時点で確立し、未bindでも重複scope writerを阻止する。
`admitted -> dispatched`は、所有Executor上にRunが存在することを、再照会可能なhandleまたは
idempotency keyと`dispatch_evidence`で確認した観測だけを受理する。
cancel要求がない`admitted -> cancelled`はRunが作成されなかったことを示す空でない
`dispatch_attempt_evidence`を必須とする。cancel要求済みの`admitted -> cancelled`は、要求したという
事実だけでterminalへ進めず、所有Executorが取消を確認した`terminal_evidence`を必須とする。
予約後の実在確認に使えるhandle／idempotency keyを持てない入口はwriterへ使えない。

`executor_observation`は`source`、`observed_version`、`observed_at`、`raw_state`を持つ。
raw outputやpromptは保存しない。`completed`には親が確認可能な64桁SHA-256
`result_digest`と1件以上の`evidence`を必須とする。
`dispatched | running | unknown`から`failed | cancelled`へ進む場合も、所有Executorの
terminal状態を確認した`terminal_evidence`を1件以上必須とし、caller timeoutやcancel要求
だけでterminalへ進めない。まだdispatchしていない`planned -> cancelled`だけはterminal evidenceを
要求しない。

`observeWorker`の`observation`は次のexact fieldだけを受理する。

```text
state, source, observed_version, observed_at, raw_state,
executor_handle?, dispatch_evidence?, dispatch_attempt_evidence?,
result?, terminal_evidence?
```

handleがある場合はExecutor別shapeに適合し、既存handleと矛盾してはならない。`dispatched`は
空でない`dispatch_evidence`を必須とし、同期sidecar以外は契約上のactive handleも必須とする。
cancel要求のない`admitted -> cancelled`は空でない
`dispatch_attempt_evidence`、cancel要求後の取消確定は空でない`terminal_evidence`を必須とする。`completed`の
`result`は`{ result_digest, evidence }`だけを持つ。write Runではlibraryが
`workspace_fingerprint`を計算してresultへ追加する。`failed | cancelled`はresultを持たず、
dispatch後なら空でない`terminal_evidence`を必須とする。他stateでterminal evidenceや
resultを持てない。各evidence配列はWorker直下へ累積保存し、保存する`executor_observation`は
source/version/time/raw_stateだけである。

遅延bindingのwrite Runは、bind済みexecution workspaceなしに`completed`へ進めない。bind後は
execution workspaceのHEAD、identity、scopeと現在fingerprintを検査する。source workspaceを実行先に
見せない。`failed | cancelled`は成果受入を伴わないため、未bindでも所有Executorのterminal evidenceで
確定できる。resume時の未bind active Runは失敗や成功へ丸めず、同じopaque handleの再照会を
`review-required`として要求する。

### Delegation Packet と Worker Report

`delegation-packet`は、read Runの`planned | admitted`またはwrite Runの`admitted`から生成する純粋・record-only出力である。
write Runはadmissionでbaseline HEADを確定するため、planned時のpacket生成を`INVALID_TRANSITION`で拒否する。
`delegation-packet-recover`は、packet保存漏れから同一Runを再dispatchせず相関情報を回収するため、
`dispatched | running | unknown` Workerだけから同じprojectionを再構成する専用read-only出力である。
前者は取消済みTask、両者は対象外state、未知／forbidden Executor（`gpt-connector`を含む）を
fail closedにする。後者は既にactiveなRunのterminal report相関を保つため、取消済みTaskでも回収を
許す。どちらもdispatch、process起動、network、製品stateの読書きを行わない。

- packet schemaは`dotagents.delegation-packet.v1`。Task canonical snapshot、Worker/assignment ID、
  Executor envelopeとworkflow、git由来source workspaceとworkspace binding、read/write scope、classification/effect/role、
  capability・budget reservation、lineage/context policy、validation参照、non-goals、known traps、
  report schema IDを含む。`packet_digest`はこのimmutable projectionのSHA-256である。
- packetはprompt全文、raw log、secret、巨大output、Executor製品内部stateを保存・出力しない。
  `adapter_id / workflow_id / handle_schema_id`を別々に明示し、全Executorが同一lifecycleを持つとは
  仮定しない。
- packet内のtemplateは`dotagents.worker-report.v1`を指定する。reportはexact objectで
  `schema_version, control_id, task_id, worker_run_id, assignment_id, packet_digest, executor_handle,
  observed_state, status, result_digest, evidence, validation_results, changed_paths, claims`だけを受理する。
  `prompt`、`raw_log`、`secret`、任意extra fieldは禁止する。`validation_results`の各entryは
  `validation_ref / outcome / evidence`で、Task snapshotの`validation`を重複なく完全に参照し、全て
  `passed`でなければならない。空・`unknown`は必須validationを満たさず、`failed`は`REPORT_NONZERO`として
  拒否する。status/observed stateは現在`completed`のみである。
- `worker-report-import`はactive（`dispatched | running | unknown`）Runだけを`completed`へ観測する。
  packet/Task/Run/assignment/Executor handle/digestを再相関する。同期sidecarだけは両側のhandleが`null`で
  あることを確認し、packet digestを含む残りの相関項目を省略しない。write Runでは実execution workspace fingerprintと
  reportのchanged pathsをscope内かつ一致するものだけにする。取消済みTaskでも既存active Runのterminal
  観測は許すが、planned/admittedからの新規実行は許さない。import receiptはtyped evidenceを持つ。
- report直下と`validation_results`内の全evidenceはcanonical ISO-8601時刻を持つ。長時間Runやoffline回収の
  過去時刻は維持するが、import時刻より5分を超えて未来なら`EVIDENCE_FROM_FUTURE`で拒否する。拒否後は
  imported evidenceを書き換えず、新しいretry Runへ実際の観測時刻を持つReportを収容する。
- importは親acceptではない。`acceptance`は`null`のままで、親の検証後に既存`accept`または`reject`を
  別revisionで記録する。

`worker-report-skeleton`は同じ`cwd / control_id / worker_run_id`から
`dotagents.worker-report-skeleton.v1`を返すread-only入口である。read Runのplanned／admittedとwrite Runのadmittedでは通常packet、
activeでは回収packetと同じ相関digestを使い、Worker Report v1のexact top-level fields、executor handle、
Task validation refs、nested evidence shapeをprefillする。digest／timestamp／receipt refは明示placeholderであり、
そのままimportできる成功reportではない。親はpacketとskeletonをdispatch前に保存して子へ渡し、
active後の保存漏れ回収で同じTaskを再dispatchしてはならない。

## Parent-declared campaign gate

Campaignは親が既存Run群をまとめ、後続Taskの開始条件を宣言するbounded gateである。scheduler、
barrier daemon、quorumではなく、Control上の参照と親releaseだけを所有する。

```text
campaign_id, campaign_type, members, gated_task_ids, audit_required,
declared_from_revision, declared_by, declared_at, release
```

- `campaign_type`は`discovery | refutation | design | implementation | final-audit`だけの固定列挙であり、
  任意名や`generic`のような後方互換用の種別は受理しない。`members`は同じControlに既存の
  `worker-run`または`consultation` IDを1件以上、`gated_task_ids`は同じControlのTask IDを1件以上持つ。
  重複・未知参照と、git common dir内のCampaign ID重複を拒否する。
- `campaign-status`は各memberの現在state、`all_terminal`、audit要否、releaseをmanifestから導出する
  read-only projectionである。Workerは`completed | failed | cancelled`、Consultationは
  `completed | failed`だけをterminalとし、別の集約stateを保存しない。
- 未release CampaignがgateするTaskは、`placement-dry-run`を`campaign-not-released`、
  `placement-reserve`を`PLACEMENT_INELIGIBLE`、既存planned Workerのadmissionとplanned
  Consultationのdispatchを`CAMPAIGN_NOT_RELEASED`で拒否する。既存active memberのterminal観測は
  妨げず、release後も後続Runを自動dispatch／admitしない。
- `campaign-release`は全member terminalを同じrevisionで再確認し、`completed` Workerは親の
  `accepted | rejected`裁定が済むまでreleaseしない。`audit_required=true`では1件以上の
  typed audit evidenceと、常に`type=decision`の親Decisionを必須とする。releaseは一度だけで、親actor、
  revision、時刻、evidenceをreceiptへ結合する。未release Campaignが一件でもあればControl finalizationを
  拒否する。
- release後の後続Runは、親が改めてplacement、admission、dispatchを行う。releaseをそれらの自動実行へ
  読み替えない。
- Campaign宣言のtype、members、gated Task、audit要否はcreation receiptのsubject digestへ結合し、
  schema上有効な別値への差替えも拒否する。
- record／status／releaseはprovider command、network、process、cancel、dispatchを実行しない。

## Fixed Control phase gate

Campaignとは別に、Controlは高々一つの親宣言phase gateを持てる。これは汎用workflow engineではなく、
`baseline → discovery → design → safety_net → implementation → behavior_change → integration → knowledge_return → complete`
だけをこの順で明示記録するControl stateである。未recordの`phase_gate: null`はactive Controlとして読めるが、
completeやfinalize可能とは扱わない。

- `phase-gate-record`は`risk: standard | high`と既存Taskと同じ`behavior_lane:
  behavior-preserving | behavior-change`を固定し、9 stepをすべて`pending`で作る。
- `phase-gate-advance`は現在のpending stepだけを一回進める。飛越、後退、重複、任意phase名を拒否する。
  `baseline`と`knowledge_return`はevidence 1件以上、`design`と`complete`は`type=decision`必須である。
- `risk=high`の`safety_net`は`completed`かつevidence 1件以上。`standard`だけが
  `not-required`を選べ、その省略にもDecisionが要る。`behavior-preserving`は
  `behavior_change=not-applicable`＋Decision、`behavior-change`は`completed`＋Decisionを要求する。
- Finding／Approach／Gap／Decision本文はdocs artifactが所有する。Controlはtyped evidence descriptor、
  digest、状態だけを保存する。record／advance／statusは外部process、network、dispatchを起動しない。
- 各record/advanceは同一manifestのreceiptへ厳密に対応し、receipt capacityは未完了stepすべてを
  閉鎖予約へ含める。v21 manifestは暗黙migrationもcomplete変換もせず`INVALID_SCHEMA`で停止する。

既存Controlでphase gateの設定漏れを発見した時は、実在するretained evidenceだけで順序どおりphaseを記録する。
事後の推測や証拠再構成で完了へ丸めない。

### Acceptance

Workerの`completed`と親の`accepted | rejected`を分離する。

import前に親が受入差分を返した時は、Workerは同一Run相関とexecutor handleで再作業する。import後にrejectした時は、
同じTaskとassignmentの新しいretry Runを作り、新しいPacket／Report相関で再配置する。完了報告の撤回だけで
停止したり、既存Runを書き換えたりしない。

- running／unknown／failed／cancelledをacceptできない。
- acceptanceは`decision=accepted|rejected`、`accepted_from_revision`、`result_digest`、Executor handle、
  `verification_evidence`、`decision_note`、`decided_by`、`decided_at`を保存する。
- write Runはcompleted観測時にlibraryがworkspace HEADとworkspace fingerprintを計算する。
  accept時にscopeとfingerprintを再計算し、一致しなければdriftとして拒否する。
- fingerprintはHEAD、worktree固有git indexのbytes、
  `git status --porcelain=v2 -z --untracked-files=all --no-renames`のbytes、およびstatusが列挙した
  changed tracked／untracked regular fileのrepo相対path・type・内容をstream hashする。
  staged-onlyとbinaryも表示用diffへ依存せず、indexと実file内容の双方へ束縛する。
- deleted pathはstatus recordへ束縛し、file読取を要求しない。symlink、submodule、socket、device等の
  regular file以外を拒否する。変更file内容の合計64 MiBまで許可し、64 MiBを超えた時点で拒否する。
  index/statusは各8 MiB上限とし、内容自体は保存・出力しない。
- fingerprintはaggregate digestに加え、statusが列挙した各pathの
  `{ path, state, file_mode, content_digest }`を保存する。deletedではfile modeとcontent digestを
  `null`にする。
  write予約時の`baseline_workspace_fingerprint`とcompleted時を比較し、増加・変更したpathがすべて
  Taskのwrite scope内で、scope外pathの状態・mode・digestが変化していない場合だけcompletedを記録する。
  accept時はcompleted fingerprintとの完全一致を要求する。
- 同じfingerprint passを連続2回実行し、HEAD、index digest、status bytes、file集合とcontent digestが
  完全一致した時だけ採用する。計算中にworkspaceが変化した場合はdriftとして拒否する。
- Git subprocessから`GIT_DIR`、`GIT_WORK_TREE`、`GIT_INDEX_FILE`等のrepository選択を変える
  環境変数を除去する。indexはworkspaceで`git rev-parse --git-path index`から解決し、
  common dir直下の固定`index`を使わない。Git stdoutとfileは上限+1 byteまでstreamで読み、
  全体を読んだ後に上限判定しない。
- 各fileは`O_NOFOLLOW`で開き、読取前後の`fstat`とpathの再`lstat`でsize／mtime／dev／ino、
  regular file、link count、root containmentを再確認する。このfingerprintは協調的writerによる
  driftの検出であり、外部processを停止するsnapshotや敵対的filesystemへの完全な隔離ではない。
- writerではTask write scopeを`scope_guard`として渡し、同scope内のignored regular fileもboundedで
  列挙・stream hashする。baseline後のindex bytes変更、ignored file集合／内容変更はscope内であっても
  `WORKSPACE_DRIFT`で拒否し、git操作や不可視成果物へ依存するRunをacceptしない。
- `admitted`、completed観測、acceptの各時点でworkspace kind、common dir、git dir、
  git-dir file ID、worktree rootを
  全面再解決し、記録時identityと不一致なら`WORKSPACE_DRIFT`。HEAD変化はidentityとは分け、
  baseline／completed fingerprint比較で扱う。
- fixed writerの予約後にHEADが変わった場合、予約HEADが現HEADの祖先で、間の全commit pathが
  Taskのread/write scopeに非交差、baseline／completedにstaged変更がなく、現indexが現HEADと一致して
  `assume-unchanged`／`skip-worktree`等の特殊path flagを持たない
  時だけ比較を続行する。ignored成果物と未commit差分は従来どおり検査する。非祖先、関連scope、
  staged/index不一致・特殊flag、path列挙不能は`WORKSPACE_DRIFT`。executor-isolatedのbase SHA固定は緩和しない。
- acceptanceは一度だけで、accepted／rejected間の変更を許さない。

## Consultation

ConsultationはWorker Runと別collection／別schemaにする。v26のconnectorは
`gpt-connector | claude-native | codex-sidecar`のclosed enum（未知connectorはfail closed。
enum追加は常に新schema versionを要する）。v25 manifestでは従来どおり`gpt-connector`固定・
`slug`文字列のままmutationも継続する（ADR 0045）。

```text
consultation_id, task_id, assignment_id, connector,
consultation_handle, model, effort, budget_reservation, state, executor_observation, decision_ref
terminal_evidence
```

- 任意のTaskを参照できる。TaskのeffectはConsultation自体のmutabilityを表さず、Consultationは常に
  workspaceとwrite capabilityを持たない。
- workspace、read/write scope、worker role、cancel、worker result、acceptanceを持てない。
- `consultation_handle`はconnector別exact shape:
  - `gpt-connector`: `{ "slug": "..." }` — caller既知のidempotency key。timeout後は同じslugを
    `sessions`で回収する（v25では同じ意味の`slug`文字列field）。
  - `claude-native`: `{ "session_id": "<lowercase UUID>" }` — Worker handleと同一validator。
    workspaceを持たず、同一session IDだけでresumeする。
  - `codex-sidecar`: `null`固定 — 同期read-only consultation（`codex_opinion`）はdurable handleを
    持たない製品契約のため、handleを捏造せずconsultation_id＋request相関で結果を照合する。
- v26の`effort`はconnector別に製品契約へ束縛する（`claude-native`: `low..max`、`codex-sidecar`:
  `low..xhigh`）。request builderがdispatchできないplanned recordを作らない。`gpt-connector`は
  v25 recordのmigrate互換のため従来どおりopaqueな文字列。
- 状態は`planned -> dispatched -> running | unknown | completed | failed`、
  `running/unknown -> running | unknown | completed | failed`。terminalは巻き戻さない。
  v27は`planned -> cancelled`を追加する（ADR 0054）: 新mutation `consultation-cancel`が
  親Decision証拠（`type=decision`）を必須とし、**証拠はtransition receiptだけが保持**、
  record本体はplanned同形（observation/decision_ref/terminal_evidence全て空）のまま。
  観測（`observeConsultation`）のstate enumに`cancelled`は無く、観測経由の偽装cancelは
  構造的に不可能。cancelledはterminalとして扱われ、同一assignmentの再相談は
  `failed | cancelled`の後に許可される。
- CLIは外部providerへ送信も再照会もしない。親が製品を再照会した観測だけを記録する。
- caller timeoutは全connectorで`unknown`。gpt-connectorは同一slugの`sessions`、claude-nativeは
  同一session IDのprocess状態で回収する。claude-nativeではstream-jsonの`type:result`を完了信号とし、
  process exitを完了信号にしない（backgrounded task残存中はprocessが生存する）。
- completed consultationは`decision_ref`を持てるが、Worker完成件数へ数えない。
- 同じ`assignment_id`の再相談は先行Consultationが`failed`の場合だけ許可する。
  nonterminalまたは`completed`が残る間は拒否し、独立した追加相談は別assignmentを使う。
  provider障害時の別provider切替は、元Consultationの`failed`終端後に新しいConsultationとして
  記録し、元の成功へ丸めず元のhandleを書き換えない。
- `failed`の`terminal_evidence`は所有製品のterminal状態を確認したdescriptorを必須とする。ただし
  `codex-sidecar`の同期consultには再照会入口が無く結果喪失時に製品terminal状態を取得できないため、
  connector条件付きで**caller側が観測したMCPエラー／timeout観測の`command`または
  `executor-receipt` evidence**を認める（ADR 0045 §7）。`unknown`のままtask finalizeが恒久ブロック
  される契約穴を作らない。

`observeConsultation`の`observation`はWorkerと共通の
`state, source, observed_version, observed_at, raw_state`だけを基礎fieldとし、`completed`だけ
`decision_ref`、`failed`だけ空でない`terminal_evidence`を追加できる。workspace、
result、acceptance、worker evidenceを持てない。保存する`executor_observation`は
source/version/time/raw_stateだけで、`decision_ref`はConsultation直下に保存する。
**観測はrecordへ相関束縛される**（O3 Phase監査採用指摘）: `source`はrecordの`connector`と
一致必須。optionalの`consultation_handle`を含む場合はrecordのhandle（v25は`{slug}`相当）と
完全一致必須で、`executor_observation`へは格納しない。adapter bridgeの出力はhandleを
含むため、bridge経由の観測は自動的にこの照合を受ける。

Consultationも`planned`ではobservation／decision／terminal evidenceが空、
`dispatched | running | unknown`ではobservationだけ、`completed`ではobservation＋decision ref、
`failed`ではobservation＋terminal evidenceだけを許可する。

## Schema migration（control-migrate）

version移動は暗黙に行わず、明示コマンド`control-migrate`だけが**隣接version間**で一回ずつ行う
（v25↔v26: ADR 0045／v26↔v27: ADR 0054／v27↔v28: ADR 0083／v28↔v29: ADR 0114。
隣接しない直行は`INVALID_TRANSITION`）。各方向は明示分岐で変換し、未定義の組をcatch-allで
別方向のrollbackとして扱わない。

- **v26→v27**: 取消済みTaskの孤児planned consultationを決定的に`cancelled`へ変換する
  （control-migrate receiptは既存不変量どおりevidence空＝変換の発生時点のみを証する。
  migration産cancelledは`consultation-cancel` receiptを持たない別形として正当）。
  他collection（placement reservationを含む）は一切書き換えない。
- **v27→v26 rollback**: `selector_decision`付きreservation、または明示cancelled
  （`consultation-cancel` receiptを持つcancelled）が1件でもあれば`ROLLBACK_UNSUPPORTED`。
  migration産cancelled（cancelled∧当該task取消済み∧cancel receiptなし）は決定的に`planned`へ
  復元し、v26ではADR 0053の除外が再び有効になる。分類不能なcancelledはfail loud。
- **v27→v28**: artifact descriptorを黙って書き換えず、そのまま移行する。既存の非版付きrefは
  読取可能だが、新しいgenerationのpredecessorには使えない。v28の新規artifactはdigest版付きrefだけを受理する。
- **v28→v27 rollback**: `artifact-generation-record` receiptが1件でもあれば`ROLLBACK_UNSUPPORTED`。
  generation未使用ならdescriptorを変えずに戻せる。
- **v28→v29**: top-levelへ`lane_admission: null`を物理追加する。admission束縛はinit専用であり、
  migrationは宣言を捏造しない——migration産のv29 Controlは恒久にnullを保つ（ADR 0114 Decision 4）。
- **v29→v28 rollback**: `lane_admission === null`（migration産）の場合だけkeyを削除して戻せる。
  non-null（init産）は`ROLLBACK_UNSUPPORTED`——宣言済みadmissionを黙って落とすことはできず、
  supported pathはv29 readerを残したまま新規利用を止めるbehavior rollbackである（ADR 0114 Decision 6）。
- **v29→v30**: 全stored taskへ`external_source: null`を物理追加する。null bindingはdigest正規化で
  キー不在と等価のため、admission_digestとpacket_digestは1つも変わらない＝走行中workerのreport回収を
  migrationが破壊しない（ADR 0116 Decision 2）。
- **v30→v29 rollback**: 全taskの`external_source`が`null`の場合だけkeyを削除して戻せる。非null
  bindingが1件でもあれば`ROLLBACK_UNSUPPORTED`——受入に束縛された相関証拠を黙って落とせない
  （ADR 0116 Decision 3）。

- 決定的変換: 各consultationの`slug: s`→`consultation_handle: { slug: s }`。connectorは既存の
  `gpt-connector`のまま、他collectionは不変。`record_revision`を+1し、transition receiptへ
  `operation="control-migrate"`とfrom/to schema version（`previous_state`／`next_state`）を記録する。
- finalized／archivedのControlはmigrateしない（歴史はそのversionのまま読む）。finalizedは
  `CONTROL_FINALIZED`、archivedは`RECORD_ARCHIVED`で拒否される。同一versionへのmigrateは
  `INVALID_TRANSITION`。
- receipt容量上限（256）近傍ではclosing slot予約により`CONTROL_CAPACITY_RESERVED`でfail loudに
  拒否される。架空の空きを作らない。
- v26→v25 rollbackは、**非`gpt-connector` consultationが1件も存在しない場合に限り**決定的に可能
  （`consultation_handle:{slug}`→`slug`）。1件でも存在すれば`ROLLBACK_UNSUPPORTED`でfail loudにし、
  silent degradeやhandle捨てを行わない。rollbackも`control-migrate`の明示operation（方向指定）で、
  transition receiptへ記録する。
- rollbackの範囲はdata-planeに限る。rollback後manifestにもmigrate系receiptは恒久に残り、store内に
  v26 manifestが1つでも存在する限り、v26実装前のコードは（全manifest scanのため）無関係なv25
  Controlの操作も含めて動作しない。実装コミット自体のrevertはv26 manifest・migrate receiptが
  1件も生まれる前にのみ安全で、以後の後退はdata-plane rollback＋前方修正で行う。
- 実施はControlごとに親が裁定し、多provider consultationを実際に記録する直前まで行わない。

## Global mutation transaction

全mutationはgit common dirごとの一つのlock内で行う。

1. state rootとlockの種類・permission・symlinkを検査する。
2. random tokenのprivate pending fileを`wx`で作り、完全なowner JSONを書いてfile sync後、
   `lock-owners/<token>.owner`へatomic renameしowner directoryをsyncして公開する。取得走査は完成した`.owner`だけを見る。
   全owner fileを再走査し、自分以外が1件でもあれば、live/deadを問わずfail closedにして
   自分のowner fileだけを削除する。複数contenderが同時作成された場合は全員失敗してよい。
3. 全active manifestをbounded readし、strict validationする。不正manifestが一つでもあればfail closed。
   実際には`controls/`直下の全entryを列挙し、各entryがsymlinkでないdirectory、その直下の
   `manifest.json`がsymlinkでない通常fileであることを確認して全manifestをstrict validationした後、
   statusでactive／archivedを分類する。未知entry、manifest欠損、読取中の1 MiB超過を拒否する。
4. 対象manifestの`record_revision == expected_revision`を確認する。
5. Task／assignment重複、全予約済みwriterのscope/worktree競合、合法遷移を再検査する。
6. 新Controlはcontrol directory作成後に親`controls` directoryをsyncする。mutationを適用し、
   同一directoryのprivate temp fileへ完全JSONを書いてfile sync後にrenameする。
7. POSIXはcontrol directoryもsyncする。Windows ACL／directory syncは未検証なので成功へ丸めず
   `PLATFORM_UNVERIFIED`で停止する。
8. 自分のtokenとowner file本文が一致する場合だけ、その一意なowner fileをunlinkし、owner directoryをsyncする。

ownerの回収と通常解除は、`O_NOFOLLOW`で開いたfdを`fstat`し、通常file・link count 1を確認して
bounded readする。unlink直前に再`lstat`し、fdとdev／ino／link countが一致する時だけ削除する。
PIDはpositive safe integerだけを許し、`process.kill(pid, 0)`成功と`EPERM`はlive、`ESRCH`だけを
deadとする。その他はfail closedにする。

manifest rename後にdirectory sync等が失敗した場合、旧状態へrollbackしたふりをしない。
対象manifestを再読して期待revisionと内容digestが一致して見えてもdurabilityは証明できないため、
`COMMIT_OUTCOME_UNKNOWN`でcallerへ`status`による再読を要求する。lock publish失敗は同一ownerを
検証して除去し、releaseのunlink後sync失敗は`LOCK_OUTCOME_UNKNOWN`として偽成功にしない。
manifestの`durability`は固定protocol snapshotであり、filesystemの永続性を意味判定した証明書ではない。

owner fileは1 KiB以下のexact JSONとし、未知keyを拒否する。

```json
{
  "schema_version": "dotagents.orchestration-lock-owner.v1",
  "token": "UUID",
  "pid": 12345,
  "acquired_at": "2026-07-14T00:00:00.000Z"
}
```

`conflict-check`は参考表示であり予約ではない。write Runの`admitted`遷移時に同じlock内で必ず再検査する。

### Lock recovery

- 自動stale lock削除を行わない。
- lock競合エラーはowner fileのtoken、PID、取得時刻だけを返す。prompt、cwd、commandを含めない。
- `recover-lock --expected-token <token>`は厳密に
  `lock-owners/<expected-token>.owner`だけを対象にし、本文token一致、通常file、link count 1、
  owner PID不在を確認できる場合だけunlinkする。live／EPERM／malformed／symlink／hardlinkを拒否する。
- UUID tokenは再利用しない。recoveryは固定lock pathをcheck→unlinkせず、観測した一意owner file
  だけを削除するため、新ownerを消すABAを起こさない。

## Docs artifact projection

Finding／Approach／Gap／Decisionの意味と本文はdocs artifactが正本であり、Controlは
`artifact_id / artifact_kind / artifact_ref / artifact_digest / status`だけを持つ。kindは
`finding | approach | gap | decision`、statusは親が明示する`current | closed | superseded`である。
record時とstatus更新時に安全なbounded readでSHA-256を再計算し、path・digestの不一致、欠落、symlink、
非regular fileを拒否する。refとdigestは不変で、内容更新は新IDで記録する。本文、severity、票数、
semantic dedup、関連候補は保存しない。`shared_artifact_ids`は同一Controlのfindingだけを参照できる。
v28の新規`artifact-record`はSHA-256全文をbasenameへ含む版付きrefだけを受理する。同じ論理artifactの
世代交代には`artifact-generation-record`を使う。旧・新refは各SHA-256全文をbasenameへ含む別path、
新artifact ID、同じkind、異なるdigestでなければならない。入口はglobal lock内で両方の通常fileとdigestを
検証し、旧currentの`superseded`と新currentのdescriptorを`dotagents.artifact-generation.v1` digestへ
結合した単一receiptを同じ1 revisionへ記録し、manifestを1回のatomic renameでcommitする。したがって中間状態は
公開されず、旧版byte列を保持したままcurrentが切り替わる。旧版を先に上書きした場合は履歴や別pathへ
fallbackせず`ARTIFACT_DIGEST_MISMATCH`でfail closedし、同一版付きpathへexact byte列を復元してから再試行する。
新規placement／manual Worker record、planned admission、Delegation Packet生成では参照先本文のdigestを
再検証する。bare repositoryでもtree modeを確認し、regular blob以外を受理しない。
Findingの実在性・価値、semantic dedup、独立性の充足は親AIがdocs正本と実証を読んで裁定する。
Controlは票数、quorum、severity、semantic score、independence scalarをtruthとして受理しない。

## Approach family governance

親が明示recordしたfamilyだけへ、既存Budgetの`max_runs_per_approach_family`に加えてblock/reopen gateを
適用する。未登録familyはこの追加gate上では既存互換であり、blockは既存Run stateを変更せずcancelも行わない。

- recordは`approach_family_ref`と既存exact `context_policy`をsnapshotする。placement candidate、manual
  Worker record、planned Worker admissionはRun lineageのpolicyと完全一致しなければ拒否する。
- blockは`kind=decision`の親Decision artifact IDと、`approach | gap | decision`のbasis artifact IDを
  1件以上要求する。block後は同familyの新規placement、manual Worker record、admissionを拒否する。
- reopenは親Decisionと、block時basisに含まれない新しいbasis artifact IDを1件以上要求する。semanticな
  新規性、dedup、票数、本文の裁定は親が保持する。再blockは許可せず、一回のblock→reopen cycleに限定する。
- record/block/reopenはtyped receiptのsubject digestへsnapshotを結合する。artifact本文を複製せず、
  artifact ID／kind／document digestの実在性だけを検査する。

## Advisory snapshot

`advisorySnapshot({ cwd, evaluated_at })`はactive Controlだけを横断するread-only projectionであり、
manifestやreceiptを更新せず、provider／network／cancelを実行しない。Controlがまだ一件もなければ
空snapshotを正常に返す。出力は`orchestrate.advisory-snapshot.v1`の
`active_control_ids`、unknown／uncollected Run ID、write conflict、機械判定可能なH参照不足、latest
Registry由来のcapacity warning、`truncated`だけを持つ。各配列はcanonical sortかつ256件上限である。

- unknownとuncollectedは`status --brief`と同じstate意味論を使う。
- write conflictはtask-cancel済みを除くplanned writerをcandidateとして、既存reserved writerとの
  既存scope/worktree conflictだけを示す。reserved同士やplanned同士は警告へ重複しない。
- H Taskへの`consultation-record`は、Consultation専用operation digest契約がv1に存在しないため
  `CONSULTATION_OPERATION_CONTRACT_MISSING`でfail-closedする。legacy/tamperのH Consultationも
  planned→dispatchedを同じ理由で拒否する。read互換として既存のnonterminal H Consultationは
  `consultation-operation-contract-missing`を出す。
- H gapはplanned/admitted Worker、または既存nonterminal ConsultationがあるH Taskのexpired approvalと、
  planned/admitted Workerのoperation digest null/mismatchだけを示し、terminal/historyだけの期限切れや
  承認の真正性は裁定しない。
- capacity warningはexecutor/workflow scopeごとのevaluated時点latest Registryから、ambiguous、expired、
  admission unknown、limit unknown、soft/hard reachedだけを示す。latest/supersedeの選定はarchivedを含む
  全manifest、reservationはactive ControlのRunだけを用いる。

## CLI境界

初期CLI `orchestrate-run` は次の記録・純粋検証だけを行う。

```text
init, status, status --brief, resume-check, advisory-snapshot, control-migrate, task-record, task-cancel-record, registry-observation-record, placement-dry-run, placement-reserve, delegation-packet, delegation-packet-recover, worker-report-import, worker-run-record, consultation-record, campaign-record, campaign-status, campaign-release, phase-gate-record, phase-gate-status, phase-gate-advance, artifact-record, artifact-status, artifact-status-record, artifact-generation-record, approach-family-record, approach-family-status, approach-family-block, approach-family-reopen,
admit-worker, worker-workspace-bind, worker-cancel-request, observe-worker, observe-consultation, consultation-cancel, conflict-check,
accept, reject, task-finalize-record, control-finalize, recover-lock, archive,
quota-pool-lock-acquire, quota-pool-lock-release, lane-admission-evaluate
```

- `--help`は`contract_version: "dotagents.orchestrate.control-record.v2"`を返す。v2は`init`の必須入力へ
  `lane_admission`を加えた破壊的変更であり、v1形式のinit入力は`CONTRACT_VERSION_MISMATCH`で明示拒否する
  （暗黙defaultで補完しない。ADR 0114 Decision 7）。
- `lane-admission-evaluate`はfilesystem・git・state・cacheへ一切触れない純粋評価で、
  `normal | orchestrated`の評価結果だけをstdoutへ返す。通常レーンの必須手順にしない（ADR 0114 Decision 8）。
- mutation commandは`actor_id`と`expected_revision`を必須とする（init／recover-lockを除く）。
- CLIは`orchestrate-run <command> --input <json-file>`と
  `orchestrate-run status --brief --input <json-file>`だけを受理する。`--help`以外の
  positional、未知option、重複option、余剰引数をexit 2で拒否する。input fileは各APIの
  object引数そのもので、64 KiB以下の通常fileかつsymlinkでないことを必須とする。
- 成功時はstdoutへ`{ "ok": true, "command": "...", "result": ... }`を1行だけ出す。
  例外として`resume-check`のみ、`result`より前に
  `"summary": { "outcome": ..., "blocking_count": ..., "review_count": ... }`を含む4-key envelopeを出す
  （長大なresult末尾のoutcome誤読を防ぐ実被弾対策。既存キーの名称・順序・意味は不変で、
  他コマンドのenvelopeへは波及させない）。
  失敗時はstderrへ`{ "ok": false, "code": "...", "message": "..." }`を1行だけ出し、
  引数／入力schema違反はexit 2、競合・状態・filesystem・git失敗はexit 1とする。
- provider command、network、dispatch、poll loop、cancel、retry、worktree生成、branch切替、commit、
  push、merge、deploy、H操作を行わない。
- input JSONは64 KiB、manifestは1 MiB、配列・文字列・handleをbounded exact schemaで検証する。
- nonterminal集合はWorkerが`planned | admitted | dispatched | running | unknown`、Consultationが
  `planned | dispatched | running | unknown`。予約済みwriterはWorkerの
  `admitted | dispatched | running | unknown`と定義する。
- `finalizeControl`はnonterminalが0、completed Workerが全件accepted/rejected、completed Consultationが
  全件`decision_ref`を持ち、全Campaignが親release済みで、全Taskが後述のterminal parent decisionを
  持つ場合だけ許可する。さらに
  objective（初期宣言を固定参照）、受入matrix、1件以上の最終監査evidence、1件以上の回帰evidence、
  1件以上のknowledge return参照、`type=decision`の親最終Decisionをexact objectとして保存する。
  受入matrix、最終監査、回帰、knowledge return、親Decisionはrepo内の実在する通常fileに限定し、
  finalize時にSHA-256を再計算する。matrix／knowledgeの生成descriptorを含む全要素をfinalize receiptへ
  固定順で結合し、archive直前にも全Task／Control finalization文書を再hashする。過去の
  `type=decision`だけは、現内容が変わっていても同一repoの最大256 commitにある同一path・regular blob・
  完全一致SHA-256を合計64 MiB以内で確認できれば保持済みとする。`type=file`、別path、近似一致、unsafeな
  現path、bare repoへこの履歴保持を拡張しない。
- `archive`は上記Control-level finalizationが存在する場合だけ許可する。個別Task finalizationだけでは
  archiveできない。Control-level finalization後はarchive以外を拒否し、archive後はread-only。

## Library APIとerror code

純粋関数`validateManifest`、`normalizeScope`、`scopesOverlap`、
`workerReportTemplateForPacket(packet)`は同期関数とする。後者はstrict
`dotagents.delegation-packet.v1`を検証し、対応するWorker Report templateを返す。git／filesystemへ
触れる以下の関数はすべて`Promise`を返し、暗黙に`process.cwd()`を使わず、入力objectの
`cwd`を必須とする。

```text
init({ cwd, control_id, objective_ref, actor_id, document_refs, budget, lane_admission, predecessor_control_id? })
laneAdmissionEvaluate({ conditions })
status({ cwd, control_id })
statusBrief({ cwd, control_id })
advisorySnapshot({ cwd, evaluated_at })
resumeCheck({ cwd, control_id })
taskRecord({ cwd, control_id, actor_id, expected_revision, task })
taskCancelRecord({ cwd, control_id, actor_id, expected_revision, task_id, decision })
registryObservationRecord({ cwd, control_id, actor_id, expected_revision, observation })
placementDryRun({ cwd, control_id, task_id, evaluated_at, candidates })
reservePlacement({ cwd, control_id, actor_id, expected_revision, task_id, candidate, review_decision })
workerRunRecord({ cwd, control_id, actor_id, expected_revision, worker_run })
consultationRecord({ cwd, control_id, actor_id, expected_revision, consultation })
controlMigrate({ cwd, control_id, actor_id, expected_revision, target_schema_version })
campaignRecord({ cwd, control_id, actor_id, expected_revision, campaign })
campaignStatus({ cwd, control_id, campaign_id })
releaseCampaign({ cwd, control_id, actor_id, expected_revision, campaign_id,
                  audit_evidence, decision })
phaseGateRecord({ cwd, control_id, actor_id, expected_revision, risk, behavior_lane })
phaseGateStatus({ cwd, control_id })
phaseGateAdvance({ cwd, control_id, actor_id, expected_revision,
                  phase, state, evidence, decision })
artifactRecord({ cwd, control_id, actor_id, expected_revision, artifact })
artifactStatus({ cwd, control_id, artifact_id })
artifactStatusRecord({ cwd, control_id, actor_id, expected_revision, artifact_id, status })
artifactGenerationRecord({ cwd, control_id, actor_id, expected_revision,
                           superseded_artifact_id, artifact })
approachFamilyGovernanceRecord({ cwd, control_id, actor_id, expected_revision,
                                 approach_family_ref, context_policy })
approachFamilyStatus({ cwd, control_id, approach_family_ref })
approachFamilyBlock({ cwd, control_id, actor_id, expected_revision,
                     approach_family_ref, decision_artifact_id, basis_artifact_ids })
approachFamilyReopen({ cwd, control_id, actor_id, expected_revision,
                      approach_family_ref, decision_artifact_id, basis_artifact_ids })
delegationPacketForWorker({ cwd, control_id, worker_run_id })
recoverDelegationPacketForWorker({ cwd, control_id, worker_run_id })
admitWorker({ cwd, control_id, actor_id, expected_revision, worker_run_id })
bindWorkerWorkspace({ cwd, control_id, actor_id, expected_revision, worker_run_id,
                      workspace_cwd, provider_binding, binding_evidence })
requestWorkerCancel({ cwd, control_id, actor_id, expected_revision, worker_run_id, decision })
observeWorker({ cwd, control_id, actor_id, expected_revision, worker_run_id, observation })
importWorkerReport({ cwd, control_id, actor_id, expected_revision, worker_run_id, report })
observeConsultation({ cwd, control_id, actor_id, expected_revision, consultation_id, observation })
consultationCancel({ cwd, control_id, actor_id, expected_revision, consultation_id, decision })
conflictCheck({ cwd, control_id, proposed_worker_run? })
accept({ cwd, control_id, actor_id, expected_revision, worker_run_id,
         result_digest, verification_evidence, decision_note, decided_by })
reject({ cwd, control_id, actor_id, expected_revision, worker_run_id,
         result_digest, verification_evidence, decision_note, decided_by })
taskFinalizeRecord({ cwd, control_id, actor_id, expected_revision, task_id,
                     finalization_ref, recorded_by })
finalizeControl({ cwd, control_id, actor_id, expected_revision,
                  acceptance_matrix_ref, final_audit_evidence, regression_evidence,
                  knowledge_return_refs, parent_decision, finalized_by })
recoverLock({ cwd, expected_token })
archive({ cwd, control_id, actor_id, expected_revision })
fingerprintWorkspace({ cwd })
```

`init`だけがControlを新規作成し、gitからproject root、common dir、git dir、HEAD、dirtyを
解決する。既存`control_id`を上書きせず`CONTROL_EXISTS`で拒否する。その他は`cwd`から得た
common dirの既存Controlだけを読む。成功したmutationは
`{ manifest, revision: manifest.record_revision }`、`status`はvalidated manifest、
`conflictCheck`は`{ conflicts }`、`recoverLock`は`{ recovered, token }`を返す。

`cwd`は既存directoryへの絶対pathまたはcaller基準で解決可能なpathとし、libraryが`realpath`を
取り、そこを`git -C`の唯一の入口にする。linked worktreeでは`--show-toplevel`、
`--absolute-git-dir`、`--git-common-dir`を個別に解決し、gitfile文字列をdirectoryとして扱わない。
Controlの検索単位は常にcommon dirであり、mainとlinked worktreeのどちらから呼んでも同じ
manifest集合を読む。Workerの`workspace_cwd`は別途同様に解決する。

library errorは`ControlRecordError`で、安定した`code`を持つ。少なくとも次をv1契約とする。

```text
INVALID_INPUT, INVALID_SCHEMA, INVALID_SCOPE, LIMIT_EXCEEDED,
NOT_GIT_REPOSITORY, BARE_WRITE_FORBIDDEN, CONTROL_EXISTS, CONTROL_NOT_FOUND,
REVISION_CONFLICT, RECORD_ARCHIVED, DUPLICATE_ID, INVALID_TRANSITION, DEPENDENCY_NOT_READY,
CAMPAIGN_NOT_RELEASED, CAMPAIGN_NOT_READY,
ASSIGNMENT_ACTIVE, WRITE_CONFLICT, EXECUTOR_FORBIDDEN, ADAPTER_UNKNOWN, CAPABILITY_MISMATCH,
VERIFICATION_REQUIRED, BUDGET_UNKNOWN, BUDGET_EXCEEDED,
EVIDENCE_REQUIRED, EVIDENCE_UNAVAILABLE, EVIDENCE_DIGEST_MISMATCH, WORKSPACE_DRIFT, ARCHIVE_NOT_READY,
FINALIZATION_NOT_READY, CONTROL_FINALIZED,
TASK_FINALIZED,
APPROVAL_MISMATCH, APPROVAL_EXPIRED,
ROLE_EFFECT_FORBIDDEN,
SCHEMA_UPGRADE_REQUIRED, ROLLBACK_UNSUPPORTED,
CONTROL_CAPACITY_RESERVED, CONTROL_CAPACITY_REACHED, CONTINUATION_NOT_READY,
PLATFORM_UNVERIFIED, DECISION_EVIDENCE_NOT_IMMUTABLE,
LOCK_OUTCOME_UNKNOWN,
LOCK_CONTENDED, LOCK_MALFORMED, LOCK_LIVE, LOCK_NOT_FOUND, LOCK_TOKEN_MISMATCH,
STATE_PATH_UNSAFE, INPUT_PATH_UNSAFE, COMMIT_OUTCOME_UNKNOWN, IO_FAILURE, GIT_FAILURE
```

未知の内部例外を成功や`INVALID_INPUT`へ丸めない。CLIは既知codeを保持し、未知例外だけ
`INTERNAL_ERROR`として非0終了する。

## Parent Task finalization reference

`task_finalizations`はdocs正本上のTask裁定を指す参照だけを持ち、汎用Decision engineにしない。

```text
task_id, finalization_ref, recorded_by, recorded_at
```

- `finalization_ref`の意味・outcome・reasonはdocsが所有し、Control Recordは解釈しない。ただし実在と
  SHA-256をfinalize時に検証し、`type=decision` evidenceとrecord exact objectをimmutable receiptへ結合する。
- 新しい`finalization_ref`とControl-level `parent_decision.ref`は`docs/adr/<file>.md`だけを受理する。
  可変plan/TODOや別pathは`DECISION_EVIDENCE_NOT_IMMUTABLE`で拒否する。既存manifestはread／archive互換のため
  暗黙migrationせず、過去の同一path・同一blob保持契約も変更しない。
- 一つのTaskへ参照は1件だけ。取消済みTask、nonterminal Run／Consultation、親未裁定completed Workerを
  持つTaskはfinalizeできない。finalize後は新規Worker／Consultationを追加できない。

archive判定は次のtruth tableを満たす時だけ`active -> archived`へ一度だけ進める。

| 対象 | archive可能条件 |
|---|---|
| Worker | nonterminalが0。`completed`はacceptance必須。`failed/cancelled`はacceptance不要 |
| Consultation | nonterminalが0。`completed`は`decision_ref`必須。`failed`はdecision ref不要 |
| Campaign | 全件が親release済み。audit-required Campaignはaudit evidenceと親Decision必須 |
| Task | 全Taskにdocs正本上のfinalization参照またはcancel Decisionが1件あり、対応Run／Consultationが全件terminal、completed Workerは親裁定済み |
| Manifest | statusが`active` |

unknown、planned、admitted、未release Campaign、finalization／cancel DecisionなしTask、completed未受入Worker、
completed未裁定Consultationのいずれかが
一件でもあれば`ARCHIVE_NOT_READY`で拒否する。

## MVP非目標

- dynamic discovery、scheduler、score、capacity allocation、daemon型barrier、DAG、retry DSL。
- adapter共通interface、自動dispatch/poll/cancel/follow-up。
- Finding／Decision／Approval engine、独立性score、多数決、quorum。
- append-only event log、SQLite、汎用migration framework、hook統合、daemon、Web UI。
