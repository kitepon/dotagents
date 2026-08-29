# cursor-origin runbook — Cursor Origin の運用（2026-08-29 実測）

Cursor Origin は Cursor 社の Git 置き場（2026-08 初期β・有料プランのみ）。オーナーは Origin を作業の主へ移す方針で、unai repo が試金石（実測済み）。

## 実測済みの仕様（2026-08-29 時点）

- **同期モード（Sync from GitHub）が現状の唯一の実用形。** 形式上の正は GitHub のまま。Origin remote への push は GitHub へ素通しされ、**tag も素通しされる**（unai v0.1.0 で実測）。PR は両方向同期。Issues・Actions・secrets は同期対象外。
- **Origin 生まれの repo を GitHub へ自動反映する機能は無い。** 切り離し（detach）すると Origin が正になるが、その瞬間から GitHub へは一切流れない＝配布面（raw 配信・plugin marketplace・deploy webhook）が死ぬ。主従逆転はこの機能が出てから。
- Origin の公開範囲はチーム内のみ（公開 OSS の顔・topics・Social preview 相当は無い）。公開面の整備は GitHub 側で行う（polish-github skill §7）。

## 手順

- CLI 導入: `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`（`~/.local/bin/origin`）
- 認証: `origin auth login`（ブラウザ承認。git の credential helper が自動設定され、以後 https の push/pull は追加設定不要）
- 同期の追加: cursor.com/codebase → Sync from GitHub → repo 選択（管理者権限が要る。オーナー操作）
- repo の remote 配置（unai の型）: `origin` = `https://origin.cursor.com/<ns>/<repo>.git`（日常の主）、`github` = GitHub 直（控え）。push は origin へ送れば GitHub まで届く

## 罠

- β につき仕様は動く。本 runbook の断定は使う時点で再実測してから頼る（特に「Origin 生まれ→GitHub 反映無し」は解禁待ちの本命）
