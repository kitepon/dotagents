# 07_grok-fragments — Grok 端末設定の工場断片

`~/.grok/config.toml` は端末固有（コミットしない）。このファイルは工場が所有する断片と、限定適用器の正典である。親の model×effort と permission と login はオーナー領分であり、適用器は触らない。

適用器は [`../bin/apply-grok-config.sh`](../bin/apply-grok-config.sh)。`--apply` は端末承認後。backup は `$HOME/Archives/dotagents-grok-config-*.tar.gz`。
工場hookだけの再反映は`--hooks-only --apply`で行い、`config.toml`を保持する。事前差分は`--hooks-only --dry-run`で確認する。

## 1. 工場が書く面

- `[compat.claude] agents = false`（Wave 1。`~/.claude/CLAUDE.md` を吸わない）
- `[compat.claude] hooks = false`（Wave 4。Claude `settings.json` の hook は `disabled` になり発火しない。`grok inspect` には vendor=claude の行が残ることがある）
- `~/.grok/hooks/factory.json`の工場hook。製品hookは各製品の公開入口が管理する。

製品MCPの登録・command解決・OS差・既存設定の移行は各製品が所有する。工場は[公開入口の呼出し](../lib/factory/product-setup.mjs)だけを行い、この適用器はMCPセクションを変更しない。`compat.claude.mcps`は切らない。

## 2. 触らない面

- `[models]` と `default_reasoning_effort`
- `[ui] permission_mode` ほか permission
- `[privacy]` と login
- すべてのMCP設定
- `compat.claude.skills` / `mcps`（skillsはWave 2で切らない裁定済み。工場MCPの所有のために mcps は切らない）
- 個人hook。所有面は `~/.grok/hooks/factory.json` と `~/.local/bin/grok-*-hook` だけ

工場hookはGrok camelCaseをそのまま読む。Claude 形へ canonicalize しない。製品hookは工場hookに載せない。

責務境界ゲート（`boundary-gate`。憲法「姿勢の原則」12）は Claude frontend だけで、Grok の `factory.json` へは未配線。Grok 席からの越境書込は本ゲートで止まらない。Throughline の導入・hook出力・再適用は [Throughline README「In 30 seconds」](https://github.com/kitepon/Throughline#in-30-seconds) が正である。

工場hookは全OSで`apply-grok-config`がrepoの正本から`~/.grok/hooks/factory.json`へ実ファイルとして反映する。Grokのsandboxがhook sourceのsymlinkを拒否するため、初回のsymlink配置は適用時に置き換える。以後の更新もrepoの正本から反映する。Windows nativeでは、解決できた`python.exe` / `sh.exe`を絶対パスで前置し、拡張子なしのhookがアプリ選択画面を開くのを防ぐ。POSIXはrepoのshebang commandを使う。
ここで使う`sh.exe`はGit for Windowsのnative executableであり、WSL／`System32\bash.exe`ではない。Windows nativeのGrok配線はWSL2・Docker・仮想化を要求せず、WSL側`~/.grok`へfallbackしない。

Grokの `UserPromptSubmit` / `SessionStart` / `PostToolUse` は stdout を制御に使わない。観察系工場hookは exit 0 と空または非block JSONだけを返し、Stop で `decision=block` や exit 2 を出さない。

## 3. 受入

適用器の受入は互換設定と工場hookの差分・再実行・既存MCP保持で確認する。製品MCPは製品setupの公開結果と、新しいGrokセッションのhandshakeで確認する。失敗や未対応は公開結果のまま残す。
