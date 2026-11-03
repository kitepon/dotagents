# 親別設定適用：所有・変換・保存の現状

[全体入口](../09_feature-map.md) / [導入接続](installation.md) / [描画](configuration.svg) / [原本](configuration.mmd)

基準main `9fca2c8`。4applierの変換・main・保存処理の本文を確認した。既存設定の値や実認証は読まず、hostにも適用していない。以下は現在の違いであり、共通化案の採否ではない。

## 所有する入力と出力

| 窓口 | 変換と入力 | 書込先・保持するもの | 検証と返却 |
| --- | --- | --- | --- |
| [Claude](../../bin/apply-claude-config.sh) | `update/matching_hook/command_path/canonical_hook_command`。現在のsettings JSONと固定HOOKS/RETIRED_HOOKSを読む | `HOME/.claude/settings.json`の工場hook。Bash/PowerShell matcher・timeout=5のゲートを追加/正規化、固定退役hookだけを除去。他hook/model/permissionsを保持 | top-level/hooks構造・commandのpath/引数を検査。差分なし/既定dry-run/apply成功は0。`main`は例外を上位で明示catchせずPython失敗として呼出元へ返す |
| [Codex](../../bin/apply-codex-config.sh) | `update_routing/migrate_deprecated_hooks_flag/update_hooks`。`HOME/CODEX_HOME`をOSに合わせ解決、元と提案のTOMLを公式CLI parserで確認 | `config.toml`の限定routing/旧hook flagと`hooks.json`の固定退役hook/ゲート。既ゲートの最初の位置を保持して重複を除く。model/login/他設定を保持 | `validate_toml`は一時HOMEへconfigを置き`codex debug prompt-input`を10秒上限で実行。dry-runでもこの一時処理はある。成功0、OSError/ValueErrorはstderr/1、その他例外はPythonの既定失敗 |
| [Grok](../../bin/apply-grok-config.sh) | `set_compat_claude_false/propose`と`propose_factory_hooks/rewrite_factory_hooks`。`GROK_HOME`またはHOME、repo hook正本を読む | `compat.claude.agents/hooks=false`と既存`hooks/factory.json`の実ファイル化。`--hooks-only`はconfigを読書きしない。hook面自体が不在なら新規生成しない。model/login/permission/製品MCPを保持 | Windowsは旧interpreterを外してnative commandへ。config symlinkは通常applyで拒否。差分なし/dry-run/成功0、例外はPython失敗。hook正本のJSON・構造を検査 |
| [Cursor](../../bin/apply-cursor-config.sh) | `propose_hooks/is_factory_hook_command/resolve_hook_entry`。repo factory.jsonと現hooksを読む | `CURSOR_HOME/hooks.json`だけ。工場hookは`.local/bin/cursor-*-hook`に限定。他製品の`cursor-parent-hook.js`等と利用者hookを保持。mcp.json/cli-config.jsonは対象外 | version=1のhook形、command/matcher/timeoutの工場項目を比較。hooks symlink拒否。成功0、上位catchは例外文字列をstderrへ出して2 |

## 保存・失敗・途中取消

全窓口が既定dry-run、明示`--apply`を持つ。提案の作成までは実configを保持する。applyで変化がある場合にだけ、元textをHOME/Archivesのtar.gzへ保存する。archive directoryは0700、archive/memberは0600。元ファイルが無い場合の空archiveや、Codexの外部CODEX_HOMEのmember名などの差は各入口の責務である。

Claude/Cursor/Grokのconfig `apply`は同directoryのtempへUTF-8書込→flush/fsync→元mode（新規0600）→replace、例外時の元text復元とtemp清掃を持つ。Codexは2fileを先に`prepare_write`し、変更順にreplace、例外時には既置換分を逆順に復元/新規分を削除、rollback失敗も返す。**この差を同じ複数file transactionとして説明しない。**

Grokはconfig適用後にhook実ファイル化を行う。`apply_factory_hooks`は元hookのlink/ファイルをunlinkしてからtempをreplaceし、hook失敗時にconfigを巻き戻す処理は無い。従って途中失敗ではconfigだけ変更済み、hookが不在、backupは残るという状態があり得る。新たな実機故障を再現した結論ではなく、sourceの制御フローからの現在の制限である。

BaseExceptionを受ける保存処理でも、強制kill等でfinallyが動かなかった場合のtemp/複数fileの整合は保証されない。applierの完了表示は保存処理の完了までであり、親sessionの再読込・画面反映・hookの実発火の完了ではない。

## caller・test/fixture・設定・export

直接callerはMac `run_setup`、Linux共通`run_setup/maybe_apply_grok_config/apply_cursor_config`、Windows nativeのmanual部分。Grokはlogin確認後だけ通常applierを呼ぶ。Windows ScheduledRunはmanualのconfig適用部分を通らない。`install.sh`は入口symlinkを配るがapplierを実行しない。

CLI scriptは実行入口が`__main__`であり、共通ライブラリとして公開exportしていない。testは`runpy`・実CLI・隔離HOME等で内部関数/振舞いへ到達する。全literal候補は進行正本側`config-update-caller-candidates.json`にline付きで保持し、履歴文書と実callerを区別する。

関連入口は`tests/install/apply-claude-config.sh`、`apply-grok-config.sh`、`apply-cursor-config.sh`、`clean-home.sh`、`codex-hook-dead-interpreter.sh`、host setup fixture、`tests/factory-scan/claude-hooks-windows.test.mjs`、Windows native source契約。dry-run/保持/冪等/既存symlink/rollback/Windows引用などを持つ。testを再走した記録ではなく、fixtureの存在/対象の本文読取である。clean-homeの全後半と全host fixture、動的・外部callerの意味確認は残る。

command解析と引用、backup命名、atomic保存が複数入口に存在する。違いにはhost契約/rollback/保持条件があるため、重複という見た目だけで共通化しない。採用/維持/代替案はAstra設計で判断する。

[追跡するsource/test参照候補（path・line・context）](config-update-references.json)を同じrepoへ保存する。固定baseの機械抽出候補であり、全callerの意味確認完了ではない。
