# Cursor Origin の実測仕様

出典: Cursor Origin（cursor.com/codebase）と Origin CLI の実測（unai repo）。取得日: 2026-08-29。確度: 実測は高、β のため仕様変更の可能性あり。

## 同期の挙動

- 同期モード（Sync from GitHub）が唯一の実用形。Origin remote への push は GitHub へ素通しされ、tag も素通しされる（unai v0.1.0 で実測）。
- PR は両方向に同期する。Issues・Actions・secrets は同期しない。
- Origin 生まれの repo を GitHub へ自動反映する機能は無い。切り離し（detach）すると Origin が正になり、GitHub へは流れなくなる。
- Origin の公開範囲はチーム内だけで、公開 OSS の顔（topics・Social preview 相当）は無い。
- 初期 β・有料プランのみ。

## 導入

- CLI: `curl -fsSL https://downloads.cursor.com/origin/install.sh | sh`（`~/.local/bin/origin` に入る）。
- 認証: `origin auth login`（ブラウザ承認）。git の credential helper が自動で設定され、以後 https の push/pull に追加設定は要らない。
- 同期の追加: cursor.com/codebase → Sync from GitHub → repo を選ぶ（管理者権限が要る）。
- remote の配置例（unai）: `origin` = `https://origin.cursor.com/<ns>/<repo>.git`、`github` = GitHub 直。
