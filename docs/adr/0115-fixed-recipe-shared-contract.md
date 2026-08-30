# ADR 0115: 固定Recipeのhost共通契約を固定する

- Status: accepted
- Date: 2026-07-24
- 裁定者: 統括レーンの親（bell-claude）がFとして固定＋Codex旗艦(`gpt-5.6-sol`)×high refuter 3レンズによる反証1回
- 関連: [ADR 0113](0113-composable-orchestration-invariants.md)（4不変Decision）、
  [ADR 0114](0114-typed-lane-admission-contract.md)、[計画](../archive/plan_composable-orchestration.md)「固定Recipe」節、
  [委譲契約](../../shared/orchestrate/delegation-contract.md)、[Executor adapter契約](../../shared/orchestrate/executor-adapters.md)
- 工程: Lattice `dotagents` / plan `factory-master` / task `fm-0664`（Wave 1）

## Context

固定Recipe二型（`adversarial-audit`／`bulk-curation`）の意味は現在Claude skillのMarkdown内JS雛形だけに
存在し、Codex側にはPhase・入出力schema・reducer・gateの定義が無い。discovery調査は6観点すべてを
「入口差ではなく意味差」と判定した。また初案への反証は、retry所有の矛盾、終端分類の非排他、
Latticeなし実行経路の欠落、Control-free回収契約の欠落、投影による意味複製の5点を致命傷として示した
（[記録](../evidence/2026-07-24-wave1-discovery-and-refutation.md)）。

## Decision

### 1. `shared/orchestrate/recipes.md`を二型の意味の唯一の正本とする

host非依存・製品非依存の静的契約として、各型のPhase名と順序・入力contract・並列化意図・出力schema・
reducer（集約規則と完全性検算）・gate（合否）・失敗条件を所有する。対象は現行二型だけとし、
第三の型を追加しない。

配布先のhost skillから参照できる自己完結した生成物を、各skillの
`references/shared-orchestrate/`へ置く。共通正本と依存文書からgeneratorで作り、driftをCIで拒否する。
skillディレクトリをsymlink配布した後に`..`でsymlink外へ抜ける参照は使わない。Windowsではその参照が
配布先の字句上の親へ解決され、repo内だけで成立する`../../../shared/`が読めないことを実測したためである。

### 2. 実行結果は二軸で表現し、集約判定を固定する

単一軸の終端分類は採らない（失敗状態とpayload件数は別軸であり、同時成立するため）。

- 子の実行状態: `completed | failed | unknown`
- 結果payload: `empty | nonempty`（`empty`は正常な0件であり失敗ではない）
- Recipe集約: `success | partial_failure | failure | pending`

全体gateは「`unknown`が0 ∧ `failed`が0 ∧ 集約が`partial_failure`でない ∧ 型ごとの完全性検算が成立」
とする。完全性検算は、`adversarial-audit`では全finding idが`merged_ids`へ現れること、`bulk-curation`では
全TARGETが終端していること。`partial_failure`を`success`へ、`empty`を`failure`へ丸めない。

timeoutと外部中断は`unknown`とし、host固有handleの正規入口で回収する。Recipeは`unknown`の観測投影
だけを定め、時間値・再送・provider切替・attempt終了を所有しない。

### 3. Recipeはretryもloopも所有しない

- Recipe-level automatic retryを定義しない。provider retryの正本はExecutor製品、正式reject後の再試行は
  Controlの新規Worker Runであり、この所有を動かさない（ADR 0113 Decision 3）。
- 汎用`max_rounds`・条件付き反復・任意回数を契約化しない。`adversarial-audit`のCritic第2ラウンドは
  「高々1回の明示的な第2 Find→Dedup→Verify→Critic」として静的に展開する。
- 最大並列度は静的な上限値としてだけ持てる。hostは能力に応じてそれ以下で実行してよく、shared側に
  queue・slot・再投入・進捗stateを持たせない。

### 4. LatticeなしでもControlなしでも実行できる（単体成立）

- Recipe入力はtargetごとのrepo identity・effect（read/write）・scopeをclosedに持つ。同一repoへの
  writerが複数になる実行は、Latticeが選択されていなければ**決定的に直列化**する（並列度1へ落とす）。
  read-onlyのfan-outはこの制限を受けない。これはADR 0113 Decision 4のdegraded modeの適用であり、
  親の自前交差判断による並列強行を認めない。
- Recipe固有のterminal result schemaを一次出力とし、通常レーンではそれを直接親へ返す。strict Worker
  Reportへの投影は、Controlが既に選択されている場合だけのoptional adapterとして別定義する。
  現行Claude雛形の「重い型は統括レーン限定」という位置づけはこの境界に合わせて改める
  （型の使用はレーンを問わず、Control儀式だけが統括レーン専用——ADR 0061の技法と儀式の分離）。

### 5. 投影のdriftは機械gateで防ぐ

sharedはRecipeごとのversioned machine-readable schema（canonical JSON）とcanonical fixtureを所有する。
Claude雛形のJS内schema literalは、shared canonical JSONとの機械的一致をfocused test（CI gate）で
検証する。人が見比べて転記する構成を「唯一の正本」の実装として認めない。

このgateはtestであり、共通runner・DSL・durable state machineではない。実行時にschemaを解釈・変換する
機構を作らない。

### 6. host adapterは実行入口だけを所有する

- Claude: Workflow toolへの写像（`phase()`／`parallel()`／`agent()`、label・schema引数、model/effort解決）。
- Codex: native sub-agentのfan-outと回収、aiterm laneの完了受信、Control選択時のReport対応。
- 両adapterは意味（Phase・schema・reducer・gate・失敗条件）を再定義しない。

### 7. rollback単位は三面同時とする

`shared/orchestrate/recipes.md`と両host adapterの参照は同一commit単位で導入・撤回する。
shared正本だけを撤回してadapterに壊れた参照を残さない。

## Consequences

- 二型の意味がhost間で一致し、cross-host同値の受入（計画の方針受入5）が検証可能になる。
- 通常レーンでもControl/Latticeなしで二型を実行でき、単体成立（計画の単体成立1）が保たれる。
- Recipe実装がretry/loop言語へ滑る経路が契約で塞がれ、非目標（汎用workflow engine）に抵触しない。
- fm-0664の実装は本ADRのDecision 1〜7を受入条件として検証される。
