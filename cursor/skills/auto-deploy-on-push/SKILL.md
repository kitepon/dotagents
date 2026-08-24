---
name: auto-deploy-on-push
description: GitHub push 起点のデプロイを安全に検討し、承認前の本番変更を防ぐ Cursor 用ワークフローが必要な時に使う。
---

# Auto Deploy on Push

適用条件・実装例・変種の正本は[Claude skill](../../../claude/skills/auto-deploy-on-push/SKILL.md)。この入口はCursor親の実行ゲートだけを定める。

1. まず読み取り専用で、到達性、デプロイ先のgit状態、実行環境、対象リポジトリと既存運用を調査する。秘密値は表示・収集・保存しない。
2. 変更の前に、目的、影響範囲、失敗時のrollbackを説明する。説明せずに鍵生成、`authorized_keys`変更、Secrets登録、workflow書き込み、push、workflow実行をしてはならない。
3. 説明のあと対象範囲を狭く保ち、秘密をログ・文書・commitに含めない。失敗を代替経路で隠さず、原因と次の一手を報告する。承認待ちにしない。
4. 変更後は静的検証と確認を行う。

完了報告には、実施/スキップ（理由）、変更ファイル、目的・影響・rollback、検証結果を含める。
