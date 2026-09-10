# Windowsの公式Codex CLI導入

2026-09-10。[公開CI](https://github.com/kitepon/dotagents/actions/runs/34420616815)はMac/Linux成功、Windowsは試験前のcodex起動で終了code 127となった。

調査では、デスクトップアプリ管理のCLI 0.153.4が稼働する一方、通常PATHのcodexと公式npm導入が存在しなかった。CI専用の固定版をrepoへ加える案は、正規導入の不足を隠すためオーナーの指摘を受けて撤回した。workflow、package.json、lockの追加は公開していない。

オーナーは公式CLIの導入・更新を工場の責務として承認した。Aiterm SSHのPowerShell 7で公式npmの通常導入を実行し、codex-cli 0.154.0と公開commandを確認した。Git for WindowsのBashからも通常PATHで起動した。デスクトップ内部の版別pathやCI専用wrapperは使わない。

Windows初回セットアップでCodexが動かなければ公式npm導入し、起動を確認してから工場設定へ進む。通常更新は既存のagents-updateが公式npmの最新版を導入する。CIの実行commandは変更しない。[公式CLI文書](https://developers.openai.com/codex/cli)がnpm配布の根拠である。
