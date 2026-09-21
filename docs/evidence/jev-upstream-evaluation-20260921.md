# Jev上流実装のMac評価記録

2026-09-21の実測。[導入時点の記録](jev-upstream-adoption-20260921.md)に続く評価。上流コードを改変せず、標準入口を使用した。

| 対象 | 導入 | 実操作 | 残件 |
|---|---|---|---|
| jev-ultrafast | 公式checkoutでuv sync成功 | 1リンク遷移5/5成功、2リンク遷移5/5成功。1リンク比較は通常操作9.444秒、Jev1.261秒（中央値） | 文字生成モデルのキー設定・入力確認 |
| agent-desktop | 公式npm、公開CLI起動成功 | 計算機の目標を標準run.mjsへ渡すとPERM_DENIEDで停止 | アクセシビリティ一覧へのバイナリ追加 |
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

## ブラウザの反復評価

同じ起動済みChromeで、`https://example.com`を新しいタブに開き、Learn moreを押して`https://www.iana.org/help/example-domains`の表示を確認する課題を各5回実施した。

| 回 | Codex + 通常Computer Use | 上流jev-ultrafast | 通常操作の結果 | Jevの結果 |
|---|---:|---:|---|---|
| 1 | 15.028秒 | 2.111秒 | 成功 | 成功 |
| 2 | 9.444秒 | 1.261秒 | 成功 | 成功 |
| 3 | 11.072秒 | 1.171秒 | 成功 | 成功 |
| 4 | 9.406秒 | 1.281秒 | 成功 | 成功 |
| 5 | 8.840秒 | 1.193秒 | 成功 | 成功 |
| 中央値 | **9.444秒** | **1.261秒** | **5/5成功** | **5/5成功** |

この課題ではJev経路が約7.49倍速く、所要時間は約86.6%短い。ブラウザの単純なリンク遷移について、実動作と高速化を確認できた。

計測条件:

- 通常操作はこのCodexセッションから`cua_repl`のChromeネイティブ操作を使用。タブ作成直前から遷移先のAX観測完了までを計測し、その間のCodex判断・ツール往復を含めた。
- Jevは同梱`examples/run.py`を無改変で使用。標準CLIを起動する直前から終了までを外側から計測し、CLI起動、Chrome接続、開始ページの読込、Jev判断、操作、完了判定、タブ終了を含めた。計測のためのコードを製品の操作ループに入れていない。
- Chrome本体とBrowser Harness daemonは起動済み。両経路とも計測前に同じページを表示済み。Chromeの起動時間や初回導入時間は含まない。
- ユーザーの認証回答が途中に入った通常操作の準備回を、開始後に中断扱いとし集計から除いた。その後の5回は全件掲載した。Jevの5回を先に実行したため順序は無作為化していない。
- 比較したのは利用経路全体。AXとDOM、接続方式、モデル判断の違いを含む。1課題・5回から、複雑な操作や他サイトの成功率、あらゆる操作の高速化率は推定しない。

続けて、Example.comからLearn moreを開き、さらにIANA-managed Reserved Domainsリンクを開く2操作の目標を、上流CLIへ一括で渡した。途中にCodexの判断を挟まず5回とも`https://www.iana.org/domains/reserved`に到達し、`done`で終了した。

| 回 | Jevの総時間 | 操作数 | 結果 |
|---|---:|---:|---|
| 1 | 2.291秒 | 2 | 成功 |
| 2 | 1.568秒 | 2 | 成功 |
| 3 | 1.390秒 | 2 | 成功 |
| 4 | 1.628秒 | 2 | 成功 |
| 5 | 1.642秒 | 2 | 成功 |
| 中央値 | **1.628秒** | **2** | **5/5成功** |

2操作課題はJevの連続動作確認であり、通常操作との速度比較は実施していない。

## 検証と未完了

上流の`node scripts/jev/run.test.mjs`は成功。製品コードは変更していない。デスクトップはオーナーがTouch ID認証を完了したが、アクセシビリティ一覧へのバイナリ追加が残る。Computer Useからのファイル選択確定が反映されないため、対象フォルダを表示して手元での選択を依頼した。ブラウザ文字入力は別モデルのAPIキー待ち。どちらも未確認を成功として扱わない。

デスクトップの標準入口には、起動済みの計算機へ「7 + 5を計算し結果12で終了する」という目標を渡した。0.23秒で`the screen could not be read: PERM_DENIED`、終了コード1。Jev判断に到達していないため、これをデスクトップJevの速度や判断能力の測定値には含めない。
