# harness-model-effort-recommender 終端監査（再監査）

## 判定

受理。監査者は親（ベル）。2026-09-22 のオーナー裁定で工程3・5の完了条件を実物に合わせて改訂し、その条件で照合した。

## 前回受理の取消理由

2026-09-22 01:48Z の受理（hmer-007）は証跡どうしの整合だけを見ていた。受理直後に配布先で任務を投げると、4件すべて `jev chose none` で推薦が返らなかった。hmer-005 が「実呼出し成功」とした1件は harness・family・effort を全部 explicit で渡した入力で、指定の言い返しだった。詳細は `hmer-005-live-fix.md`。

## 改訂後の完了条件との照合

| 工程 | 完了条件（改訂後） | 照合 |
|---|---|---|
| 1 | Cursor・Grok の実測、取得可否の区別、RAG 保存 | hmer-001/002。公開画面の実測あり、programmatic 入口なしと確定 |
| 2 | Cursor と直接ハーネスを別候補で表現、親を変えない、02 と候補データの生成検証 | hmer-003。`render-model-candidates --check` は 91 candidates で一致 |
| 3 | pool 単位の観測状態を返し、測って空の pool と expired だけ除外、未観測は候補に残して比較不成立と明示 | 結果の `observations` / `excluded_pools` / `quota_comparison`。focused test で枯渇除外と harness 送り・順位送りを確認 |
| 4 | 任務から harness・model・effort・pool・理由・観測時刻が一回で返る。子の起動も親の変更もしない | 実呼出し 7 件すべて recommended。`parent_changed: false`、`child_process` 不使用を試験で固定 |
| 5 | 配布先から任務だけで呼べ、02 の順位表に沿った推薦が返る。観測状態と除外 pool が見える。02 に利用案内がある | 7 任務すべて該当役割の 1 位と一致（`hmer-005-live-fix.md`）。`docs/02_models.md`「推薦入口」節を追加 |

## 実呼出し（2026-09-22 02:26Z〜02:36Z、Jev 実 API）

| 任務 | 結果 | 02 |
|---|---|---|
| repoのdocsの誤字を1箇所直す小さな修正 | codex-native / gpt-5.6-luna / low | 軽作業 1 位 |
| 複数repoにまたがる認証設計、独立反証も要る | cursor-agent / claude-opus-5 / high | 設計 1 位 |
| 既存のテストが落ちている原因を調べて直す中規模の修正 | codex-native / gpt-5.6-luna / medium | 局所コーディング 1 位 |
| ChatGPTに設計のsecond opinionを聞く | gpt-connector / chatgpt | 相談 1 位 |
| 監査指摘が正しいか反対仮説を立てて潰す | cursor-agent / grok-4.6 / high | 反証 1 位 |
| 受入条件が数値で書けている機能の実装 | codex-native / gpt-5.6-terra / high | 実装 1 位 |
| 外部ライブラリの最新仕様をWebで調べる | cursor-agent / grok-4.6 / low | 調査 1 位 |
| 明示 cursor-agent / claude-opus-5 / high | 同候補をそのまま返す | 明示尊重 |

配布先 `~/Developer/dotagents` は origin/main と一致（934bd24）し、同じ入口で recommended を確認した。

## 試験

- `node --test tests/orchestrate/recommend-harness.test.mjs tests/orchestrate/recommend-harness-cases.test.mjs tests/orchestrate/recommendation-contract.test.mjs` — 19 pass、0 fail
- `node bin/render-model-candidates.mjs --check` — 一致
- `make lint-current-docs`（HEAD の clean worktree）— OK、documents=609

## 完了条件から外したもの（オーナー裁定 2026-09-22）

- 実残量の推薦への投入。Cursor・Grok に公開の取得口が無く、枯渇時は次順位への送りと明示指定で足りる。
- 比較 5 項目（成功率・手戻り・監査工数・総 token・所要時間）。推薦が 02 の 1 位を返す以上、02 を読んで選ぶ場合との比較は同じ答えを二通りで出すだけで、2 系統で任務を走らせるコストに見合わない。

## 既知の限界

Jev の役割分類は任務文の言い回しに感度がある（「調べて直す」は調査へ寄ることがある）。判断基準は 02 の順位表なので、寄り方を変えたい時は 02 側で役割の文言を直す。
