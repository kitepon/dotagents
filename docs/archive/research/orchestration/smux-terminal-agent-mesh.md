# smux — ターミナルを共有面にして AI エージェント同士を対話させる

- 出典: @AiAircle34052（Aircle 学生AIコミュニティ）2026-03-29 https://x.com/AiAircle34052/status/2038144179822645459（1116 bookmarks・詳細は動画＋GitHub）
- 取得日: 2026-07-04
- 確度: 中（要旨は本文から明確。GitHub 実物は未評価＝**導入前に検証必須**）
- 関連: docs/02_models.md・[[ai-collaboration-as-code]]
- 注記（2026-07-11）: 本文中の `bin/delegate.sh` と「現構成」記述は**当時のもの（delegate.sh は廃止済み）**。委譲の現行入口は codex-sidecar MCP と aiterm 永続PTY（正典 docs/02_models.md）。smux 自体も aiterm PTY と機能重複のため不採用（orchestrate skill 協業ループ節）。

## 要旨

- **smux**: Claude Code と Codex を**ターミナル上で会話させる**ツール。
  - AIエージェント同士がターミナルで通信。**API 不要・プロトコル不要**。ターミナルが共有インターフェース。
  - **bash を実行できる AI なら何でも参加可能**。
  - 例: Claude Code が設計 → Codex がレビュー → また Claude Code が設計、を全自動連携。
  - GitHub 公開済み。「エージェント間連携の決定打になる可能性」と評される。

## うちへの含意

- うちの現構成は **Fable(統括) → aiterm PTY → `delegate` → codex exec（単発・一方向委譲）**。smux は同じ「ターミナル＝共有面」の発想で、**双方向の対話ループ**（Claude 設計 ⇄ Codex レビュー）に拡張する。
- 02_models.md の「第三者視点レビュー＝Codex review」を、対話ループとして回せる可能性。工場の将来オーケストレーション候補。
- ただし **aiterm PTY で既に「ターミナルを共有面に外部 AI を叩く」は達成済み**。smux 追加の是非は「双方向ループが単発委譲＋統括裁定より本当に優るか」を実測してから（原則7: 外部依存は上位互換が確認できた時だけ）。

## 実測評価（2026-07-04・実物 README/install.sh を精査）

- 正体: **ShawnPana/smux**。`curl -fsSL shawnpana.com/smux/install.sh | bash` で `~/.smux/` に tmux 設定＋`tmux-bridge` CLI を入れる。tmux-bridge が任意ペインを read/type/keys（＝エージェント間通信）。tmux 設定は `~/.config/tmux/tmux.conf` に symlink（既存はバックアップ）。tmux 3.2+。
- **核心機能（tmux-bridge のペイン read/type/keys）は、うちの aiterm-mcp が既に MCP ツール `pty_read/pty_send/pty_key` として提供**（機能重複）。2026-07-04 の全作業を aiterm PTY 経由で codex を叩いて実施済み。

### 裁定: smux 本体は不採用（ベル 2026-07-04）

理由:
1. **機能重複**: tmux-bridge = aiterm-mcp の pty_* ツール。
2. **競合リスク**: smux が `~/.config/tmux/tmux.conf` を symlink＝aiterm の tmux 運用と競合しうる。冒す益がない。
3. **供給網**: `curl|bash`＋tmux-bridge 実体は未検証（バックアップは取るが）。
4. **原則7**: 外部依存は上位互換が確認できた時だけ。smux は aiterm の同等〜下位互換で上位互換でない。

### ただし「価値」は本物＝aiterm＋delegate で実現（不採用でなく吸収）

- クオ君が「有効」と見た能力＝**Claude⇄Codex 協業ループ**（設計→レビュー→再設計）は本物。
- それを **`delegate review`（本日追加）＋aiterm PTY** で実現済み。2026-07-04 に「Codex にランブックをレビューさせ→ベルが裁定→修正」を実走し、Codex が verify-install の実バグを発見＝協業の価値を実証。
- **うちの優位**: smux の全自動対話と違い、**1往復ごとに統括（ベル）が裁定**する＝品質 > 自動化。orchestrate に協業ループの型として記録。

### 運用知見（2026-07-04 ドッグフーディング）

- `delegate review` は動作する（codex exec --sandbox read-only を叩く。ランブックレビューで完走・実バグ発見の実績）。ただし **review は read-only 精読で数分かかる**（delegate.sh 自身のレビューは5分超で完走前に手動中断＝正常な長考）。delegate 内蔵 timeout を 300→600s に引き上げ済み。
- 運用: review は PTY で非同期に叩き、完了を待って裁定する（同期ブロックしない）。timeout はハング救済の最後の砦であって、正常完走を待つ時間ではない。
