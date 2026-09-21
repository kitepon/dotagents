# JevによるComputer Use

2026-09-21のオーナー裁定: ブラウザはjev-ultrafast、デスクトップはagent-desktopのJev実行ループを上流の標準構成で利用する。自作codex-jev / jev-useは不採用。

## 製品側の正本

- ブラウザ: [jev-ultrafast README](https://github.com/browser-use/jev-ultrafast)。目標と開始URLを渡す`Agent`または同梱の`examples/run.py`を使う。接続は同梱依存の[Browser Harness](https://github.com/browser-use/browser-harness/blob/main/install.md)が所有する。
- デスクトップ: [jev-desktop Skill](https://github.com/lahfir/agent-desktop/blob/main/skills/jev-desktop/SKILL.md)。製品checkoutで`node scripts/jev/run.mjs --app <対象アプリ> <目標>`を呼ぶ。`agent-desktop`本体の公開コマンドは[上流README](https://github.com/lahfir/agent-desktop)が正。

## 一撃展開と更新

工場の標準セットアップと定期更新から、上流Gitのmain、jev-ultrafastのuv lock、agent-desktopのnpm latestと公開Skill installerを呼ぶ。Browser Harnessは上流依存として導入する。旧版固定・自動降格はしない。agent-desktopの導入対象はMacだけとし、他OSはunsupportedとして報告する。

導入結果は公式installerの終了結果で決め、定期報告では公開versionを読む。権限要求、ブラウザ接続、操作セッションは利用時に製品の正規入口から行う。定期診断でGUIを起動せず、versionが取得できてもGUI操作は未検証として記録する。

上流は本体・操作・OS対応・製品設定を所有し、dotagentsは公式入口の呼出し、工場キーの配布、公開結果の記録・報告を所有する。上流の不具合を工場のpatchやwrapperで補修しない。

## 工場が所有する接続

工場配布のTypeSafeキーは`~/.config/dotagents/credentials/typesafe/api.env`をNodeまたはuvの`--env-file`で読む。キー値を引数・ログ・Gitへ出さない。ブラウザの文字生成に必要な別モデルのキーは、上流の`.env.example`に従って製品の`.env`へ設定する。

上流Skillは原文で導入し、実行時の作業ディレクトリは対象製品のcheckoutを使う。上流のコードをdotagentsへ複製せず、独自wrapper、工程管理、追加の判断・確認APIを作らない。通常の観測・選択・操作の繰り返しは上流のJevループへ渡す。

対象hostへの導入と権限が未確認なら、その不足を確認する。別の操作経路へ無言で切り替えない。OS・ブラウザが要求する認証や接続許可は、その標準手順で扱う。

今回のMac導入結果は[導入計画と記録](../../docs/plan_codex-jev-integration.md)を参照する。採用した公式版、OS権限が通る起動元、作業ウィンドウの選択と実測上の制約は、そこから辿れるMacの評価記録にまとめている。他hostへの導入済み宣言には使わない。
