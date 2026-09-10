# WindowsのCaveat公開診断

2026-09-10。工場入口の本番実行前に、AitermのSSHセッションからPowerShell 7で`caveat factory-diagnostics --json`を実行した。

公開版は0.19.1。DB、同期、Claude、Cursorはready。Codexのuser_prompt_submit、post_tool_use、stopは`not_ready / feature_disabled`で、全体はnot_readyだった。

Caveat担当は、既存の`[features].hooks=false`を保持する公開契約どおりの結果と回答した。[製品README](https://github.com/kitepon/Caveat/blob/v0.19.1/README.ja.md)と[公開版の導入実装](https://github.com/kitepon/Caveat/blob/v0.19.1/apps/cli/src/codexHookInstall.ts)が根拠である。値から設定者は判別できないため、ユーザー本人による拒否とは断定しない。

工場の`docs/05_codex-fragments.md`も、現行hooks値を保持し、旧キーの移行だけを許可する。今回の入口切替を無効化解除の承認と解釈せず、公開結果をそのまま集約する。Caveat内部への手補正は行わない。Windows全機能readyの成立には、この明示無効化の扱いが別途確定する必要がある。

対象repoは既存の`C:/Users/kite_/Developer/dotagent`。main、clean、originはdotagentsであることを確認した。フォルダ名を変更せず、工場setupは実行していない。
