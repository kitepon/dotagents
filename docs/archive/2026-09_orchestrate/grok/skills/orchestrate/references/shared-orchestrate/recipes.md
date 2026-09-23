<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Sources: shared/orchestrate + docs/02_models.md + lib/orchestrate/lane-admission.mjs + claude/skills/orchestrate/references/workflow-templates.md -->
<!-- Regenerate: node bin/render-orchestrate-skill-references.mjs --write -->
# 固定Recipe契約 — 二型の意味の唯一の正本

この文書は固定Recipe二型（`adversarial-audit`／`bulk-curation`）のhost非依存な意味
（Phase・入力・並列化意図・出力schema・reducer・gate・失敗条件）を所有する（ADR 0115）。
対象はこの二型だけであり、第三の型はここへ追加しない。host adapterは実行入口だけを所有し、
本書の意味を再定義しない——Claudeの入口は
[workflow-templates.md](workflow-templates.md)、
Codexの入口は[codex orchestrate SKILL](../../SKILL.md)のRecipe節。
機械可読schemaの正本は[recipes/](recipes/)のversioned JSONで、host雛形内のschema literalは
canonical JSON一致をCI gate（`tests/orchestrate/recipes-conformance.test.mjs`）で強制する。

固定Recipeは静的契約である。共通runner・DSL・loop/retry言語・registry・durable state machineを
作らない。RecipeはLattice／Controlなしでhostの正規入口から実行できる（ADR 0113 Decision 1）。
型の使用はレーンを問わない——統括レーン専用なのはControl儀式だけである（ADR 0061 技法と儀式の分離）。

## 共通契約（両型に適用）

### 実行結果の二軸と集約

- 子の実行状態: `completed | failed | unknown`。timeoutと外部中断は`unknown`とし、host固有handleの
  正規入口で回収する。`unknown`を成功にも失敗にも自動変換しない（裁定は親）。
- 結果payload: `empty | nonempty`。`empty`は正常な0件であり失敗ではない（監査で指摘0件、
  整理で修正0件は正しい結果になりうる）。
- Recipe集約: `success | partial_failure | failure | pending`。一部の子だけが`failed`なら
  `partial_failure`、全子が`failed`なら`failure`、`unknown`が残る間は`pending`。
  **`partial_failure`を`success`へ、`empty`を`failure`へ丸めない。**

全体gateは次の全部が成立した時だけ`success`とする:
`unknown`が0 ∧ `failed`が0 ∧ 型ごとの完全性検算が成立。

### Recipeが所有しないもの

- **retry**: Recipe-level automatic retryを定義しない。provider retryの正本はExecutor製品、
  正式reject後の再試行はControlの新規Worker Runである（ADR 0113 Decision 3）。
- **loop**: 汎用`max_rounds`・条件付き反復・任意回数を契約化しない。反復に見えるものは
  静的に展開された固定段だけを持てる（型1の第2ラウンド参照）。
- **実行時間・再送・provider切替**: host固有handleの所有。Recipeは`unknown`の観測投影だけを定める。

### 並列度と同一repo writerの直列化

- 最大並列度は静的な上限値としてだけ持てる。hostは能力に応じてそれ以下で実行してよい。
  shared側にqueue・slot・再投入・進捗stateを持たせない。
- **同一repo writerの直列化規則は全経路共通であり、正本は[合成契約](composition.md)である**。
  Recipeはその判定に必要なrepo identityとeffect（read/write）をclosedに持つだけで、規則自体を
  再定義しない（各型の入力contract参照）。判定コードは`lib/orchestrate/execution-path.mjs`。

### 回収とControl投影

- Recipe固有のterminal result schemaが一次出力である。通常レーンではそれを直接親へ返し、
  Packet／Reportを作らない。
- Controlが既に選択されている場合だけ、terminal resultをstrict Worker Reportへ投影する
  optional adapterを使う（投影の所有はhost adapter側。Recipe意味は変わらない）。

## 型1: `adversarial-audit`（敵対的監査）

発見の網羅は並列多視点で、信頼性は指摘ごとの反証で作る。

- **Phase（固定順）**: `Find → Dedup → Verify → Critic`。
- **入力contract**:
  - `DIMENSIONS`: `[{ key, prompt }]`。1〜8件。`key`は一意なbounded identifier、`prompt`は担当視点。
  - `CTX`: 全agent共通の前提文。対象repo・規約・誤検知回避の前提（意図的な設計を指摘させない）・
    read-onlyの明言・「evidenceに`file:line`必須・推測禁止・確度の高いものだけ」を必ず含む。
  - `max_findings`: 視点あたりの最大指摘数。上限10（schemaの`maxItems`と一致）。
- **並列化意図**: Findは視点ごと、Verifyは指摘ごと（契約クリティカルだけ2レンズ）に並列。
  全段read-onlyのため並列度上限は持たない。
- **出力schema**（正本: [recipes/adversarial-audit.v1.json](recipes/adversarial-audit.v1.json)）:
  - Find: `FINDINGS`（指摘の配列。各指摘はtitle/kind/files/evidence/impact/effort/suggestion/
    contract_critical必須）。
  - Verify: `VERDICT`（`real`/`worth_it`/`reason`必須。任意で`risk`/`revised_suggestion`）。
  - Critic: `CRITIC`（`blind_spots`配列最大5件。各件はarea/why/evidence必須。evidenceは実ファイル確認つき）。
  - terminal result: `{ confirmed: [...], rejected: [...] }`。棄却理由を捨てない。
- **reducer**:
  - Find結果は全指摘へ一意`id`と`source`（視点key）を付けて平坦化する。
  - Dedupは**統合のみ**（新規作成・削除をしない）。同一指摘の判定は「同じ根本原因を同じファイル群に
    指摘している」こと。全入力idが`merged_ids`へちょうど1回現れることをコードで検算し、欠落は復元する。
  - Verifyは`confirmed = 有効票が1票以上 ∧ 全票が real ∧ worth_it`。疑わしきはfalse。
- **gate（完全性検算）**: 全finding idが`merged_ids`に現れる ∧ 全dedup後指摘がVerify終端している。
- **失敗条件**: Find/Verify agentの`failed`は共通契約どおり集約へ立てる（失った視点・未検証の指摘を
  成功へ丸めない）。Verify不能（全票`unknown`）の指摘はconfirmedにできない。
- **第2ラウンド**: Criticが盲点を出した場合だけ、同型のFind→Dedup→Verify→Criticを**高々1回**
  静的に展開して回す。第3ラウンド以降は契約外（必要なら親が新しいRecipe実行として裁定する）。
- **2レンズ規則**: `contract_critical: true`の指摘だけexistence（実在）とvalue（価値）の2レンズで
  検証する。その他はexistenceだけ。

## 型2: `bulk-curation`（一括整理/移行）

多数の独立対象へ同じ厳格契約を適用する。

- **Phase**: `Apply`のみ。
- **入力contract**:
  - `TARGETS`: `[{ target, repo_root, effect, write_scope }]`。1件以上。`target`は対象の記述、
    `repo_root`は対象が属するrepo（repo外対象は`null`）、`effect`は`read | write`、
    `write_scope`は書込みを許すpath集合（`effect: read`では空）。
  - 許可操作のホワイトリスト（番号付き・具体的）と禁止事項（実質的書換え・確信のない削除・創作の禁止）。
  - 対象がgit管理外なら実行前のtar退避を前提条件とする。
- **並列化意図**: 対象ごとに並列。ただし[合成契約](composition.md)の直列化規則に従う——`effect: write`の
  対象が同じ`repo_root`に2つ以上あり、Latticeが選択されていなければ、そのrepoの対象は直列に実行する。
- **出力schema**（正本: [recipes/bulk-curation.v1.json](recipes/bulk-curation.v1.json)）:
  - Apply: `REPORT`（`target`/`fixed`/`flags_for_owner`必須。flagは迷い・要裁定の報告先）。
  - terminal result: 全対象のREPORT配列＋集約状態。
- **reducer**: 全`TARGETS`が終端（`completed`または`failed`）していることを検算する。
  `fixed`が空でも正しい結果になりうる（`empty`は失敗ではない）。
- **gate（完全性検算）**: REPORT数が`TARGETS`数と一致 ∧ 各REPORTの`target`が入力と1:1対応。
- **失敗条件**: 対象の`failed`/`unknown`は共通契約どおり。`flags_for_owner`は失敗ではなく
  親への裁定要求であり、gateを塞がない。
- **無損失規約**: 内容の分割・移設を含む場合、元の全非自明行が分割後ファイル群へ完全一致で
  ちょうど1回出現することの機械照合を子の完了条件へ含める。

## Rollback

本書・[recipes/](recipes/)のschema・両host adapterの参照は同一commit単位で導入・撤回する
（ADR 0115 Decision 7）。shared正本だけを撤回してadapterへ壊れた参照を残さない。
