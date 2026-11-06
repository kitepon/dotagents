# 規範生成・リンク配布・導入検査の現状

[全体入口](../09_feature-map.md) / [既README配置図](../../README.md#構成) / [詳細描画](installation.svg) / [図原本](installation.mmd)

基準main `9fca2c8`の本文から確認した現状。挙動変更前の記録であり、各失敗を新たに実機再現したとは扱わない。規範・設定・技能が配置されたことと、親の新sessionが認識して画面へ反映したことを区別する。

## 実装・所有者・返却先

| 対象 | 実ファイル・関数 | 状態/副作用の所有と返却 |
| --- | --- | --- |
| 規範生成 | `bin/render-global-constitution.mjs`の`parseArgs/normalizeDelta/render/atomicWrite/main` | repoがcommon/delta/生成5出力を所有。`--write`は出力ごとのtemp→rename、`--check`は比較のみ。drift=1、引数/読み書き等の例外=2、成功=0を起動者へ返す |
| link作成・退役link回収 | `install.sh`の`link_one/remove_retired_link`と4harness/binのloop | repo source→HOME symlink。既実ファイルはSKIPして保持。退役はリンク先が固定候補と一致するものだけ削除。set -eの途中失敗で先行作成分は残り、全体rollbackは無い |
| 導入検査 | `bin/verify-install.sh`の`check/verify_factory_core/verify_retired_codegraph_settings`、埋込Python検査 | 期待linkの一致、反対Codex面、実行権限、routing、hook等を検査しfail flagへ集約。入力不正=2、検査失敗=1、成功=0。HOME設定を読む。Cursorの一時HOMEでhookを起動する副作用もある |
| 設定適用の接続 | `bin/apply-{claude,codex,grok,cursor}-config.sh`の`main/backup/apply`、Codexの`prepare_write/apply_transaction` | [設定詳細](configuration.md)へ各変換関数と保存/途中失敗の違いを接続。既定dry-run、明示applyでbackup。Codexの2file transactionを他harnessへ一般化しない |
| hook照合 | `lib/hook-command.py:hook_script/command_matches`、Codex固有のcommand parser | 同名・引用・interpreterの識別を検査/適用が参照。複数の照合実装が存在する事実を記録。統合の可否・設計はAstra工程で判断する |

## callerと設定・test/fixture

### Recipient-based language policy (2026-11-06)

The following structured maps extend the existing generation/distribution contract. They change policy content, not the generator, installation algorithm, or configuration ownership.

| Function | Input / owner | Output and failure boundary |
| --- | --- | --- |
| Author the language policy | Owner instruction; `shared/constitution.md` owns the Dotagents rule | Replace the obsolete Japanese-only rule; preserve personality, voice, and roles |
| Generate harness instructions | Common constitution + four existing deltas; existing renderer | Five existing Markdown/MDC outputs; existing drift and write failures remain unchanged |
| Deliver compact Cursor instructions | `bin/cursor-constitution-hook.sh:compact_delivery`; current constitution above the inline cap | Recipient-based language guidance in the existing header; keep the cap, delta preservation, and read-once behavior |
| Define delegated work and reviews | Existing Claude/Grok/Cursor `agents/{implementer,refuter}.md` definitions | English reports/comments and reviewer responses; keep schemas, duties, permissions, and shell routing |
| Author reports and repository documentation | `shared/runbooks/reporting.md`, `claude/commands/polish-github.md` | Apply the common language policy to descriptions and artifacts instead of requiring or inferring Japanese |
| Distribute the policy | Published source; each terminal's existing checkout and instruction links | Fast-forward source updates reach existing instruction paths; preserve local changes and running sessions |

| Data flow | Completion evidence |
| --- | --- |
| Owner instruction → common policy → existing renderer → five generated outputs | Generation parity and the current language rule in those outputs |
| Published commit → terminal checkout → existing Claude/Codex/Grok/Cursor instruction path | Successful source update and policy presence at the deployed instruction paths |
| Updated instruction file → next harness instruction load | File deployment is distinct from rereading instructions inside an already running conversation |

呼出しの本文確認: Macはconfig apply→install→launchd登録→通常更新→verify。Linux commonもconfig apply→install→cron登録→更新→verify。Windows nativeのmanual setupはinstall→config apply等→日次登録→更新→verify、ScheduledRunではmanual部分を通らず更新/verifyへ進む。これらhost setup自体を今回実行しない。

- `bin/verify-constitution-parity.sh`→renderer check。`Makefile`のlint-constitution/test-constitution→そのwrapper/`tests/constitution/generation.test.mjs`。
- `tests/constitution/generation.test.mjs`は隔離root生成、drift拒否、入力不正、空delta、生成LFを検査する。生成5fileの一括原子性や強制終了cleanupを証明するfixtureではない。
- `tests/install/clean-home.sh`はofficial/legacy HOME、実ファイル/退役link、configとtransaction、CLI parser等のfixtureを持つ。後半を含む本文確認は[検証対応](verification.md)へ接続済み。実行結果と本文読取は区別する。
- 全候補の所在は自席の固定caller索引を使用する。動的basename/path構築、外部からのinstall起動、親におけるskillの実発火は未確定。

## 停止・取消・結果不明・後始末

rendererのatomicWriteは1fileごとにwrite→renameする。全出力のtransaction・tempをfinallyで削除する処理は無い。中断時に先行出力やPID tempが残り得る。これはsource観測上の制限であり、今回修理を混在しない。

installは受付時の引数検証を通った後、段階的にlinkを作成/退役する。途中失敗や強制終了で先行linkを巻戻さない。SKIPは既実ファイルを守る成功扱いなので、install exit0だけでは全正本への切替成立を表さない。verifyがその不一致を別途検出する。

verifyは多数の検査結果をfail flagへ集約する。Cursor hookのprobeはmktemp→コピー→実行→通常rmで、EXIT trapではない。強制終了時の一時directory清掃は保証されない。リンク/設定の検査成功、hook応答の契約成立、実際の親session認識は別の完了点である。

Codexのapply_transactionはBaseExceptionを受けると既置換分をrollbackし、rollback失敗も元例外と一緒に返す。kill等で例外処理が走らない場合の全体復旧・新session反映は未検証。Claude/Grok/Cursorの単file applyと複数呼出しを同じ原子性で扱わない。

1Password skillは現在、他のskillと同じloopで既定配布されverifyの必須対象になる。1Password本体の導入・認証を通常installが開始することとは別である。任意化の挙動修理は全体リファクタ完了後の別差分であり、本図の現状を先に変更しない。
