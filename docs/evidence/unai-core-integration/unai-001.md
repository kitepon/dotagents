# unai-001 製品診断契約

日付: 2026-08-29

## 実施

- `kitepon/unai`へ`unai --version`と`unai factory-diagnostics --json`を追加した。
- native diagnostics schemaは`unai.native_factory_diagnostics.v1`。manifest整合、Node runtime、skill bundleをread-onlyで診断し、絶対path・文書本文・secretを出さない。
- Bash installerへ`~/.local/bin/unai`を追加し、PowerShell 7用`install.ps1`を追加した。
- plugin/marketplace versionを`0.2.0`へ更新し、commit `46a5e3bbb07abbc6b7a46e7e514cb25e404e78c9`を`github/main`へpush、tag `v0.2.0`を公開した。
- GitHub ActionsのNode 20退役警告を解消するため、workflow-only commit `5eba14aeee878544423d65cda428d0fd8df84e74`で公式action v7へ更新した。配布tagは動かしていない。

## 検証

- `bash -n install.sh`: pass
- `node --test tests/unai.test.mjs`: 3件pass
- PowerShell parserによる`install.ps1`構文検証: pass
- GitHub Actions CI（Ubuntu / macOS / Windows）: 3 job pass
  - <https://github.com/kitepon/unai/actions/runs/33243938166>
- GitHub Actions Validate: pass
  - <https://github.com/kitepon/unai/actions/runs/33243938167>

## スキップ

- 校正規範とdomain overlayの変更: 編入に不要な機能拡張のため対象外。
- repo移動・改名: オーナーの別承認が必要であり、編入には不要。

## 変更ファイル

- `.claude-plugin/plugin.json`
- `.claude-plugin/marketplace.json`
- `bin/unai.mjs`
- `lib/diagnostics.mjs`
- `install.sh`
- `install.ps1`
- `tests/unai.test.mjs`
- `.github/workflows/ci.yml`
- `.github/workflows/validate.yml`
- `README.md`
- `README.en.md`
- `CONTRIBUTING.md`
