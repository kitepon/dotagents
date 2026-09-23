# 聖典整理の後続作業

作成日: 2026-09-23。オーナーと合意した順序で進める。完了した段階は現在地に1行残す。

## 方針

- AIが自分で判断できることは、憲章・聖典・runbookに書かない。書くのはオーナーにしか決められないことと、AIが系統的に間違えることだけ。
- 書き換えを止める検査・安全装置は置かない。残すのは実際の壊れ（リンク切れ・生成物のずれ・導入失敗）を見つける検査と、未commit差分を消すgit操作のゲートだけ。

## 段階

1. **憲章（PLAN.md）**: 原則1（知能の使い所）・5（F/A/Hラベル）・8（重い検証構造）と、文書の作法の計画項目を削除して番号を詰める。世代交代の手順を model-ranking-authoring runbook へ置き直す。
2. **`pick-model`**: 任務を渡すとハーネス×モデル×effortを返す1コマンド。Jevへ02と利用枠の状態を渡して選ばせる。Codexの週次利用枠はCodexのセッション記録から読み、他のハーネスはレートリミットに当たった時に `pick-model --closed <ハーネス> --until <時刻>` で閉鎖を記録する。完了確認は代表任務での実呼出し。
3. **他の端末への反映**: main-server・rabbit・Windows nativeで正規のセットアップ入口を実行し、廃止したhookとorchestrate skillを外す。SSHで届かない端末はオーナー操作待ち。
4. **統括の残骸**: implementerの説明、lattice-workflow runbookのControl記録、docs直下の旧統括の互換stubと履歴文書、孤立したControl記録、端末メモリ。Lattice工程 `product-document-autonomy` は閉じる。
5. **全プロジェクトのAGENTS.md統一**: 1行importのCLAUDE.mdを削除、CLAUDE.mdだけのrepoはAGENTS.mdへ改名、両方に中身があるrepoは統合する。
6. **製品hookのコンテキスト消費**: Caveat・Spotter・Lattice・Throughlineの毎ターン注入を実測し、製品ごとに削減案を出す。
7. **runbookの点検**: 8本を同じ方針で見直す。

## 現在地

- 段階1完了（2026-09-23、`3c91a08`）。
- 段階2完了（2026-09-23）。9役割の代表任務で02の規則どおりの選択を確認。
- 段階4完了（2026-09-23）。Lattice工程 `product-document-autonomy` のpda-006を保留→退役。各repoの`.git/dotagents/orchestrate`（Control記録）、廃止hookのcacheと責務境界の宣言は`~/Archives/dotagents-retired-state-20260923T112731.tar.gz`へ保存してから削除。docs直下の旧統括の互換stubは、進行中のLattice計画から参照されうるため動かさない。
- 段階3（2026-09-23）: main-serverとrabbitは廃止hookとorchestrate skillの撤去まで反映済み。foxはsetup入口の`ssh -G main-server`がSSH越しの非対話実行で応答せず中断した。foxでの直接実行が残る。
- 段階3で見つけた別問題: main-serverの工場レポーターの送信先がwire v8のまま（入口はv9を要求して停止）。rabbitでcodex-sidecarのsetupが`SETUP_CONFIG_UNSUPPORTED`で失敗（smol-toml 1.9.0がnull prototypeのobjectを返し、往復確認のisDeepStrictEqualが不一致になる。Macは1.8.0で成功）。
- codex-sidecarを工場のコア製品から外した（2026-09-23、オーナー裁定）。導入・更新・setupをやめ、wire v9では対象外（not_applicable）として報告する。各端末のMCP登録とpackageは残っている。
- main-serverの工場レポーターをwire v9へ切り替えた（2026-09-23）。v9切替でsetup入口の検査とrabbit用の設定書込みはv9になったが、server profileの設定を書き換える手順がなかった。endpointをv9へ変えて`factory-reporter-scheduler install --apply`でcronをv9 runnerへ張り替え、setupは17製品の報告と配送確認まで通った。
- rabbitでnpmによるCodex CLI 0.156.0→0.156.1の更新がLinux本体のoptional dependencyを落とし、aiterm setupが`codex_parent_delivery_unavailable`で失敗した。工場のledgerは`post_version_unavailable`として正しく失敗を記録していた。公式の再導入で復旧。
- foxへの反映完了（2026-09-23）。止まっていた原因はWindows標準のssh.exeで、SSH越しの非対話sessionで出力を受け取ると終了しない（Win32-OpenSSH #1769）。工場のWindows SSHをGit for Windows同梱のOpenSSHへ切り替えた。あわせてfoxのdotagentsを`Developer\dotagent`から`Developer\dotagents`へ改名し、setupは17製品の報告と2時のタスクのsmokeまで通った。
