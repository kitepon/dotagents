# Jevデスクトップの公式版切替と実操作結果

2026-09-21。このMacで、上流コードを改変せずデスクトップのJev実操作を確認した。[画面取得エラーの診断](jev-desktop-launcher-diagnosis-20260921.md)に続く記録。

## 導入した組合せ

| 対象 | 採用した上流資産 |
|---|---|
| agent-desktop本体 | 公式npmの0.4.7。標準npm installerでグローバル導入 |
| agent-desktop Skill | 上流v0.4.7。標準skill-installerで本体と版を合わせた |
| jev-desktop | 上流HEAD `7a8e4a10281c7319733aa200fd79501f34529716`のSkillと`run.mjs` |
| 起動元 | このMacのCodex標準shell。既存のAccessibility権限で実行 |

0.9.2の画面取得エラーは、[Appleが省略可能と定めるキー](https://developer.apple.com/documentation/coregraphics/optional-window-list-keys)である`kCGWindowOwnerName`を必須として扱う実装に起因する。対象アプリへの絞り込み前にこのキーを要求するため、名前のない別ウィンドウも取得全体を止める。上流git履歴でこの処理の導入をv0.5.0と確認し、その直前の公式v0.4.7を別のnpm prefixで試したところ、同じ計算機のsnapshotが成功した。

この結果を受け、標準の`npm install -g --allow-scripts=agent-desktop agent-desktop@0.4.7`で本体を切り替えた。自作wrapper、パッチ、独自の判定処理は追加していない。Skillの置換前には`~/.config/dotagents/backups/agent-desktop-skill-before-v047-20260921/`へtarと旧ディレクトリを保存した。

## 計算機の実操作

初回は、上流`run.mjs`へ「計算機で7 + 5を計算し、結果12を表示したら終了する。」を渡した。7、加算、5、計算実行の4クリックをJevが選び、3.92秒で`done`。独立したComputer UseのAX観測でも式`7+5`と結果`12`を確認した。

続けて、同じ目標を5回測った。各回の開始値は0。時間はNodeの標準コマンド起動から終了までを外側で測り、リセットと独立した結果照合は含めない。途中にCodexの操作判断は挟んでいない。

| 回 | 終了までの時間 | 実際の表示 | 結果 |
|---|---:|---:|---|
| 1 | 1.310秒 | 7 | 自信不足で加算前に停止 |
| 2 | 3.238秒 | 12 | 成功 |
| 3 | 3.530秒 | 12 | 成功 |
| 4 | 3.230秒 | 12 | 成功 |
| 5 | 1.237秒 | 7 | 自信不足で加算前に停止 |

成功は**3/5**、成功した3回の中央値は**3.238秒**。停止した回は上流の`confirm`判定であり、終了コード0だけで成功と数えていない。初回の準備確認3.92秒は5回の集計に含めない。通常Computer Useとのデスクトップ速度比較はしていない。

第1回後、試験準備用のsnapshotが計算機の本文ではなく`WindowSharingSessionButton`だけを持つ小窓を返し、リセット処理が目標の呼出し前に停止した。上流`list-windows`で小窓と計算機本体を区別し、`focus-window`で本体を選んで第2〜5回を続行した。以後の開始値リセットとウィンドウ選択は計測外。失敗した第1回も集計に残した。

## 日本語の文字入力

テキストエディットに新しい空文書を作り、上流`run.mjs`へ`--text 'Jev 動作確認 2026-09-21'`と「空の文書の本文へ用意した文字列を入力し、入力を終えたら終了する。」を渡した。

最初の呼出しは共有用小窓を選んで`blocked`となった。上流`focus-window`で`名称未設定`の本文ウィンドウを選ぶと、Jevは`TYPE_TEXT`を1回実行し、標準`set-value`で入力、1.24秒で`done`。独立したComputer Useで本文の完全一致を確認した。試験文書は保存確定せず、結果を確認できる状態で開いてある。

旧版の`launch com.apple.TextEdit`は、アプリが存在してもbundle IDでウィンドウを照合できず30秒後に`APP_NOT_FOUND`となった。今回確認した呼出しには、実際の表示名`計算機`・`テキストエディット`を使用した。

## このMacからの利用と評価

デスクトップは`/Users/kite/Developer/agent-desktop`を作業ディレクトリとして、Codexの標準shellから上流`node --env-file=/Users/kite/.config/dotagents/credentials/typesafe/api.env scripts/jev/run.mjs --app <表示名> <目標>`を呼ぶ。文字列を入力する目標では上流の`--text`へ入力内容を渡す。複数ウィンドウがある時は、上流の`list-windows`と`focus-window`で作業対象を選ぶ。既存Aiterm永続シェルのTCC帰属問題は直しておらず、その経路をこのMacで動作確認済みとは扱わない。

**導入と両製品のJev実操作は成立した。** ブラウザは[反復比較](jev-upstream-evaluation-20260921.md)で単一リンク5/5・2リンク5/5成功。デスクトップはクリックと日本語入力に成功したが、計算機の反復は3/5で停止率が高く、無人で任せ切れる成功率とは評価しない。ブラウザ文字入力用の別モデルのAPIキーは未設定で、その機能の確認は残る。
