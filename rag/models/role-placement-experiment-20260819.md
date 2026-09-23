<!--
source: dotagents役割配置実験（本セッション実施）
fetched: 2026-08-19
confidence: dotagents実測・各セルn=1・一般化禁止
-->

# dotagents役割配置実験（2026-08-19）

## 実験設計

- 948行の実コード由来コーパス: Spotter `src/core/runtime-error-store.mjs` を `corpus/event-store.mjs` へ複製し、既知バグ10変異を注入した。
- finderは Grok 4.6×medium、GPT-5.6 Terra×medium、Claude Sonnet 5×medium の3席。同一prompt、read-only、corpusディレクトリ限定、aiterm入口統一で監査した。
- 反証は Grok 4.6×high、GPT-5.6 Sol×high、Claude Opus 5×high の3席。由来を伏せたclaims 14件（真10・偽4）を判定した。
- Lunaは、仕様固定・focused test付きの局所コーディングを medium / max で各1走行比較した。
- 採点は hit = 該当行（±2行）またはロジックの特定と、欠陥方向の正しい説明。partial = 言及ありだが説明誤りまたは別問題。FP = 注入10件に該当しないバグ指摘。recall = hit/10、precision = hit/(hit+FP)。

### 変異一覧（ground truth）

| ID | 行 | 変異内容 | 期待される観測 | 想定重大度 |
|---|---|---|---|---|
| B1 | 58 | `DEFAULT_ISOLATED_TIMEOUT_MS` 1_500→500 | 直上コメント（500msは実測境界未満で不具合を起こしたと明記）との矛盾 | medium |
| B2 | 117 | `error?.code === 'ENOENT'` → `!==` | config欠落→config_malformed、読取失敗→config_missing に誤分類（三項の分岐逆転） | high |
| B3 | 188 | receipts超過trim `splice(0, length - MAX_RECEIPTS)` → `splice(0, MAX_RECEIPTS)` | 1025件目で1024件消え1件だけ残る（超過分でなく上限数を削除） | medium |
| B4 | 235 | `Math.min(750, Math.max(100, x))` → `Math.max(750, Math.min(100, x))` | clamp逆転で常に750。小さいtimeoutでobserveBudgetがほぼ0になる | high |
| B5 | 252 | `deadline - Date.now()` → `Date.now() - deadline` | remainingMs常に負→reconciliation救済パスが絶対に走らない（dead code化） | high |
| B6 | 289 | close handlerの `if (!stopping)` ガード除去 | timeout/cancel経路でclose eventがstop完了より先にfinishし、timeoutが exit として誤報告されるrace | medium |
| B7 | 346 | snapshot filter `sequence > afterCursor` → `>=` | cursor位置のrecordが毎回再配送されるoff-by-one | high |
| B8 | 370 | ack `Math.max(既存, cursor)` → `= cursor` | 単調性喪失。古いcursorでacknowledged_throughが巻き戻る | medium |
| B9 | 393 | resolve時刻検査 `<` → `<=` | last_seenと同時刻のresolveを拒否。validateRecord（`resolved_at < last_seen`のみ拒否）と不整合 | low |
| B10 | 415 | compact対象sort `b.sequence - a.sequence` → `a-b` | 保持すべき「新しい方N件」でなく古い方N件を保持 | medium |

## 採点結果

### 実験A: finder

| 席 | 指摘した変異 | recall | precision | 観測 |
|---|---|---:|---:|---|
| Terra×medium | B2, B3, B4, B5, B7, B9 | 6/10 | 6/6（FP 0） | 全指摘が根拠行付きで正確。B9は`validateRecord`との不整合まで特定。B1/B6/B8/B10を見逃し。 |
| Grok 4.6×medium | B2, B3, B4, B5, B7, B9, B10 | 7/10 | 7/7（FP 0） | 3席中トップ。B1/B6/B8を見逃し。符号・clamp・splice幅が逆向きというパターン俯瞰も提示。初回はsandbox×hook symlink衝突で起動失敗し、r2で完了。 |
| Sonnet 5×medium | B3, B4, B5, B7, B9, B10、B1 partial | 6/10＋partial 1 | 6/6（FP 0） | 説明は最も深く、B4の`observeBudget`波及とB5との複合影響まで言及。B2/B6/B8を見逃し、出力は最も冗長。初回はaiterm相関固着でprompt未投入、r2で完了。 |

横断では3席ともFP 0だった。B6（close race）とB8（ack単調性）は全席が見逃し、状態遷移・時系列系は単発monitor監査の共通盲点という仮説が残る。B2はSonnetだけ、B10はTerraだけが見逃した。

### 実験B: 反証

| 席 | 結果 | 観測 |
|---|---:|---|
| Grok 4.6×high | 14/14（uncertain 0） | 真10（finder全滅のB1/B6/B8を含む）をすべてreal、偽4をすべてfalseとした。F1=`detached:true`でprocess group成立、F2=duplicate早期return、F3=`validateStore`後にwrite、F4=optional chainingでTypeError不成立、の反証理由も正確。 |
| Sol×high | 14/14（uncertain 0） | B6のraceをwin32の`taskkill`経路の非同期性まで特定。偽4件の反証理由もすべて正確。 |
| Opus 5×high | 13/14 | claim 6（B6）だけfalseとした。POSIXではmicrotask順序でclose到達不能、win32でも呼出側はexit code 0/10だけを判定し観測可能な差がない、と最も深く追跡した。採点定義では関数契約レベルのwin32誤報告がrealのため不正解だが、真で無害な指摘を殺す方向の誤り。偽4件の反証理由はすべて正確。 |

finderが全滅したB1/B6/B8も、claimとして反証工程へ載せると回収できた。見逃し対策はfinder増席ではなく、疑いの列挙を反証役に裁かせる2段構造が有効という示唆になる。

### 実験C: Luna medium / max

| effort | 結果 | 実装・所要 |
|---|---|---|
| medium | 14/14パス、目視審査合格 | 85行、約4分。private field・Map挿入順LRU・最小実装。`cache.test.mjs`は無改変。 |
| max | 14/14パス、目視審査合格 | 94行、約2.5分。同設計で、アンダースコア慣習と`Infinity`番兵のみが差分。 |

このタスク種では品質差はなかった。仕様固定・focused test付きの分解済み局所コーディングではmediumを出発点にできる。単価はeffortで変わらないが、mediumの思考tokenは軽い。一方、分解が甘い仕事でのLuna挙動は測定外である。

## 運用トラブル記録

1. Codex CLI 0.147.0→0.148.0のupdateダイアログとディレクトリ信頼ダイアログが初手promptを飲み込んだ（`initial_prompt=not_sent`）。scratchpad等の未信頼cwdで発生した。
2. Grok read-only sandboxは`~/.grok/hooks/factory.json`がsymlink（dotagents配布方式）だと起動拒否したため、宣言型read-onlyで代替した。
3. Claude席はTUI起動後にaiterm相関が「起動時prompt完了待ち」で固着し追送不能となり、席の作り直しで回避した。
4. aiterm-wait既定600秒はTUIダイアログ停止と区別が付かず、timeoutだけでは異常を判定できなかった。
5. writer gateはrepo外scratchpadを`unidentified-repo`として全席直列化し、解放コマンドは親の承認classifierに拒否された。

## 限界

- 各セルn=1であり、単一の課題種・単一走行である。一般的なモデル能力順位へ拡張しない。
- finderは変異注入型の監査課題であり、自然発生した欠陥の分布を代表しない。
- 同一マシンで動作したため、指示違反で元repoを探索してdiffすれば変異を知り得る。promptで対象ディレクトリ限定を明示し、報告に元repo参照の痕跡がないことを受入時に確認した。
- sandbox執行方式は席間で非対称だった。GrokとSonnetは初回起動障害後のr2であり、Luna maxはwriter gate未解放のため別の承認経路で実行された。

## 関連リンク

- [[../../shared/runbooks/02_models.md]]
