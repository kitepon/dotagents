# AGENTS.md vs CLAUDE.md — AI 指示ファイルの 2026 規約

- 出典: [Claude Code Memory Docs](https://code.claude.com/docs/en/memory)（一次・[raw](raw/claude-code-memory-20260923.md)）・[Claude Code CHANGELOG 2.1.277](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)（一次・[raw](raw/claude-code-changelog-2.1.277-20260923.md)）・[Codex AGENTS.md Docs](https://learn.chatgpt.com/docs/agent-configuration/agents-md)（一次）・[agents.md](https://agents.md/)・自前実測
- 取得日: 2026-07-05 初版／2026-07-16 Codex global scope 再確認／**2026-09-23 Claude Code の AGENTS.md 直接読込対応で全面改訂**
- 確度: 高（primary source 逐語・npm公開日時・自前環境 v2.1.280 で確認）

## 問い

AI 指示ファイルは AGENTS.md か CLAUDE.md か。Claude Code はどう扱い、Codex 併用環境でどこまで一本化できるか。

## 確定事項（2026-09-23 時点）

1. **Claude Code v2.1.277（2026-09-18 公開）から、プロジェクト指示として `AGENTS.md` を直接読む**。import・設定不要。旧記述「Claude Code reads CLAUDE.md, not AGENTS.md」は失効。
2. **既定（`claude-md-or-agents-md`）は排他**: 作業ディレクトリかその上に `CLAUDE.md`／`.claude/CLAUDE.md`／`CLAUDE.local.md` が1つでもあれば `AGENTS.md` は読まない。無ければ上位階層の `AGENTS.md`／`.claude/AGENTS.md` を起動時に読み、サブディレクトリの `AGENTS.md` は Read 時に読む。`AGENTS.md` 内の `@import` は展開される。
3. **判定に数えないもの**: `~/.claude/CLAUDE.md`・組織の managed `CLAUDE.md`・`.claude/rules/`。これらは `AGENTS.md` と併せて読まれる。
4. **読まないもの**: `AGENTS.local.md`・`AGENTS.override.md`・`.agents/` 配下。
5. **AGENTS.md で代替できるのはプロジェクト指示スコープだけ**。スコープは managed policy／user（`~/.claude/CLAUDE.md`）／project／local の4つで、**user スコープに AGENTS.md 相当は無い**＝Claude の全プロジェクト共通指示は今も `~/.claude/CLAUDE.md` だけ。
6. **切替**: `/config` の Project instructions、または `~/.claude/settings.json` の `pluginConfigs."agents-md@builtin".options.instructionFiles`（`claude-md-or-agents-md`〔既定〕／`claude-md-and-agents-md`／`claude-md`／`managed-only`）。project・local settings では無視される。`claude-md-and-agents-md` は同一ディレクトリで CLAUDE.md→AGENTS.md の順に読み、import／symlink 済みの AGENTS.md を二重読込しない。
7. **直接読込が効かないセッション**（CLAUDE.md だけ読む）: v2.1.277 未満／feature flag を取得しないセッション（Bedrock・Vertex・Foundry 等の第三者 provider、テレメトリ無効）／対応版の導入・更新後の最初のセッション／組込み `agents-md` プラグイン無効。
8. **CLAUDE.md との差**: 直接読んだ AGENTS.md では `InstructionsLoaded` hook が発火しない。`--add-dir`＋`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD` でも追加ディレクトリの AGENTS.md は読まない。`/memory`・`/context` への表示は v2.1.280 から。
9. **旧回避策の扱い（公式）**: `@AGENTS.md` を import する CLAUDE.md は残してよい（二重読込しない・他に中身が無ければ削除可）。symlink はどちらでも可。「AGENTS.md を読め」と文章で書いた CLAUDE.md と、AGENTS.md を出力する SessionStart hook は削除対象。
10. **AGENTS.md は横断標準**: Codex・Cursor・Copilot・Gemini CLI・Windsurf・Aider・Zed・Warp 等が対応。Codex の global は `~/.codex/AGENTS.md`（global scope で `AGENTS.override.md` が非空ならそちらだけ）。通常 Markdown リンクは instruction chain へ自動展開されないため、必須共通規範を runtime リンク読込へ委ねない。
11. **`/init`**（`CLAUDE_CODE_NEW_INIT=1`）と **`/import`**（v2.1.213+）は既存 AGENTS.md 等を CLAUDE.md へ取り込む。

## dotagents への適用

- 工場の共通聖典は `shared/constitution.md`＋host delta から各 host のグローバル指示を生成済み（2026-07-16〜）。Claude の生成先 `~/.claude/CLAUDE.md` は user スコープの唯一の受け皿なので、2026-09-23 の仕様変更でもグローバル層は変わらない。
- 効くのはプロジェクト層だけ: `@AGENTS.md` 1行の CLAUDE.md は不要になり、CLAUDE.md と AGENTS.md の二重管理を AGENTS.md へ一本化できる（2026-09-23 オーナーと合意した評価: 各プロジェクトには意味があるが工場聖典の抜本改良ではない。移行は未着手）。
- 自前実測 2026-09-23: `~/`・`~/Developer/` に上位 CLAUDE.md／CLAUDE.local.md は無く、テレメトリ無効設定も `InstructionsLoaded` hook 利用も無い＝直接読込の阻害要因なし。
- 旧計画: `docs/archive/2026-07_agents-md-onboarding.md`（完遂・退避済み）。
