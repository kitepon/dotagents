# hmer-002 — Grokの残量と利用可能なモデル・エフォートの実測

## 作成物

- `rag/models/grok-quota-and-catalog-20260921.md`
- 本証跡

SpaceXAI公式文書、現アカウントの公開Settings、Grok Build CLI、製品所有catalog cache、既存Codex
quota adapterを照合した。cookie、token、email、account ID、会話本文、raw catalogのidentity／
endpoint／header／key fieldは成果物へ保存していない。

## 実測結果

- Grok Build CLI 1.0.30 stable（`04b7ffed98c6`）。
- SuperGrok Heavy週次枠は19% used（81% remaining）、Grok Build内訳19%、
  2026-09-27 19:39 Asia/Tokyo reset。絶対上限・token数・金額は表示されない。
- Grok Botは別枠で0% used、2026-09-28 09:10 Asia/Tokyo reset。推薦poolへ混ぜない。
- Extra Usage Creditsは入口だけ表示され、数値残高は取得不能。
- 2026-09-21T19:08:38Zのproduct-owned catalog cacheは`grok-4.7`、
  `grok-4.7-build-fast`、`grok-4.6`、`grok-4.5`の4 entry。4.7系／4.6は
  low・medium・high・xhigh、4.5はlow・medium・high、いずれもhigh既定、500K context。
- 現CLIは`You are not authenticated.`。fallback一覧とfresh cacheは確認できたが、この時点の
  実request成功は未確認。loginを変更せず、更新遅延用の生成も行わなかったため遅延は未測定。
- `grok usage`はsession別token/costでありaccount quotaではない。継続的な公式残量面は
  Settings→Usageのみ。未文書APIやcookie scraperを実装入口にしない。
- Cursor上のGrokはhmer-001実測のCursor Models月次pool（6% used）を消費し、Grok直接の
  SuperGrok週次poolとは共有しない。model IDもCursorはGrok 4.6、直接catalogは4.7系を含む。
- Codex CLI 0.155.1の最新product-owned eventは2026-09-21T15:55:08ZにPro 7日枠97% used、
  3% remaining、10080分、2026-09-26T09:13:21Z reset、追加creditなし。既存adapter形状と一致。

## 実行した確認

1. `git fetch origin`、`git status --short --branch`、`git rev-list HEAD...origin/main`
   - 他席のLattice witness／hmer-001 start差分を確認して保持。checkout／reset／pullは未実施。
2. Lattice start／shared pull run intake／attach
   - hmer-002 sequence 2、`intervention:none`、専用worktree、mio台帳PIDでworker attached。
3. `grok --version`、`grok --help`、`grok usage --help`、`grok models`、
   `grok agent --help`、`grok version --json`
   - version、公開機能、session usage契約、認証切れ、fallback model一覧を確認。
4. `~/.grok/models_cache.json`のallowlist projection
   - `fetched_at`、CLI version、4 entryのID／context／effort／capabilityだけを投影。
   - identity、etag、origin、base URL、header、API key fieldは出力・保存していない。
5. 認証済み`https://grok.com/?_s=usage`
   - agent-desktopはinventory不安定で操作未配送のまま終了。hmer-001で実績のあるChrome
     AppleScript fallbackを使い、新規専用windowの必要DOM値だけを取得して閉じた。
   - cookie、storage、header、account identifier、会話本文は取得していない。
6. Codex product-owned session eventのallowlist projection
   - 最新40 session file候補から最新観測時刻を選び、rate limitの既知fieldだけを投影。
   - prompt、response、session ID、account識別子は出力・保存していない。
7. Caveat検索
   - `Grok usage quota weekly Build`、`Codex rate limit token_count usage status`はいずれも該当なし。

## 未取得・制約

- Grokの絶対pool上限、token／金額単位、Extra Usage Credits数値残高、公開programmatic残量APIは
  取得不能。
- 現CLIが未認証なので、4 model×effortの実request成功とUsage更新遅延は未測定。過去loginや
  browser cookieを移植せず、架空値や別契約の数値で補っていない。
- 公式画面の19%は週次Grok直接pool、Cursorの6%は月次Cursor Models poolであり、割合の大小を
  容量比較に使えない。

## 最終試験

1. `node --test tests/orchestrate/quota-adapter.test.mjs`
   - tests 9、pass 9、fail 0、skip 0、exit 0。
2. `npx --no-install markdownlint-cli2 rag/models/grok-quota-and-catalog-20260921.md
   evidence/harness-model-effort-recommender/hmer-002.md`
   - repository対象280 files、0 issues、exit 0。
3. `git diff --check`
   - whitespace errorなし、exit 0。
4. `git diff --name-only`のexact比較
   - 宣言済みのRAGと証跡の2 pathだけ、exit 0。
5. credential marker scan
   - `sk-`／`xai-`／Bearer token形の長い値なし、exit 0。
