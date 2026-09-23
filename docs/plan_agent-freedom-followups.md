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

- 段階1に着手。
