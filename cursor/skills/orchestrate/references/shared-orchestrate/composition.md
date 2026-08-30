<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Sources: shared/orchestrate + docs/02_models.md + lib/orchestrate/lane-admission.mjs + claude/skills/orchestrate/references/workflow-templates.md -->
<!-- Regenerate: node bin/render-orchestrate-skill-references.mjs --write -->
# 実行経路の合成契約 — 適用方針の唯一の正本

この文書は、通常レーンの固定Recipe・Control direct・Lattice standalone・Lattice不能時の明示直列化という
四つの実行経路を、**同じ適用方針**へ接続する（ADR 0113 / ADR 0122）。所有するのは「いつ何を付加するか」と
「同一repo writerをいつ直列化するか」だけで、各経路の内側の意味は所有しない——固定Recipe二型の意味は
[recipes.md](recipes.md)、統括レーンのControl儀式は[contract.md](contract.md)、委譲の最低安全契約は
[delegation-contract.md](delegation-contract.md)、Lattice本体の契約はLattice製品repoが正本である。

レーン裁定（`normal | orchestrated`）はADR 0061の4条件ORだけが決め、本書は変えない。実行経路はレーンと
直交する補助軸であり、第三のレーンにも新しい永続stateにもしない。

## 四つの経路と単体成立

| 経路 | 所有するもの | 必須にしないもの |
|---|---|---|
| 固定Recipe | Phase・入出力schema・reducer・gate・失敗条件 | Lattice、Control |
| Control direct | F/A/H・placement・親accept/reject・finalization | Lattice |
| Lattice standalone | Task DAG・Phase・ready・compile・run・子dispatch | dotagents、Control |
| 明示直列化 | 並列を断念した事実と理由 | — |

**単体成立が最上位制約である**（ADR 0113 Decision 1）。どの経路も、他製品が未導入・停止・非互換でも自身の
公開契約を完結させる。連携障害は連携による増幅能力だけを止め、無関係な単独機能を止めない。相手製品の
DB・管理directory・内部moduleは読まず、公開CLIとversioned schemaだけを使う。

判定コードは相手製品を型で必須にしない。直列化判定の正本
`lib/orchestrate/execution-path.mjs`（`dotagents.execution-path.v1`）はLattice読取moduleをimportせず、
Latticeの状態を`lattice_selected`のboolean一つとしてだけ受け取る。非依存はテストではなくAPI境界の型が保証する
（[lane-admission](lane-admission.mjs)と同型）。

LatticeとControlを繋ぐ2 moduleも同じ規律に従う。どちらもI/Oを持たず、呼び出し側が取得済みのJSON値
だけを受け取るpure moduleであり、`lattice-projection.mjs`をimportせずCLIをspawnしない。

- `lib/orchestrate/lattice-receipt-projection.mjs`: Lattice子receiptをControlのstrict Worker Report断片へ
  bounded projectionし、scope・digest・partial failure・dispatch ownerをtyped reasonで判別する。
  帰属照合の基準はdispatch記録であってexecutorの自己申告ではない。
- `lib/orchestrate/lattice-control-saga.mjs`: ready選択→Control placement→Lattice run start→子受入→
  工程反映の次の一手を、3つのdurable state（Lattice工程status・run list・Control manifest）の観測から
  計算する。**進行状態をどこにも保存しないため、再実行がそのままrecoveryになる。**
  冪等キーは観測値から導出する決定的な値で、時刻・乱数に依存しない。

## 能力の付加

| 必要な能力 | 付加するもの | 付加しないもの |
|---|---|---|
| 既知の定型手順 | 固定Recipe | 汎用workflow engine、独自run store |
| 永続Task DAG／Phase／ready frontier | Lattice TODO | ControlへのDAG copy |
| 同一repoへ2つ以上のwriterを並列投入 | Lattice compile/run | 親の自前scope推測 |
| F/A/H、placement、親受入、監査証跡 | Control | LatticeへのControl state copy |
| 単純な直接作業 | 親の通常実行 | Lattice plan、Control |

付加は必要になった時だけ行う。agent数・repo数・Phase数・固定Recipe内のfan-outは、どれも付加の理由に
ならない。

## 同一repo writerの直列化（全経路共通・唯一の正本）

判定はwriter集合とLattice選択の有無だけで決まり、経路によって変わらない。

本書でいう並列作業は、独立した複数ToDoを複数workerへ同時dispatchして実行することである。本体実装1件と
その監査、親の作業とread-only観測、同一ToDo内の補助調査は、「複数ToDoの並列化を実施した」証拠にしない。

- **read-onlyのfan-outは制限を受けない**。並列度の上限は各経路が静的に持てるだけとする。
- **同一repoへ書込むwriterが2つ以上あり、Latticeが選択されていない実行は、決定的に直列化する**。
  親の自前交差判断による並列強行を認めない（witness無しの「交差しないはず」が事故の源）。
- **repo外対象（`repo_root: null`）のwriterが2つ以上ある場合も直列化する**。repo identityが無い対象同士は
  交差の有無を判定できないため、判定不能を並列可へ丸めない。
- Latticeが選択されている場合だけ、同一repoの複数writerを並列投入できる。**並列投入してよい根拠は、
  `lattice todo independence`が返す検証済みparallel groupだけとする**。`unknown`（未検査）・`stale`・
  記録なしは「競合が無い」を意味しない——依存線の不在は順序制約の無申告であって、書き込み境界の
  非干渉ではないからである（Lattice ADR 0127）。判定材料が無い組は直列側へ倒す。
  判定を宣言するのはToDoごとのwitness setであり、その誠実さが判定の上限になる。
  runtime面（`plan compile`の競合検出）は同じ境界規律をrun経路で適用する面であり、
  工程レーンの根拠はtodo independenceが持つ。
- **Latticeが利用不能またはfail closed（例: `INVALID_RUN_STORE`）の時は、同じ規則で直列化する**。これは
  暗黙のfallbackではなく、機能と安全性を明示したsupported degraded modeである（ADR 0113 Decision 4）。
  断念した事実と理由は、統括レーンならControl記録、通常レーンならplanまたは工程正本へ一度残す。

直列化はWIP上限を理由に選ばない。依存・scope競合・隔離不能・実capacity不足という当該frontier固有の
理由だけが直列の根拠になる（[delegation-contract.md](delegation-contract.md)「WIPとの関係」）。

## 経路の切替とrollback

連携（Control外部Task binding、Lattice projection）を止めても、各経路の従来公開入口は維持される。
rollbackはadapterとoptional bindingの新規利用を止めるだけで、Lattice／Controlのowner storeは移動も変換も
しない。開始済みrunやunknown handleがある間はschema／adapterを切り替えず、同じversionで回収または
abandonする。
