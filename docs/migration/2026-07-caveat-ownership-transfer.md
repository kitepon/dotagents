# Caveat 所有移管の履歴（2026-07-11）

状態: 履歴。現行の導入・罠DB・同期・公開手順には使わない。現行手順は [Caveat README](https://github.com/kitepon/Caveat#readme) が正である。

2026-07-11 の commit `1461434` で、dotagents が保持していた旧 `caveat/` を廃止し、Caveat v0.15 以降へ所有を移した。これにより罠DBとその public/private 配布は Caveat 自身の責務になり、dotagents に残っていた旧 `*.private.md` の gitignore guard も撤去した。

移管後に dotagents README へ重複していた remote、認証、同期、公開、手動mergeの操作案内は、2026-08-30 に Caveat README へ統合して現行面から削除した。dotagents は以後、Caveat の公開CLIと公開diagnosticsを工場へ接続するだけである。
