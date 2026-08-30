# 製品文書自律化 — 稼働host受入証拠

取得日: 2026-08-30。

## 判定

文書整理、製品repoへの所有返還、再発防止CI、現在稼働しているhostでの受入は完了した。全端末受入は完了していない。FOXが停止しているため、9製品のWindows nativeとWSL2 jobがqueuedのままであり、それらをgateにするreleaseとServerManager deployは実行していない。

## 文書整理の実績

| repo | archive本文 | 互換stub |
|---|---:|---:|
| Caveat | 10 | 0 |
| Throughline | 12 | 4 |
| Spotter | 5 | 2 |
| Lattice | 44 | 37 |
| gpt-connector | 4 | 0 |
| aiterm-mcp | 22 | 11 |
| codex-sidecar | 5 | 1 |
| AIShell | 22 | 0 |
| ServerManager | 12 | 7 |
| Peertable | 29 | 25 |
| unai | 0 | 0 |
| dotagents | 15 | 3 |
| **合計** | **180** | **90** |

完了plan、旧release記録、古い監査、役目を終えた設計は物理的にarchiveへ移した。既存の固定pathを消費者が参照する90件だけは短い互換stubを残し、本文を自動読込の現行面から外した。同義の現行規範は各製品のREADME、current contract、runbook、ADRへ統合した。Decisionと証拠は意味が似ていても別の裁定・観測なのでマージしていない。

dotagentsのcurrent文書面は156件から90件へ減った。最終証拠を含む全文書515件は、generated 6、current 90、contract 1、history 251、evidence 167へ分類される。archive本文、互換stub、固定path inventoryはdigestで凍結し、本文改変、未登録archive、archive導線以外の切れた参照、移動記録と本文の同時削除をCIで拒否する。

## 所有境界

- 各製品repoがinstall、configuration、state、schema、migration、diagnostic semantics、recovery、update、releaseと製品CIを所有する。
- dotagentsが所有するのは製品集合、host/wire、公開入口、schema ID、adapter projection、privacy、横断受入だけである。製品の内部commandや合否を複製しない。
- 10製品の文書CIを各repo内へ収め、clean checkoutでも現役索引、archive/stub、Markdown・HTML参照を検査できるようにした。CommonMark/GFM構文木、HTML parser、`srcset` parserを使い、正規表現による参照推測を廃止した。
- Desktop overlayとAFK Pilotは、それぞれのrepoで`scripts/update-overlay.sh`を所有する。dotagentsの`update-grok-community-overlay`は二つの公開入口を呼ぶだけで、git、試験、build、release、deploy、rollbackを持たない。
- unaiの一行規範を共通憲法へ追加し、Claude、Codex、Grok、Cursorの生成面へ配布した。unai v0.2.1を公開し、GitHub main `f0de0c94f38f9387ecbfbf8c376618802842f6ba`のCIも成功している。

責務境界の正本はADR 0133、製品所有CIはADR 0134、Community overlayの製品所有入口はADR 0135である。

## 製品commitと公開CI

| 製品 | 受入commit | 公開CI |
|---|---|---|
| Caveat | `98eb4afa0030acbf2182ab708ef94e004e04a4d0` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/Caveat/actions/runs/33291591547) |
| Throughline | `bb22ffa8472dca49d1b784188bc22e08ab6b3c0c` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/Throughline/actions/runs/33291456466) |
| Spotter | `85d7c8349818a66ace735aa7da7ed0d3168f5d78` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/Spotter/actions/runs/33291444485) |
| Lattice | `4bd31bebdc23fd1c840278b23773db16492743c8` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/Lattice/actions/runs/33295669282) |
| gpt-connector | `5fe42637d294601e069874ba521d5d386ac38438` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/gpt-connector/actions/runs/33293765715) |
| aiterm-mcp | `c9efcb84f1a6056db559422705f1125a2e8b078c` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/aiterm-mcp/actions/runs/33292512355) |
| codex-sidecar | `459405795b2548646c845a462d71d60248cdba59` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/codex-sidecar/actions/runs/33292316962) |
| AIShell | `ec9b5ee13596d1ba2dfce6b082c16fc5d1ac3418` | [全job成功](https://github.com/kitepon/aishell/actions/runs/33292907333) |
| ServerManager | `500041df9d3f7634ac00a720fb58777052824ee8` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/ServerManager/actions/runs/33290504327) |
| Peertable | `282275662722a7475a9719a4393c25221161b24e` | [ownership・classify・macOS・Linux成功、Windows・WSL2 queued](https://github.com/kitepon/peertable/actions/runs/33292606877) |
| unai | `f0de0c94f38f9387ecbfbf8c376618802842f6ba` | [全job成功](https://github.com/kitepon/unai/actions/runs/33295680935) |
| Desktop overlay | `31e38152c39e81a371b5d8de20aa9a6f22ff2314` | [integration・test成功](https://github.com/kitepon/grok-build-desktop-kitepon/actions/runs/33295977901) |
| AFK Pilot | `2f8275a36165ad3898b152e24be93e9113cb10e2` | [gate成功](https://github.com/kitepon/afkpilot-kitepon/actions/runs/33296112036) |

上表のCaveatからPeertableまでの9製品は、同じself-hosted FOXがWindows nativeとWSL2を所有する。2026-08-30T06:28Zの再確認でも`192.168.1.11`は2 packet中0応答だった。

## focused検証と通し試験

- dotagentsの文書検査24件、正典移行56件、constitution parity、4 AI面のskill smoke、clean-home導入、Community overlay接続器、host別setupを個別に確認した。
- 最後にdotagentsの`make ci`を1回実行し、exit 0を確認した。
- 製品repoは上表のcommitでlocal gateを通した後にpushし、稼働runnerの公開CI結果を取得した。
- DesktopとAFK Pilotの変更は製品所有の更新入口、試験、文書だけなので、無関係なreleaseとdeployは行っていない。

## 途中で検出して根治した回帰

- AFK PilotのLinux CIは、Mac User-Agent文字列だけを設定してClient Hintsと`navigator.platform`をLinuxのまま残していた。Playwright contextの端末情報を一貫させて修正し、製品gateをgreenにした。
- LatticeのLinux Node 24は、大きな正常出力を`spawnSync`の既定bufferで`ENOBUFS`にしていた。実際のbyte上限とprocess errorの判定を分離し、macOS・Linuxのfocused testと公開CIをgreenにした。
- dotagentsの全文書分類が`.lattice/todo/evidence/`をcurrent扱いしていた。証拠分類へ追加し、Lattice証拠内の固定製品数を現行値driftと誤判定しないtestを追加した。
- clean-homeのGrok互換negative testが、login済みだけを検査する現行契約へ追従していなかった。隔離fixtureへlogin条件を与え、実装契約を変えず試験を修正した。

## 未完の外部gate

FOX復帰後に、上表9 runのWindows nativeとWSL2が完了するまで待つ。全job成功後だけ、Caveat v0.18.1、Throughline v0.10.4、Spotter v1.6.3、Lattice v0.67.6、gpt-connector v0.4.19、aiterm-mcp v0.29.9、codex-sidecar v0.3.12、Peertable v0.8.40のreleaseとServerManager deployを進める。それまではLatticeの最終taskとControlの`complete`を閉じない。
