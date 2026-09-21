# hmer-001 — Cursorの残量と利用可能なモデル・エフォートの実測

## 作成物

- `rag/models/cursor-quota-and-catalog-20260921.md`
- 本証跡

Cursor公式文書、現アカウントの公開dashboard、Cursor Agent CLI、既存quota adapterを照合した。
秘密値、cookie、token、email、account ID、raw provider responseは成果物へ保存していない。

## 実測結果

- Cursor.app 3.21.16、Cursor Agent CLI `2026.09.18-9a7762b`。
- 現契約はUltra（$200/月）。Cursor Models 6% used（94%残）、Other Models 50% used（50%残）。
  月次resetは10月17日。絶対pool上限とreset時刻は公開画面から取得不能。
- on-demand spendingはdisabled。Grok Bot週次枠は0% used／9月28日resetだが、Agentの月次2 poolと
  別表示なので推薦poolへ混ぜない。
- `agent models` は223 ID。推薦対象familyではGroK 4.6=low/medium/high/xhigh、GPT-5.6三family=
  none/low/medium/high/xhigh/max、Fable 5.1=low〜max＋thinking、Opus 5／Sonnet 5も複数effortを確認。
  Cursor CLIのeffortは独立flagでなくmodel ID／model parameterの一部。
- pool mappingは Cursor Grok/Composer→Cursor Models、Claude/GPT/Gemini等→Other Models。
  Autoはroute先により両poolを消費しうる。
- 最小1回の `gpt-5.6-luna-none` request（14:24:14Z完了）が14:24:31ZまでにUsageへ反映。
  1.9万tokens／Included。17秒以内の反映を確認したが、整数%の50%表示は変化しなかった。
- 個人Ultraのaccount pool残量を返す公開CLI/APIは見つからない。公式の継続取得面はSpending／Usage
  dashboard。SDK `Agent.getUsage()`はagent/run単位、Admin APIはteam管理者用。未文書dashboard APIと
  session cookieを自動取得経路にしない。
- Claude Code 2.1.269はinstalledだが未login。既存statusline adapterとfixtureはgreenでも、現契約の
  live値は取得不能。必要条件はClaudeの正規login後、session限定settingsの対話TUI最小response。

## 実行した確認

1. `git fetch origin`、`git status --short --branch`、`git rev-parse HEAD`／`origin/main`
   - 開始時 clean、両方 `66b54be42f6533d674985db730c21025ff7d85cb`。
2. Lattice witness scaffold／compile
   - witness digest `2d65072b333fd95c6c6708a6b4317168f6c1e39e27200b74a286fe0efdab8a7a`。
   - `hmer-001`／`hmer-002` はverified parallel group、conflict 0、unknown 0。
3. shared pull run intake／attach
   - run `harness-model-effort-recommender-20260921t2313-haru`、`intervention:none`、worker attached。
   - 成果物はLatticeが返した専用worktreeだけで作成。
4. `agent --version`、`agent --help`、`agent status --format json`（secret-like fieldsを出力前にredact）、
   `agent models`
   - version、公開機能、認証成立、223 model IDとeffort variantsを確認。
5. 認証済み `https://cursor.com/dashboard/spending`／`usage`
   - Chrome内で本文の必要部分だけを取得。cookie/header/storageは読まず、成果物へ転記していない。
   - dashboard内部resourceはpath名だけ観測し、未文書APIを直接呼んでいない。
6. 更新遅延の最小実測
   - 14:23:52Z trustなし試行はrequest前にexit 1。
   - 14:24:04Z〜14:24:14Z、空の一時workspaceで1 request、出力`OK`、exit 0。
   - 14:24:31Z Usageに新規行を確認。rate limit試験・追加生成なし。
7. `claude --version`／`claude auth status --json`（個人fieldをredact）
   - 2.1.269、`loggedIn=false`／`authMethod=none`。
8. `node --test tests/orchestrate/quota-adapter.test.mjs`
   - tests 9、pass 9、fail 0、skip 0、exit 0。
9. `npx --no-install markdownlint-cli2 rag/models/cursor-quota-and-catalog-20260921.md evidence/harness-model-effort-recommender/hmer-001.md`
   - repository対象280 files、0 issues、exit 0。
10. `git diff --check` と秘密値marker scan
    - whitespace errorなし。secret-value markerなし。exit 0。

## 未取得・制約

- Cursorの絶対pool上限、resetの時刻、個人plan向けprogrammatic残量APIは取得不能。
- Claudeの現行5h／7d値は未loginのため未取得。過去fixtureを現在値として扱っていない。
- `agent-desktop` はmacOS application inventory不安定でCursorへの配送前にfail-closedしたため、
  公開macOS起動とChrome AppleScriptでread-only観測した。秘密値や設定変更はない。
- Cursor dashboardを開くため起動したCursor Desktop／Chromeは、共有資源解放時に新規生成や設定変更を
  残していない。既存Chrome自体は終了していない。
