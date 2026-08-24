# rag/ INDEX

調査・研究の再利用棚。1 エントリ 1 行（トピック/ファイル — 要旨。出典・取得日・確度は各ファイル冒頭）。

- [second-brain/karpathy-obsidian-llm-knowledge-base.md](second-brain/karpathy-obsidian-llm-knowledge-base.md) — Karpathy 流 LLM 知識ベース×Obsidian の一次発言集約と、うちの rag/ 設計への含意（2026-07-04・確度高）
- （raw なし・出典のみ）Karpathy の Anthropic 入り報道 — TechCrunch「OpenAI co-founder Andrej Karpathy joins Anthropic's pre-training team」2026-05-19。**報道記事の全文ミラーは公開リポに置かない**ため削除済み（2026-07-26）。要旨は上記コンパイル記事が保持する
- [second-brain/raw/obsidian-pricing-20260704.md](second-brain/raw/obsidian-pricing-20260704.md) — Obsidian 公式 pricing verbatim（2026-07-04）
- [second-brain/raw/obsidian-commercial-license-20260704.md](second-brain/raw/obsidian-commercial-license-20260704.md) — 商用ライセンス条件（WebFetch 要約経由・markitdown は JS ページで空出力の罠あり）
- [second-brain/notebooklm-second-brain-critique.md](second-brain/notebooklm-second-brain-critique.md) — NotebookLM「第二の脳」論の批評: 主脳不適（サイロ・API Enterprise 限定）／窓なら可／還流思想は Karpathy と収束（2026-07-04・確度は claim 別）
- [second-brain/longterm-memory-tools-survey.md](second-brain/longterm-memory-tools-survey.md) — 長期記憶ツール調査（mem0/Hindsight/claude-mem 等）: 全て見送り＝保存層サイロ化が原則7違反、既存5層で充足。再訪条件つき（2026-07-04）
- [orchestration/ai-collaboration-as-code.md](orchestration/ai-collaboration-as-code.md) — AI協業のコード化（@UT_Codex: GPT計画×Codex実行 Skill）。委譲構造の外部実証（2026-07-04。文中 delegate.sh は廃止済み→現行は codex-sidecar/aiterm）
- [orchestration/smux-terminal-agent-mesh.md](orchestration/smux-terminal-agent-mesh.md) — smux（Claude Code⇄Codex のターミナル双方向対話）。aiterm PTY と機能重複で不採用（2026-07-04。文中の「現構成」は当時）
- [model-steering/fable-behavior-porting-audit.md](model-steering/fable-behavior-porting-audit.md) — connect24h「型は移植できる」検分: output style での型移植は Fable に逆行（公式 L174/L9-13）＝棄却。記事の「Opus 4.8 は 200K」は誤り（1M 既定）。うちの会話規範は Fable の型と整合／憲法の選択的スリム化が宿題（2026-07-05・確度高・refuter 通過）
- [agent-config/agents-md-vs-claude-md-2026.md](agent-config/agents-md-vs-claude-md-2026.md) — AGENTS.md vs CLAUDE.md の 2026 規約: Claude Code は CLAUDE.md を読み AGENTS.md は `@import` 推奨／AGENTS.md は横断標準だがリポ単位のみ（グローバル等価物なし）。dotagents に適用（2026-07-05・確度高・一次ソース）
- [models/gpt-5.6-family.md](models/gpt-5.6-family.md) — GPT-5.6世代（Sol/Terra/Luna）: 2026-08-14公式価格・API/Codex effort差、Luna×maxのローカル実測と運用判断、native agent role・sidecar連携（確度はclaim別）
- [models/claude-5-family.md](models/claude-5-family.md) — Claude Fable 5 / Opus 5 / Sonnet 5 / Haiku 4.5: 現行価格・effort。Sonnet 5の$2/$10恒久化、Opus 5のscope creep外部観測とtask別effort benchmarkを分離（2026-08-14・確度はclaim別）
- [models/benchmark-snapshot-20260811.md](models/benchmark-snapshot-20260811.md) — Artificial Analysis v4.1.1 と SWE-bench Pro の現行 snapshot。task 型・effort・harness・tokenを併記し、総合点を「幅広い思考力」へ一般化しない（2026-08-11）
- [models/xai-grok46.md](models/xai-grok46.md) — Grok 4.6: 公式価格・effort、vendor/独立benchmark、Xの統括・監査・実装の成功/失敗報告、Spotter修理後のclean再評価、Composer catalog不在（2026-08-14・確度はclaim別）
- [models/role-placement-experiment-20260819.md](models/role-placement-experiment-20260819.md) — 役割配置実験: 948行・変異10件でのfinder 3席、claims14件の反証3席、Luna medium/max比較。各セルn=1で一般化禁止（2026-08-19）
- [models/xai-grok45-composer25.md](models/xai-grok45-composer25.md) — Grok 4.5 / Composer 2.5の旧世代snapshot。現行配置はxai-grok46.mdを正とする
- [tools/chatgpt-chat-quota-mcp-survey.md](tools/chatgpt-chat-quota-mcp-survey.md) — ChatGPT Chat枠×MCP の実勢: 公式経路なし・ヘッドレスは Cloudflare 壁（独立2ソース）・oracle 最成熟で乗り換え先なし・Web2API 再訪条件・oracle 0.15.2 実装読解＋導入実測の罠3件（undici EINVAL 即死／hideWindow 送信破壊／Google SSO ブロック）（2026-07-11・確度は claim 別）
- [tools/gpt-connector-macos-window-launch.md](tools/gpt-connector-macos-window-launch.md) — macOSの固定offscreen座標が複数displayでclampされる罠と、窓なしcold起動→background最小化target→正規PID unhide、Window ServerのPID/layer 0検査、`Page.bringToFront`復帰で画面上窓0・実Chat成功を満たす契約（2026-07-14・実機再現）
- [hooks/callout-hooks-firing-behavior.md](hooks/callout-hooks-firing-behavior.md) — 呼びかけ hook 群の発火挙動実測（Claude C1-C4／Codex X1-X5）と現行INFO契約: セッション初回＋compact再武装、Stop pending配送、PreToolUse additionalContext、hot-reload、Codex async/trust、状態ファイル形式（2026-07-12・確度 reproduced・実火観測）
- [orchestration/bell-orchestration-map.md](orchestration/bell-orchestration-map.md) — 二レーン版オーケストレーション全景マップ（SVG＋解説）: 通常は親直で原子的に完了し、統括だけF/A/Hと利益のある委譲を使う。Elastic統括ゲートと回収契約は維持したv3（2026-07-16・確度高）
- [codex/codex-full-support-foundations.md](codex/codex-full-support-foundations.md) — dotagents Codex 全対応の公式仕様基盤: 9監査面、公式 skill 面 `$HOME/.agents/skills`、legacy `~/.codex/skills` 実測、import は同期でなく検出器、plugin は二重管理防止を実証後に裁定。Wave 2 のclean HOME受入れとCI parser固定も記録（2026-07-12・確度高）
- [codex/subagent-thread-limits.md](codex/subagent-thread-limits.md) — Codex subagentの公開設定 `agents.max_threads`（既定6）／`max_depth`（既定1）と、Desktopセッション側の低い実効上限を分離。旧「max_threadsは起動エラー」説を公式仕様で訂正（2026-07-13・確度はclaim別）
- [codex/windows-hook-shell-contract.md](codex/windows-hook-shell-contract.md) — Codex 0.144.6のhookはturn shell経由。Windows PowerShellでquoted executableを起動するにはcall operator `&` が必要という正規形と実機受入条件（2026-07-20・確度高）
- [windows-powershell7/factory-shell-contract.md](windows-powershell7/factory-shell-contract.md) — Windows工場shellをPowerShell 7へ統一し、Aiterm／psmux／shellの責務を分離する契約。Microsoft公式WinGet導入経路付き（2026-08-25・確度高）
- [codex/hook-trust-surface-2026.md](codex/hook-trust-surface-2026.md) — `/hooks`は対話Codex CLI専用のreview／trust入口。Codex App／IDEでは通常promptになり得るため、remote CLI trust後にApp新規threadで実火する（2026-07-21・公式manual＋実測）
- [codex/raw/openai-codex-hook-trust-surfaces-20260721.md](codex/raw/openai-codex-hook-trust-surfaces-20260721.md) — OpenAI公式CLI／IDE slash commands・Hooksの一次ソースpointer（2026-07-21）
- [codex/raw/openai-codex-hook-command-runner-0.144.6.md](codex/raw/openai-codex-hook-command-runner-0.144.6.md) — OpenAI Codex 0.144.6 hook command runner一次ソース verbatim（2026-07-20）
- [codex/raw/openai-subagents-2026-07-13.md](codex/raw/openai-subagents-2026-07-13.md) — OpenAI公式 Subagents 文書のverbatim保存（2026-07-13）
- [macos-launchd-local-network/apple-tn3179-launchd.md](macos-launchd-local-network/apple-tn3179-launchd.md) — macOS 15+のLaunchAgentはTerminal/SSH子と異なりLANがLocal Network Privacyで遮断される。Apple公式のresponsible code要件、短命alert既知問題、管理端末向けCIDR許可と再起動条件、Mac実機再現（2026-07-14・確度高）
- [wsl-relay-recovery/wslrelay-banner-timeout.md](wsl-relay-recovery/wslrelay-banner-timeout.md) — Windowsのwslrelayがlocalhost:2222をlistenしてもWSL ssh.socketへ届かないbanner timeoutを実測。relay単体の公開再登録入口はなく、稼働processがある間はterminate/shutdownせずmaintenance windowで再起動する（2026-07-14・確度高）
- [orchestration/openai-cdc-prompt-concepts.md](orchestration/openai-cdc-prompt-concepts.md) — OpenAI CDC promptの動的fan-out、approach family、独立context、blocked再開条件、敵対監査、完全性gateを抽出し、dotagents固有のF/A/H・worktree・Executor stateへ適応（2026-07-14・確度高）
- [orchestration/provider-quota-and-claude-runtime.md](orchestration/provider-quota-and-claude-runtime.md) — Claude Stop／background session／headless continuation、Claude 5h・7d RateLimitEvent、Codex product-owned quota eventを一次仕様と現Macで照合。Observer同provider伴走と両社rate-aware配置の入口を固定（2026-07-15・確度はclaim別。2026-07-16失効注記: 未login・background Observer・`--bare` Consultationは後続正典ADR 0032/0033/0043で訂正済み）
- [mcp-observer/observer-stdio-contract.md](mcp-observer/observer-stdio-contract.md) — MCP 2025-11-25公式仕様から、Observer stdioのnewline framing、initialize gate、固定tool schema、structured result、通常tools/callでの長時間waitを抽出（2026-07-15・確度高）
