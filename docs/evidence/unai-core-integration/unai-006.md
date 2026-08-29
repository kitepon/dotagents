# unai-006 正典同期・最終監査

日付: 2026-08-29

## 共通指示

人が編集する共通正本`shared/constitution.md`へ、次の一行を追加した。

> 文章・返答の文体はunai skillの規範に従う。

生成・配布面の`claude/CLAUDE.md`、`codex/AGENTS.md`、`grok/AGENTS.md`、
`cursor/AGENTS.md`、`cursor/rules/factory.mdc`で同文を確認した。
canon migration verifierは56 entries pass。

## 現行契約

- 自作コア: 11製品。unaiを含み、Observerを含まない。
- 現役wire: v8、固定15製品。v7はrollback／互換面。
- unai配布: 公開mainの公式installer。Windowsは固定配置`~/.local/bin/unai.ps1`を
  PowerShell 7で実行する。
- 4 host: Mac、Linux server、WSL2、Windows nativeでrequired。

## 今回潰した罠

- コア10／wire v7／将来編入という古い現在形を、コア11／wire v8／編入済みへ修正した。
- Windowsの任意PowerShell fallbackを廃し、公式installerの固定CLIだけを許可した。
- WSL2でSnap Nodeを選ぶ際、`/snap/bin`全体がClaude等を横取りするPATH汚染を解消した。
- report生成中の時刻後退でfailure時刻が観測時刻を越える欠陥を修正した。
- 隔離試験が実機ServerManagerへ接続する経路をfixtureへ固定した。
- host shellへ依存していたunai CLI試験を、注入runnerによるhost中立試験へ修正した。
- SpotterのWindows pipe close、worker deadline、空白を含むCursor pathを修正して1.6.2を公開した。
- Spotter 1.6.0／1.6.1の欠けていたGitHub Releaseを履歴tagから補い、1.6.2をlatestにした。
- Windows full CIが正常試験を20分で強制終了する誤設定を30分へ直し、factory-ci runbookへ正本化した。最終CIのWindows fullは28分4秒でgreenとなり、上限変更の必要性を実測した。
- Caveat同期で全host共通SSHを仮定した案内を撤回し、実測で成立したHTTPSとGitHub CLIの公式credential helperへ統一した。Windowsに残っていた無効な旧アカウント認証も除去した。
- Windows公式installerが作る拡張子付き`unai.ps1`を、拡張子なしCLIだけ探す検証器が見落とす欠陥を修正した。
- Windows隔離fixtureで`python3.exe`だけを複製し、必要DLLから切り離していた欠陥を修正した。失敗理由をunai検出失敗と誤断定していた案内も、fixture全体の不合格へ訂正した。
- AitermのWindows runtime error診断・記録が、正常時でも1.5〜5.6秒を要するのに2秒で強制終了される欠陥を製品側で修正した。Windows専用期限と2秒超の回帰試験を追加し、POSIXの2秒契約は維持した。
- Aiterm Changelogで0.28.2以降の比較linkが欠け、Unreleasedが0.28.1を指していた案内を0.29.6まで補正し、全release見出しのlinkをCIで固定した。

## 反証と受入

- 旧wire、旧製品数、Observerを含む記述を再検索した。ADR、完了済みhandoff、互換試験など、
  当時の事実として明示された履歴は改変せず、現行入口だけをv8へ揃えた。
- dotagents 4 host full CI: <https://github.com/kitepon/dotagents/actions/runs/33253778655>
- 30分上限の正典追記に対する文書CI: <https://github.com/kitepon/dotagents/actions/runs/33251000305>
- 最終Windows実配布後にBugHub readinessとdelivery更新を再確認した。
- Windows正規入口の実行ID`d97c594a-1522-4edc-b649-e346ac3a5bf8`と、そこから実際に
  起動した定期タスクの実行ID`8d60d417-e135-4d41-b189-8b45799e4090`を確認した。
  定期実行後のAiterm 0.29.6を含む15製品smokeはpassした。
- 4 hostのreportを同じ鮮度窓へ同期し、BugHub readinessのdatabase、schema、pull poll、
  factory ingest、factory delivery、source revisionがすべてpassすることを確認した。

## 結論

共通の一行、製品登録、導入・更新、wire、BugHub、4 host実配布、公開物、現行案内を同じ
実装事実へ揃えた。unaiの工場コア編入は受入可能。
