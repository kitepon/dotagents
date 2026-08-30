# Grok Build Community overlayの工場接続

この文書は、Grok Build Desktopのkitepon overlayとAFK Pilotを工場へ接続する情報だけを扱う。各製品の導入・設定・状態・復旧・更新・build・deploy・releaseは各製品repoが所有し、dotagentsは代行しない。

## 工場契約

- Desktop overlayとAFK Pilotは、工場の製品IDやfactory wireの対象を増やさないCommunity overlayである。
- 公式`grok` CLIは第三者toolchainとして扱い、このoverlayの管理対象へ含めない。
- dotagentsが所有するのは、工場で使うrepoとhostの対応、公開接続点、跨製品の依存順序だけである。

## 工場での位置付け

| 面 | 工場の作業ディレクトリ | repo | 工場との接続 |
|---|---|---|---|
| Desktop overlay | `~/Developer/grok-build-vscode` | `kitepon/grok-build-desktop-kitepon` | 各席のDesktopとAFKへのuplink |
| AFK Pilot | `~/Developer/afkpilot` | `kitepon/afkpilot-kitepon` | main-serverの公開relay |

どちらも自作コア製品ではなく、単独repoの制御をdotagentsへ移さない。

## 製品側の正本

- Desktop overlay: `grok-build-vscode/KITEPON.md`、`docs/desktop.md`、`docs/desktop-update-spec.md`
- AFK Pilot: `afkpilot/docs/repositories.md`、`docs/CICD.md`、`deploy/kitepon/README.md`

製品の操作や障害対応では、上記の製品文書を直接読む。この文書へ手順や可変設定を複製しない。

## 工場が所有する接続

- 公開relayの工場上の接続先は`https://afk.kitepon.dev`、配置hostはmain-serverである。
- `bin/update-grok-community-overlay.sh`は、工場から両repoの`scripts/update-overlay.sh`を呼ぶだけの接続器である。更新・検証・pushは各製品入口が所有し、この接続器へ製品内部のcommandやrelease・deploy判断を置かない。
- この責務境界のDecisionは[ADR 0135](adr/0135-community-overlay-product-owned-update.md)を正とする。
- host対応と工場での利用可否は[host matrix](factory-host-product-matrix.md)へ記録する。

## 跨製品の順序

Desktopが新しいrelay契約を必要とする変更だけは、AFK Pilot側が互換契約と配備順を所有する。正本は`afkpilot/docs/repositories.md`と`docs/CICD.md`であり、dotagentsは依存関係を参照して工場smokeの順序へ反映する。
