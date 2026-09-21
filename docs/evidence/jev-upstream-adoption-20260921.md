# Jev上流実装のMac導入記録

2026-09-21の実測。上流の実装を変更せず、macOSに標準導入した記録。

| 対象 | 導入 | 実操作 | 残件 |
|---|---|---|---|
| jev-ultrafast | 公式checkoutでuv sync成功 | Example.comのLearn moreを選択しIANAへ遷移成功 | 文字生成モデルのキー設定・入力確認 |
| agent-desktop | 公式npm、公開CLI起動成功 | 未確認 | macOSアクセシビリティ認証待ち |
| 自作codex-jev / jev-use | 標準uninstall成功 | 利用経路から除去 | repoは過去の記録として保持 |

## 取得元と導入面

- jev-ultrafast: [1231850a](https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46)。このMacのcheckoutは`/Users/kite/Developer/jev-ultrafast`。
- agent-desktop: [7a8e4a10](https://github.com/lahfir/agent-desktop/tree/7a8e4a10281c7319733aa200fd79501f34529716)。Jevスクリプトのcheckoutは`/Users/kite/Developer/agent-desktop`。本体は公式npmの0.9.2。
- 上流`jev-desktop`と`agent-desktop` SkillをCodex標準skill-installerで`~/.agents/skills`へ導入。上流ファイルは改変しない。
- TypeSafeキーは既存の工場配布envを使用。ブラウザには上流の`.env.example`に沿って非公開`.env`を作成した。キー値は本記録に含めない。

## ブラウザの実操作

同梱`examples/run.py`へ開始URL `https://example.com`と「Learn moreを開き、IANA Example Domainsが見えたら止まる」という目標を渡した。

| 上流CLIが表示した経過時間 | 操作数 | 状態 |
|---|---:|---|
| 1338 ms | 1 | ready |
| 1576 ms | 1 | ready |
| 1809 ms | 1 | done |

最後に観測したURLは`https://www.iana.org/help/example-domains`。途中にCodexによる操作判断を挟まず、上流Agentが観測・Jev判断・操作を繰り返した。所要時間は上流が計測するループの値で、ブラウザ接続や最初のページ取得は含まない。1課題1回であり一般的な高速化率を主張しない。

Chromeのremote debuggingはオーナーの操作直前承認を得て有効にした。上流の自動検出は起動中Chromeを認識できなかったが、Chromeが表示する接続先を上流標準の`BU_CDP_URL`へ設定すると接続した。Browser Harness診断のdaemon・browser connectionは成功。cloud authは任意で未設定。

## 検証と未完了

上流の`node scripts/jev/run.test.mjs`は成功。製品コードを変更していないため、自作の試験や追加ゲートは作成していない。デスクトップはOSのTouch ID待ち、ブラウザ文字入力は別モデルのAPIキー待ちで、どちらも未確認を成功として扱わない。
