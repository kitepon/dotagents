# 03_settings-fragments —  各端末 settings.json の推奨断片カタログ

<!-- 前提: 2026-07 時点の Claude Code settings 仕様。機微（トークン・認証情報・個人の絶対パス）はこのファイルに書かない＝リポにコミットしない -->

`~/.claude/settings.json` と各リポの `.claude/settings.json` は端末固有・リポ固有（コミットしない。dotagents の gitignore 済み）。このファイルは「各端末で貼る断片」のカタログであり、適用は手動または skill 経由で行う。

## 読み取り系 Bash の permissions.allow（グローバル推奨）

プロンプト削減の基本セット。破壊系（rm・push・install）は**入れない**——都度確認が正:

```json
{
  "permissions": {
    "allow": [
      "Bash(git fetch:*)", "Bash(git status:*)", "Bash(git log:*)",
      "Bash(git diff:*)", "Bash(git branch:*)", "Bash(git stash list:*)",
      "Bash(ls:*)", "Bash(rg:*)", "Bash(grep:*)", "Bash(find:*)",
      "Bash(wc:*)", "Bash(head:*)", "Bash(tail:*)", "Bash(readlink:*)",
      "Bash(du:*)", "Bash(file:*)", "Bash(which:*)", "Bash(bash -n:*)"
    ]
  }
}
```

## リポ別 allowlist の作り方（正規手順）

手書きせず **fewer-permission-prompts skill** を各リポで実行して生成する（実際のトランスクリプトから頻出読み取りコールを抽出して優先順位つきで提案してくれる）。生成物はそのリポの `.claude/settings.json` に入る＝P3 標準の必須要件。

## コア製品repoへのアクセス断片（dotagentsだけ）

dotagentsセッションからコア製品repoへ直接手を届かせるのは、この断片を dotagents の `.claude/settings.local.json` へ貼った端末だけとする。`.claude/` はこのリポの gitignore 対象＝端末ごとに貼る。

対象は[工場の現行状態](factory-current-state.md)で自作コアに分類された製品の正規repoだけとし、MarkItDown（第三者・repoなし）、基盤toolchain、`*-wt-*` / `*-worktrees` の作業ツリーは含めない。`<HOME>` は各端末の home 絶対パスへ置換する:

```json
{
  "permissions": {
    "additionalDirectories": [
      "<HOME>/Developer/Caveat",
      "<HOME>/Developer/Throughline",
      "<HOME>/Developer/Spotter",
      "<HOME>/Developer/Lattice",
      "<HOME>/Developer/gpt-connector",
      "<HOME>/Developer/aiterm-mcp",
      "<HOME>/Developer/codex-sidecar",
      "<HOME>/Developer/aishell",
      "<HOME>/Developer/ServerManager",
      "<HOME>/Developer/peertable",
      "<HOME>/Developer/unai"
    ]
  }
}
```

- 置き場は dotagents の `.claude/settings.local.json` だけとする。project の `.claude/settings.json` へ書いた付与は workspace trust ダイアログを承認した後にだけ効き、グローバル `~/.claude/settings.json` へ書くと全 project がコア11repoへ到達する。
- パスは絶対パスで書く（`~` 展開は公式ドキュメントに明記がない）。実在する repo だけを列挙し、無い行を残さない。
- 反映は次セッションの起動から。当該セッション内だけ足すなら `/add-dir <path>` を使う。
- `additionalDirectories` が与えるのはファイルアクセスだけで、その先の `.claude/` 設定（skills・agents・CLAUDE.md）は読み込まれない。それらが要る時は起動時 `--add-dir` かセッション中 `/add-dir` を使う。

## hooks の方針

- 自動化（「毎回 X したら Y」）は memory や指示ではなく hooks でしか成立しない——必要になったら update-config skill で settings.json に組む。
- **Caveat hookは手挿ししない**: 工場はCaveatの一回setup入口だけを呼ぶ。対応host、生成物、再適用条件は[Caveat README](https://github.com/kitepon/Caveat#readme)を正とする。
- **Spotter hookは手挿ししない**: 対象projectでは `spotter install -y` だけを呼ぶ。生成物・host別hook・連携オプション・再適用条件は[Spotter README「Install」](https://github.com/kitepon/Spotter#install)を正とし、dotagentsのhook断片へSpotter entryを複製しない。
- **Lattice導線hookは手挿ししない**: 一撃展開は `lattice hooks install --host <host>` をhostごとに一度呼ぶ。対応host、platform、生成物、statusの意味は[Lattice integration package「hooks導線」](https://github.com/kitepon/Lattice/blob/main/docs/01_integration-package.md#L116-L121)を正とする。

- **Claude hook の正規入口**: [`../bin/apply-claude-config.sh`](../bin/apply-claude-config.sh) が下記のGit破壊操作ゲートを `~/.claude/settings.json` へ冪等に追加し、廃止したdotagents hookの登録を取り除く。既存entry・model・permissions・他ツールの設定は変更しない。
- dotagentsが配るhookは、機械でしか防げない実害の大きい事故を止めるものだけとする。規範の案内・計画の催促・委譲の形式検査はhookで行わない。

### Git破壊操作ゲート（PreToolUse・Bash）

`git checkout -- <pathspec>`／`checkout .`、worktreeを戻す`restore`、`clean -f`系、`reset --hard`、`stash drop`／`clear`を検知する。対象pathspec（不明時はworktree全体）に未commit差分がある時だけ`P12_UNCOMMITTED_DESTROY`でdenyし、branch切替checkout、`restore --staged`のみ、clean・非git・status失敗はallowする。退避は`stash push`またはdiffのpatch保存を使う。`DOTAGENTS_GIT_DESTROY_GATE=off`で無効化できる。

```bash
S=~/.claude/settings.json
if ! jq -e '.hooks.PreToolUse[]?.hooks[]?.command | select(.=="~/.local/bin/git-destroy-gate-hook")' "$S" >/dev/null; then
  cp "$S" "$S.bak-git-destroy-gate"
  tmp=$(mktemp)
  jq '.hooks.PreToolUse += [{"matcher":"Bash","hooks":[{"type":"command","command":"~/.local/bin/git-destroy-gate-hook","timeout":5}]}]' "$S" > "$tmp" \
    && jq -e . "$tmp" >/dev/null && mv "$tmp" "$S"
fi
```

## 適用チェック

- 適用後、`/permissions` 相当の UI か新セッションでプロンプト頻度が下がったことを確認。
- allowlist に書いた覚えのないコマンドが増えていたら要調査（設定の出所を必ず特定する）。
