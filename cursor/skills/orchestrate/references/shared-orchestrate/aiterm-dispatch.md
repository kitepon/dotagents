<!-- GENERATED FILE: 直接編集禁止。 -->
<!-- Sources: shared/orchestrate + docs/02_models.md + lib/orchestrate/lane-admission.mjs + claude/skills/orchestrate/references/workflow-templates.md -->
<!-- Regenerate: node bin/render-orchestrate-skill-references.mjs --write -->
# aiterm dispatch appendix（外部実行レーンの運用型）

この文書は委譲契約（[delegation-contract.md](delegation-contract.md)）のhost共通dispatch appendixである。aiterm永続PTY経由で子エージェント（Codex/Claude/Grok/Composer）を外部実行レーンとして使う時の運用だけを定め、任務・安全・受入の共通契約は複製しない。

## 親の専任

- 親が自ら手を動かすのは**裁定・Packet作成・受入（diff実読＋gate再実行）・commit**だけ。それ以外の作業（docs編集・調査・fixture準備を含む軽微な実作業すべて）は子レーンへ委譲する。
- オーナーに見せる画面系成果物（UI・図・レポート）は、裁定チェックリストへの適合確認と、文脈ゼロの初見の読み手による誤読・詰まりの検品（文脈を持たない別エージェントへの批評委譲を含む）を通過したものだけを提示する。
- workerが未解決点・妥協として申告した箇所は達成に数えず、差し戻すか提示時の冒頭で明示する。
- 親は待ち時間に必ず統括の仕事を進める——完了レーンの受入、次波Packetの弾込め、別repoへの調査レーン発射。親が手空きでターンを終えるのは、全レーンの受入が済みdispatch可能な仕事が尽きた時だけ。
- 親は受入待ち・裁定待ちが発生する度に、進行中planの残件から並行して切れる独立作業を貪欲に走査し、依存衝突（同一ファイル・同一worktree・順序依存）のないレーンを追加dispatchする。
- レーン追加を抑制するのは依存衝突がある時だけとし、受入コストの軽いread-only調査・調書・診断レーンは特に積極的に張る。

## 完了受信（v0.16契約）

- 起動・送信は非ブロックdispatchだけを使う（launcher／`pty_send`は`event_cursor`付きで即返る。待つMCP呼び出しは存在しない）。
- 完了受信は**レーンごとにhostバックグラウンドの`aiterm-wait --session <id> [--cursor <event_cursor>] --timeout <作業長に応じた秒数>` 1本だけ**で行う。waiterのexit時はreceiptの`outcome`を読んでから処理する——完了として扱ってよいのは`done`だけ。`timeout`は未完了＝同一sessionで再武装、`closed`はsession消滅として扱う（exit codeでの完了判定は誤り）。
- 結果回収は`pty_read(agent_transcript:true)`だけ。走行中レーンへの先回りtranscript取得・同一レーンへのwaiter多重・自前pollingループは、正規の完了受信に対する劣化コピーなので作らない。
- token削減で折りたたまれた長文報告は、同一sessionへの再掲dispatch、または「指定1ファイルだけ書込許可」の追撃指示で回収し、次レーンのPacketへはそのファイルパスで渡す。

## レーン構成

- read-only調査レーンは数の制限なく並列してよい（別repoへの並列も自由）。同一repoへの並列writerは委譲契約の「並列化の検討とLattice既定」に従い、writerは専用worktree＋明示ファイル集合で走らせる。
- writer完了後の追加波は、新sessionでなく**同一sessionへの追撃dispatch**（直列・文脈資産の再利用）を既定とする。
- 子の初回ターン走行中は介入できない（dispatchは初回応答完了後だけ受け付けられる）。走行中に生まれた裁定・訂正は、受入時の差分指示として同一sessionへ送る。
- 契約クリティカルな設計・裁定は、merge前に旗艦×high のrefuterレーンで反証を通す（モデル×effortの配置は[docs/02_models.md](02_models.md)の表から明示。反証で「文書の穴」と「実装の欠陥」を区別し、実装が正しければ受入を維持して仕様側を追補する）。
