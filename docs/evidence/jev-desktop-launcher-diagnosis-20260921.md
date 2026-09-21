# Jevデスクトップの起動元と画面取得の診断

2026-09-21。[反復評価時点](jev-upstream-evaluation-20260921.md)の「アクセシビリティ一覧へのバイナリ追加待ち」という原因判断を訂正する記録。ファイル追加の手元操作依頼は撤回した。

## 権限の確認結果

同じインストール済み`agent-desktop`の公開`permissions`を起動元だけ変えて確認した。

| 起動元 | Accessibility | Screen Recording |
|---|---|---|
| Aitermの既存永続シェル | denied | granted |
| Codexアプリの標準shell | granted | granted |

上流の[macOS案内](https://github.com/lahfir/agent-desktop/blob/7a8e4a10281c7319733aa200fd79501f34529716/skills/agent-desktop/references/macos.md)は、起動元アプリへの許可を基本とし、macOSが実行ファイルを個別に列挙した場合だけその許可も案内している。macOSのTCCログでも、両経路で責任を帰属させるアプリが異なることを確認した。既存永続シェルの`denied`だけから、端末全体で未許可・バイナリの手動追加が必須と判断したのは誤りだった。

Codexからの既存許可を確認後、上流CLIをそのまま実行した。権限DBの編集、追加の許可、製品コードの変更は行っていない。

## 現在の実操作阻害要因

このMacの計算機の表示名は`計算機`。`Calculator`では`APP_NOT_FOUND`になったため、観測済みの表示名で呼び出した。

```text
agent-desktop snapshot --app 計算機 -i --compact
```

結果は終了コード1、`TIMEOUT`。

```json
{
  "kind": "core_graphics_window_inventory_unstable",
  "attempts": 265,
  "churn_events": 265,
  "last_failure": "CoreGraphics window inventory omitted required field kCGWindowOwnerName",
  "retryable": true
}
```

続いて上流`run.mjs`へ「7 + 5を計算し、結果12を表示したら終了する」という目標を渡したが、6.10秒で`the screen could not be read: TIMEOUT`、終了コード1。Jevの操作判断に入る前の画面取得で止まっている。システム設定を観測すると、権限追加ダイアログは既に閉じていた。

上流ソースの`crates/macos/src/system/cg_window.rs`では、`records_from_dictionaries`が対象アプリの絞り込みより前に`kCGWindowOwnerName`を必須として読む。欠落すると再試行対象のエラーになり、期限までに取得できなければ今回のタイムアウトになる。画面取得が停止する箇所は特定できたが、欠落したウィンドウの所有者と欠落理由は未特定。

確認時点のnpm最新版は導入済みと同じ0.9.2、上流HEADも導入済みの`7a8e4a10281c7319733aa200fd79501f34529716`と一致した。更新だけで解消できる新しい上流版は確認できなかった。

デスクトップの実操作・性能評価は未完了。現在の阻害要因は権限追加待ちではなく上流の画面取得エラーである。ブラウザ版の動作・速度評価はこのエラーの影響を受けない。
