# SessionStart hookを統合入口へ切り替え、並列可否を届ける

工程の正本はdotagents Lattice store（plan key `lattice-session-context-hook`）である。
本書は目的・思想・判断理由・非目標・受入条件を所有し、ToDoの状態と依存は持たない。

## Context

SessionStart hookが出す「Lattice工程表」のINFOは、**dotagents自身のprojectでは毎回捨てられている**。
実測でhook全体が6.7〜7.8秒かかるのに対し、host側の実行枠は6秒だからである。内訳は
`lattice status --json` 4.2〜5.3秒と`lattice todo status` 3.4〜3.7秒で、どちらも同じ
`readTodoStore`を別プロセスで払っていた（dotagents store 9.7MB／218ファイル）。
storeが小さいproject（Lattice repo、560KB）では1.8秒で収まるため、**storeが育ったprojectから
順に案内が消える**構造だった。

Lattice側は`lattice session-context --json`（0.14.0、ADR 0131）で1プロセス・1 store読みへ畳んだ。
実測でdotagentsが6.5秒→3.2秒。この入口は`status`へ`project_status.v1`、`todo`へ
`todo_status_result.v4`をそのまま埋めるので、hookが既に持つ検証器を再利用できる。
さらに`independence`にreadyのあるplanだけの並列可否要約を含むため、**追加プロセスを払わずに**
並列可否をsession開始時点で届けられる。

届ける価値の側も揃っている。Latticeは0.13.0で並列可否の判定・記録・着手時advisory・工程表表示を
公開したが、host側の常駐案内はそれに触れていない。依存線の不在を並列可の根拠にしない、という
判断材料がsession開始時に手元へ来ない。

## 設計判断

1. **統合入口へ切り替え、旧2呼び出しは古いCLI用の分岐として残す。** `session-context`が
   usage failure（exit 2・stdout空）を返すCLIは0.14.0未満である。その場合だけ従来経路を使う。
   これはfallbackではなく、**版差の明示的な分岐**——新しい入口が「無い」ことは観測可能な事実であり、
   失敗を隠して別経路へ逃げるのとは違う。
2. **exact key検証をやめ、必要fieldだけのallowlist読みにする。** 独立性の投影は版を上げずに
   キーが増えた実績がある（`guidance`）。未知keyの追加でhookが全端末で壊れる構造を新しい面へ
   持ち込まない。既知keyの型だけを検証し、知らないkeyは無視する。
   `todo`部分木は`todo_status_result.v4`そのものなので、既存の厳密検証をそのまま通す。
3. **rcの意味を明文化する。** exit 2かつstdout空＝新入口が無い（静音で旧経路へ）。
   exit 1＝typed failure（既存の`status_unavailable_message`と同じくfail-visible）。
   exit 0＝採用。「非ゼロなら黙る」にしない。
4. **並列可否は事実と件数を述べ、案内文はLatticeの返答をverbatimで使う。** 面ごとに文言を
   書き直すと必ずずれる（Lattice ADR 0130が案内の単一正本を置いた理由）。hookは要約を自作しない。
5. **規範はorchestrate正典へ書く。** `shared/orchestrate/composition.md`が「同一repo writerの
   直列化」を唯一の正本と自称し、`delegation-contract.md`が「並列化の検討とLattice既定」節を持つ。
   共通憲法へ書くとLattice `AGENTS.md`の運用作法と重複し、Lattice ADR 0130が置いた案内の
   単一正本を割る複製になる。既存の明示除外（read-only fan-out・別repo並列）も保持する。

## 非目標

- **共通憲法への並列可否条文**。orchestrate正典が所有面である。
- **hookからのplan別多重照会**。統合入口が1回で全planを要約するので不要。
- **並列dispatchの機械的拒否**。hookは案内面であり、gateではない。
- **別件WIP（`lib/orchestrate/control-record.mjs`）への関与**。

## 受入条件

- dotagentsでSessionStart hookが6秒枠に収まり、INFOが捨てられなくなる。
- 0.14.0未満のCLIでも従来どおり案内が出る（静音で旧経路）。
- readyのあるplanで並列可否の要約がINFOへ載る。
- `make ci`（lint-hooks・test-constitution・parity）がgreen。

## 工程

正本はdotagents Lattice store。以下は各ToDoが何を成すかの散文である。

- `lsch-001` hookを統合入口へ切り替える。allowlist読みとrcの意味の明文化を含める。
- `lsch-002` 並列可否のfragmentをINFOへ載せる。案内文はLatticeの返答をverbatimで使う。
- `lsch-003` orchestrate正典へ並列dispatchの根拠を書く。既存の明示除外を保持する。
