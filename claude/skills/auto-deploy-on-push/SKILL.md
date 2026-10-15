---
name: auto-deploy-on-push
description: GitHub への push を契機に、自宅サーバ等の SSH 到達可能なホストへ自動 docker compose デプロイするワークフローを構築する。「自動デプロイにして」「GitHub から hook で」「push したら反映されるように」と頼まれた時に使う。
---

<!-- 前提: 2026-07 検証。依存は外部仕様（GitHub Actions・gh CLI・docker compose v2）が主でモデル能力依存は低い＝モデル世代交代の影響小。外部仕様の変更時に見直す -->

# auto-deploy-on-push

GitHub Actions の runner（クラウド）から SSH でデプロイ先サーバに入り、`git pull && docker compose up -d --build` を走らせる仕組みを最小手数で構築するスキル。

セルフホスト Docker compose 構成の個人プロジェクト向けの定石。クラウド PaaS や Kubernetes は対象外。

## 適用条件（事前チェック必須）

実装に着手する前に **必ず全部確認**。ひとつでも × ならスキル末尾「変種」を検討する。

1. **SSH 22（または非標準ポート）が WAN から届くか**
   - 自分の WSL/PC が同 LAN にいる場合、ローカル名前解決が LAN IP を返す → そのままだと外部到達性を測れない
   - **本物の外部 probe** を走らせる（例: check-host.net の TCP API、3 ノード以上から）
   ```bash
   PUB_IP=$(curl -s "https://dns.google/resolve?name=<host>&type=A" | python3 -c 'import json,sys;print(json.load(sys.stdin)["Answer"][0]["data"])')
   CHECK=$(curl -s "https://check-host.net/check-tcp?host=<host>%3A22&max_nodes=3" -H "Accept: application/json")
   REQ_ID=$(echo "$CHECK" | python3 -c 'import json,sys;print(json.load(sys.stdin)["request_id"])')
   sleep 8
   curl -s "https://check-host.net/check-result/$REQ_ID" -H "Accept: application/json"
   ```
   全ノードで `time` フィールドが返れば open。`error` や空配列なら閉じている

2. **デプロイ先ディレクトリが git 管理されているか**
   - `ssh <host> "cd <deploy-dir> && git status && git remote -v"` で確認
   - デタッチド HEAD やローカル commit があると pull が衝突する

3. **`docker compose` または `docker-compose` が使えるか**
   - `ssh <host> "docker compose version"` で確認

4. **GitHub repo が Public か Private か**
   - Public でも問題ないが、Secret を扱うなら repo 設定の Settings → Secrets and variables → Actions が使えること

## 実装ステップ

### 1. デプロイ専用 SSH 鍵を生成

既存の個人鍵を GitHub Secret に置くのは事故の元。**use-case 限定の鍵**を別途作る。

```bash
ssh-keygen -t ed25519 -N "" -C "gh-actions-deploy-<project>" -f /tmp/gh_deploy_<project>
```

ed25519 推奨（短い・速い・GitHub も対応）。パスフレーズなし（GitHub Actions で対話できないため）。

### 2. サーバ側 authorized_keys に登録（command 縛り推奨）

公開鍵をそのまま追記すると、その鍵で **何でも実行できる**。デプロイコマンドに縛る:

```bash
PUBKEY=$(cat /tmp/gh_deploy_<project>.pub)
ssh <host> "echo 'command=\"cd <deploy-dir> && git pull && docker compose up -d --build\",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty $PUBKEY' >> ~/.ssh/authorized_keys"
```

これで「この鍵で SSH すると問答無用で `git pull && docker compose up -d --build` だけ走る」状態になる。盗まれてもデプロイ実行以外は不可能。

### 3. GitHub Secret に秘密鍵を登録

```bash
gh secret set DEPLOY_SSH_KEY --repo <owner>/<repo> < /tmp/gh_deploy_<project>
gh secret set DEPLOY_HOST --repo <owner>/<repo> --body "<host or IP>"
gh secret set DEPLOY_USER --repo <owner>/<repo> --body "<user>"
```

GH CLI 必須（`gh auth status` で認証確認）。

登録後は **ローカルの秘密鍵を即削除**:
```bash
shred -u /tmp/gh_deploy_<project> /tmp/gh_deploy_<project>.pub   # Linux (GNU coreutils)
rm -P  /tmp/gh_deploy_<project> /tmp/gh_deploy_<project>.pub     # macOS (shred は無い)
```

### 4. ワークフロー YAML を追加

`.github/workflows/deploy.yml`:

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:  # 手動実行も可能に

jobs:
  deploy:
    runs-on: ubuntu-latest
    concurrency:
      group: deploy
      cancel-in-progress: false
    steps:
      - name: SSH and run deploy command
        env:
          DEPLOY_HOST: ${{ secrets.DEPLOY_HOST }}
          DEPLOY_USER: ${{ secrets.DEPLOY_USER }}
          DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
        run: |
          mkdir -p ~/.ssh
          echo "$DEPLOY_SSH_KEY" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "$DEPLOY_HOST" >> ~/.ssh/known_hosts 2>/dev/null
          ssh -i ~/.ssh/id_ed25519 -o StrictHostKeyChecking=accept-new "$DEPLOY_USER@$DEPLOY_HOST"
```

`command=...` で縛っているので、`ssh` のあとにコマンド指定不要（指定しても無視される）。

### 5. 手動トリガで動作確認

push 待たずに動作確認できる:
```bash
gh workflow run deploy --repo <owner>/<repo>
gh run watch --repo <owner>/<repo>
```

### 6. ドキュメント追記

`README.md` に「main へ push すると自動デプロイ」と 1 行追記。CI バッジを足すなら badge URL は `https://github.com/<owner>/<repo>/actions/workflows/deploy.yml/badge.svg`。

## 罠 / 落とし穴

- **同 LAN 内からの SSH probe は WAN 到達性を保証しない**: hairpin NAT で内部 routing されているだけかもしれない。必ず外部 probe を使う
- **command= の最後にカンマを忘れる**: `command=` の値の後に `,no-port-forwarding,...` の連結がないと制限が効かない。書式を厳密に
- **既存 authorized_keys を破壊する**: `>` ではなく `>>` で追記する。リダイレクトミスは復旧不能
- **ssh-keyscan の出力**: stderr に warning が出るので `2>/dev/null` で握り潰さないと workflow log が散らかる
- **deploy 中の race**: `docker compose up -d --build` は短時間ダウンを伴う。ゼロダウンタイム必要なら blue/green か rolling restart に拡張する
- **本番 DB マイグレ**: アプリ起動時に migration が走る設計なら問題なし。手動 migration が必要なケースはこの SSH 方式では非対応 → CI 側に migration step を追加するか、手動運用に戻す
- **GitHub Actions の同時実行**: push が連続すると 2 つの workflow が並行で動き、`docker compose up` が衝突する。上のテンプレには `concurrency`（group: deploy・cancel-in-progress: false）を組込み済み——**削らない**
- **secrets リークログ**: ワークフロー内で `echo $DEPLOY_SSH_KEY` のような出力をすると GitHub が自動で `***` にマスクするが、Base64 経由で漏らすと素通り。デバッグでも秘密値を加工してログ出力しない

## 変種（事前条件 NG 時のフォールバック）

- **SSH を WAN に開けたくない**: GitHub Webhook → サーバ上の薄い HTTP receiver（`webhook` daemon や自作 expressエンドポイント）が `git pull && docker compose up` を実行する形。SSH より攻撃面は小さくできる
- **動的 IP しか無い**: DuckDNS などの DDNS で hostname 化する。GitHub Actions は hostname で SSH するので動的 IP でも問題なし
- **NAT で port forwarding が組めない**: Tailscale / Cloudflare Tunnel で穴を開けず VPN 経由。Tailscale の場合は GitHub Actions から `tailscale/github-action` で同じ tailnet に入って ssh
- **イメージレジストリ経由がいい**: GitHub Container Registry に push → サーバ側 Watchtower が pull して再起動。SSH 不要だが image registry 運用が増える
- **Cron で十分**: push 直後でなくていいなら、サーバ側 cron で `git pull && docker compose up -d --build || true` を 5 分おきに実行する（雑だが SSH も Webhook も不要）

## 完了基準

- `git push origin main` → 数分以内に本番コンテナが新コードで再起動している
- ワークフロー実行が GitHub UI で緑（緑バッジ）
- サーバ側 `docker logs` で起動メッセージが新しいタイムスタンプで出ている
