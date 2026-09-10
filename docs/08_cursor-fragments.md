# 08_cursor-fragments — Cursor 端末設定の工場断片

`~/.cursor/mcp.json` と `~/.cursor/cli-config.json` は端末固有（コミットしない）。このファイルは工場が所有する断片と、限定適用器の正典である。親の model×effort と permission と login はオーナー領分であり、適用器は触らない。

適用器は [`../bin/apply-cursor-config.sh`](../bin/apply-cursor-config.sh)。`--apply` は端末承認後。backup は `$HOME/Archives/dotagents-cursor-config-*.tar.gz`。

## 1. 工場が書く面

- `~/.cursor/hooks.json`の工場hook。製品MCPは各製品の公開入口が管理し、この適用器は`mcp.json`を読み書きしない。
- User Rules UI と `cli-config.json` は完成形にしない。グローバル憲法の正本ファイルは `~/.cursor/rules/factory.mdc`（Wave 1）。Cursor 3.17.8 Desktop の always-apply 注入は workspace 内の `.cursor/rules` に限るため、工場 `cursor-constitution-hook` が配達する。home mdc へ `globs` を足しても `alwaysApply: true` は type=global になり YAML globs は捨てられる。本文が 10000 字以内なら `additional_context` に同一本文を載せる。超える場合 Desktop は spill して「uuid.txt を Read」に置換するため、hook 側で cap 内の案内（ベル・Cursor native shell・正本パス）と本文冒頭を inline し、末尾の Cursor delta は切らず、同一全文は `factory.mdc` の Read で届ける。sessionStart は composer handle 未作成だと落とすので、awaited の beforeSubmitPrompt と、次ターンへ載る preToolUse にも同じ hook を置く。`~/.cursor/factory-constitution` は同一正本の overlay。窓への `--add` はしない。

製品MCPの登録・command解決・OS差・既存設定の移行は各製品が所有する。工場は[公開入口の呼出し](../lib/factory/product-setup.mjs)だけを行う。

Windows nativeのCursor配線はWindows側`~/.cursor`だけを所有し、WSL2側のHOME、Docker、仮想化を前提・fallbackにしない。shellが必要なhookはGit for Windowsのnative `sh.exe`を使い、WSLへdispatchしない。

## 2. 触らない面

- `~/.cursor/cli-config.json` の `model` / `modelParameters` / permission / login
- すべてのMCP設定
- `~/.cursor/skills-cursor/`
- 個人hook。所有面は `~/.cursor/hooks.json` と `bin/cursor-*-hook`。apply-cursor-config が工場hookを upsert し、個人hookは残す。

工場hookはCursor envelope（`hook_event_name` / `permission` / `additional_context`）をそのまま読み、Claude形（`permissionDecision`）へcanonicalizeしない。Spotter / Throughline / Caveatの製品hookは工場hookへ複製せず、各製品installerが同じ`~/.cursor/hooks.json`へupsertする。`apply-cursor-config`はそれらを保持し、製品hookの有無や内部commandを工場側で決めない。`cursor-constitution-hook`は`~/.cursor/rules/factory.mdc`をDesktop Agentへ配達する。10000字以内なら同一本文を`additional_context`へ載せ、超過時はcap内の案内と本文冒頭をinlineし、末尾のCursor deltaは切らず、同一全文は正本ファイルのReadで届ける。sessionStartはfire-and-forgetでhandle未作成だと落とすため、同じhookをawaitedのbeforeSubmitPromptと次ターンのpreToolUseにも置く。Cursorに`exit_plan_mode`がないためplan-gateは採用しない。

責務境界ゲート（`boundary-gate`。憲法「姿勢の原則」12）は Claude frontend だけで、Cursor の `hooks.json` へは未配線。Cursor 席からの越境書込は本ゲートで止まらない。

## 3. 受入

製品setup後の新規 Cursor session で、対応する製品MCPのhandshakeを見る。失敗はtypedのまま残し、登録成功へ丸めない。既存sessionの MCP catalog 見た目は受入に数えない。`hooks.json` は live reload される。憲法配達の受入は Cmd+Shift+L の新規ローカル Agent チャット。private worker / background composer の既存窓は、live reload 済みでも人間の follow-up で beforeSubmitPrompt を踏まない（2026-08-24 実測）。Task/cloud・goal continuation・`cursor --chat` も Desktop hook を踏まない。private worker の exec-daemon は起動時の `hooks.json` だけを見る。`cli-config.json` の model が適用前後で同じであること。Cursor は互換で `~/.claude/skills` も読む。工場所有は `~/.cursor/skills` であり、Claude 面の列挙を切断成功と読まない。
