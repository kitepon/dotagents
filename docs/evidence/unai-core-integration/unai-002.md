# unai-002 dotagents adapter・wire v8・導入更新契約

日付: 2026-08-29

## 実施

- 共通正本`shared/constitution.md`へ次の一行を追加し、生成物5面へ同文を配布した。
  `文章・返答の文体はunai skillの規範に従う。`
- unaiを自作コア11製品目として登録し、wire v8の15製品matrixへ追加した。
- macOS、Linux、WSL、Windows nativeの正規一撃展開と定期更新へ、unai公式installerを接続した。
- Windowsでは公式installerが生成する固定pathの`unai.ps1`だけをPowerShell 7で実行する。
  任意のPowerShell scriptを許可する汎用fallbackは追加していない。
- Node.js 24選択時はSnapのNode系commandだけを専用dirへ射影し、`/snap/bin`内のClaude等を
  横取りしないようにした。
- 隔離試験が実機serverへ誤接続しないよう、ServerManager readiness応答をfixtureへ固定した。

## 検証

- 共通正本と`claude/CLAUDE.md`、`codex/AGENTS.md`、`grok/AGENTS.md`、
  `cursor/AGENTS.md`、`cursor/rules/factory.mdc`で同じ一行を確認した。
- canon migration verifier: 56 entries pass。
- Windows PowerShell固定経路のfocused test: 13件pass。
- WSL／Linux一撃展開fixture、clean-home install、factory core smoke: pass。
- shellcheck: pass。

## 主なcommit

- `425f027`: unaiを工場コアとwire v8へ編入。
- `5117950`: Windowsの公式PowerShell CLI固定経路を追加。
- `c3667f7`: report生成中の時刻後退を吸収。
- `34a7608`、`6300782`: Snap Node選択時の他CLI横取りを解消。
- `b550de2`: factory core隔離試験のserver応答を固定。
- `97c4558`: Windows公式installerの固定`unai.ps1`を検証対象へ追加。
- `312a53f`、`a7853a6`: Windows隔離fixtureのPython配置を実行可能な公式install directoryへ固定。

## 変更面

- `shared/constitution.md`と全host生成物
- `lib/factory/contract.mjs`、`lib/factory/v8.mjs`
- `bin/install-unai.sh`と4 hostのsetup／update入口
- `lib/factory/windows-powershell.mjs`
- README、製品契約台帳、host matrix、wire v8設計、canon migration manifest
- 関連するfactory scan／reporter／installer test
