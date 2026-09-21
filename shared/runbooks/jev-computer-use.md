# JevによるComputer Use

2026-09-21のオーナー裁定: ブラウザはjev-ultrafast、デスクトップはagent-desktopのJev実行ループを上流の標準構成で利用する。自作codex-jev / jev-useは不採用。

## 製品側の正本

- ブラウザ: [jev-ultrafast README](https://github.com/browser-use/jev-ultrafast)。目標と開始URLを渡す`Agent`または同梱の`examples/run.py`を使う。接続は同梱依存の[Browser Harness](https://github.com/browser-use/browser-harness/blob/main/install.md)が所有する。
- デスクトップ: [jev-desktop Skill](https://github.com/lahfir/agent-desktop/blob/main/skills/jev-desktop/SKILL.md)。製品checkoutで`node scripts/jev/run.mjs --app <対象アプリ> <目標>`を呼ぶ。`agent-desktop`本体の公開コマンドは[上流README](https://github.com/lahfir/agent-desktop)が正。

## 工場が所有する接続

工場配布のTypeSafeキーは`~/.config/dotagents/credentials/typesafe/api.env`をNodeまたはuvの`--env-file`で読む。キー値を引数・ログ・Gitへ出さない。ブラウザの文字生成に必要な別モデルのキーは、上流の`.env.example`に従って製品の`.env`へ設定する。

上流Skillは原文で導入し、実行時の作業ディレクトリは対象製品のcheckoutを使う。上流のコードをdotagentsへ複製せず、独自wrapper、工程管理、追加の判断・確認APIを作らない。通常の観測・選択・操作の繰り返しは上流のJevループへ渡す。

対象hostへの導入と権限が未確認なら、その不足を確認する。別の操作経路へ無言で切り替えない。OS・ブラウザが要求する認証や接続許可は、その標準手順で扱う。

今回のMac導入結果は[導入計画と記録](../../docs/plan_codex-jev-integration.md)を参照する。他hostへの導入済み宣言には使わない。
