---
name: auto-deploy-on-push
description: GitHub push 起点のデプロイ構築を依頼された時に使う。既存の承認範囲を確認し、その範囲で調査・実装・検証を進めるCursor用ワークフロー。
---

# Auto Deploy on Push

適用条件・実装例・変種の正本は[Claude skill](../../../claude/skills/auto-deploy-on-push/SKILL.md)。この入口はCursor親の実行ゲートだけを定める。

1. まず読み取り専用で、到達性、デプロイ先のgit状態、実行環境、対象リポジトリと既存運用を調査する。秘密値は表示・収集・保存しない。
2. 変更の前に、目的、影響範囲、失敗時のrollbackを説明する。説明せずに鍵生成、`authorized_keys`変更、Secrets登録、workflow書き込み、push、workflow実行をしてはならない。
3. 説明のあと対象範囲を狭く保ち、秘密をログ・文書・commitに含めない。失敗を代替経路で隠さず、原因と次の一手を報告する。承認済みの範囲では承認待ちにしない。新たな対象・権限が必要な場合だけ、その操作の前に確認する。
4. 変更後は静的検証と確認を行う。

完了報告には、実施/スキップ（理由）、変更ファイル、目的・影響・rollback、検証結果を含める。
