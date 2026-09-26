# JevによるComputer Use

所有: dotagents所有・Computer Use接続のL2正典。

ブラウザ操作はjev-ultrafast、デスクトップ操作はagent-desktopのJev実行ループを、上流の標準構成のまま使う（オーナー裁定）。自作のcodex-jev・jev-useは使わない。

## 製品の正本

- ブラウザ: [jev-ultrafast README](https://github.com/browser-use/jev-ultrafast)。接続は同梱依存の[Browser Harness](https://github.com/browser-use/browser-harness/blob/main/install.md)が所有する。
- デスクトップ: [jev-desktop Skill](https://github.com/lahfir/agent-desktop/blob/main/skills/jev-desktop/SKILL.md)。製品checkoutを作業ディレクトリにして呼ぶ。`agent-desktop`本体の公開コマンドは[上流README](https://github.com/lahfir/agent-desktop)が正。

## 一撃展開と更新

- 工場の標準セットアップと定期更新が、上流Gitのmain、jev-ultrafastのuv lock、Browser Harnessのuv tool、agent-desktopのnpm latestと公開Skill installerを呼ぶ。Browser HarnessのCLI配布はjev-ultrafastの構成要素として管理し、Jev内部の依存版は上流lockに従う。agent-desktopはMacだけに入れ、他OSはunsupportedとして報告する。
- オーナーが特定端末のfork導入を明示した場合は、その端末の`~/.config/dotagents/<製品ID>-fork.json`にGitHubの`repository`と40桁の`revision`を置く。agent-desktopは公式npm版を外してCargoで、Browser Harnessはuv toolで指定revisionを導入する。指定に不備や導入失敗があれば停止する。
- 定期更新は、対象の上流PRのマージ、修正を含む公式release、package registryの同版配布を確認してから公式版へ戻す。Browser Harnessは許可シート修正の前提PRも上流PRより先にマージされていることを要求する。確認不能な場合はforkを維持して更新失敗を明示し、未成立ならforkを維持する。公式版の導入と公開version確認が済んでから端末別指定を削除する。
- 導入結果は選択したpackage managerの終了結果で決め、定期報告は公開versionを読む。定期診断でGUIを起動しないので、versionが取れてもGUI操作は未検証として記録する。
- 上流は本体・操作・OS対応・製品設定を、dotagentsは公式入口の呼出し・工場キーの配布・結果の記録を所有する。上流の不具合を工場のpatchやwrapperで補修しない。
- 上流のコードや原文のSkillをdotagentsへ複製・改変せず、独自のwrapper・工程管理・判断や確認のAPIを作らない。観測・選択・操作の繰り返しは上流のJevループへ渡す。

## 工場が渡すもの

- TypeSafeキーは`~/.config/dotagents/credentials/typesafe/api.env`を、Nodeかuvの`--env-file`で読ませる。キー値を引数・ログ・Gitへ出さない。
- ブラウザの文字生成に使う別モデルのキーは、上流の`.env.example`に従って製品の`.env`へ置く。
- 対象hostへの導入や権限が未確認なら、その不足を確かめる。別の操作経路へ無言で切り替えない。
