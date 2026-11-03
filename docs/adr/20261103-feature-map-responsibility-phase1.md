# 導入・設定・更新・台帳の責務整理：第1設計

日付: 2026年11月3日。所有者: Dotagents。状態: 構造整理の方針を採用、実装前の接点確認待ち。調査基準はmain `9fca2c8`、現状図の候補は`3656c0e`。Astra xhighの適用を確認して設計した。全体リファクタの最終整合確認とは別の工程である。

[全体の現状図](../09_feature-map.md)から[導入](../feature-map/installation.md)、[設定](../feature-map/configuration.md)、[更新](../feature-map/update.md)を読む。本書は改善理由と採否の正本であり、現状の詳細図を複製しない。未調査の機能について設計完了とはしない。

## 採用する最初の変更

v2・v4・v5に重複している**toolchain台帳の既定path解決と読取り**を、`lib/factory/toolchain-ledger.mjs`へまとめる。このファイルは計画上の配置先で、まだ存在しない。既存の`bin/factory-toolchain-ledger.mjs`はrecord CLIと保存・排他の所有者として残す。wireごとの診断投影は各wireに残す。

[提案図の描画](../feature-map/toolchain-reader-design.svg) / [提案図原本](../feature-map/toolchain-reader-design.mmd)。これは未実装の依存関係であり、現状図へ実装済みとして混ぜない。

理由は、同じ保存物を読む3か所に、path、file検査、schema、許可値、読取失敗の写像が複製されているため。台帳の読取契約だけを直す際に、3wireの診断処理まで追う必要がある。共通readerにまとめれば、台帳を読めない原因を一つの実装へ辿れる。新設定・新CLI・汎用ストレージ層は要らない。

## 責任と受渡し

| 責務 | 所有する窓口 | 決定と受渡し |
| --- | --- | --- |
| 規範の合成 | `render-global-constitution.mjs` | 維持。正本とdeltaから生成物を作る。全出力transactionは追加しない |
| 配置・退役link回収 | `install.sh` | 維持。symlink作成/固定退役だけを持ち、実ファイルSKIPを検査成功へ置換しない |
| 配置後の検査 | `verify-install.sh` | 維持。link/config/hook probeの結果を起動者へ返す。親session認識とは別 |
| 親固有config変換と保存 | 4config applier | 維持。親ごとの退役判定、未作成面、backup、rollback範囲を各入口が持つ |
| source同期 | `agents-source-update.mjs` | 維持。checkout検査/ff-onlyと同期結果を所有し、失敗flag付きでupdaterへ制御を渡す |
| 更新と確定の順序 | `agents-update.sh` | 維持。製品更新→pending→診断→final record→同report finalizeの制御を所有。記録/診断/配送の実体は既存窓口へ渡す |
| 台帳record/排他/書込み | `bin/factory-toolchain-ledger.mjs` | 維持。CLI引数・既存state受理・record lock・ACL・保存・終了コードを持つ |
| 台帳path/読取り | 計画: `lib/factory/toolchain-ledger.mjs` | **採用**。pathを受け、既存検査を経た`{ value, error }`を返す。読めない場合も既存どおりunavailableとする |
| 台帳から診断への投影 | `v2.mjs`、`v4.mjs`、`v5.mjs`の`applyToolchainLedger` | 維持。世代による重大度/post-gateの意味を共通readerへ持ち込まない |
| 同reportの更新確定 | `v5.mjs:finalizeToolchainReport`とschedule runner | 維持。ID照合/既診断保持とrunnerの保存/queue/receiptの責務を分けたまま使う |
| 工場自身の失敗履歴 | `update-failure-report.mjs`とCLI | 維持。open/resolved/unsentの状態と受理後の保持を所有。台帳やoutboxとの一括transactionを作らない |

この所有者は製品内のコード責務を示す。Host OS/他製品内部/他writerの管理や実trust接続を引き受ける意味ではない。

## readerの窓口と保持する契約

新moduleのexportは既存名の`defaultToolchainLedgerPath(targetPlatform)`と`readToolchainLedger(path)`の2つに限る。schema検証の補助関数は必要な役割ごとに読める大きさへ分けるが、module内部に置く。loader/validatorの差替え引数、policy、class、registryは追加しない。

| 境界 | 保持する内容 |
| --- | --- |
| 既定path | 呼出時の環境変数を読む。WindowsはLOCALAPPDATA、USERPROFILE/homedirの順。その他はXDG_STATE_HOME、HOME/homedirの順。module import時の値へ固定しない |
| file検査 | lstatのregular file/symlink/1 MiB上限とPOSIX owner-only modeを保持。mode判定は既存の`process.platform`であり、path選択用targetPlatformで置換しない |
| parseとschema | JSON全体、exactなtop-level/record keys、schema_version、3product、status/reason、nullまたは既存version形式、canonical UTCを保持 |
| version | 文字列型を要求する既存reader正規表現を保つ。更新CLIのstrict SemVer parserへ置換しない。先頭0やprerelease等を新たに正規化/拒否しない |
| 成功 | 読んだledgerを変換せず`{ value, error: null }`で返す。呼出元のscan/投影順序は変えない |
| 不在/不正/読取失敗 | 既存のcatch範囲を維持し`{ value: null, error: 'toolchain_ledger_unavailable' }`。既存stateを作成・修復・削除せず、失敗詳細やpathをwireへ増やさない |
| 取消/後始末 | 新しいAbortSignal、retry、timeout、file lockを加えない。読取の途中失敗は上記返値、上位process強制終了の結果は従来どおり不明。readerはtempや書込stateを作らない |
| 公開接点 | scan/finalizeの既export名、引数、返却形、CLI名、report ID/observed_at/ACK metadataを保持。新moduleに読み出し時の副作用やトップレベル実行を置かない |

`semver/exact/utc`等が各wireで他の診断にも使われている場合、それらまで移動・削除しない。未使用importの除去も全参照を確認したものに限る。

## 採用しない代替案と理由

### writerとreaderのvalidatorをただちに統一する

見送り。writerの`validateRecord`は`SEMVER.test(value)`を使い、readerは`typeof value === 'string'`を要求する。例えばJSONのversionが`["1.2.3"]`の場合、writer側の正規表現は暗黙変換の結果で通り得るがreaderは拒否する。これはコードからの設計上の反例であり、実機で起きた故障の報告ではない。今回、writerの既受理入力を黙って狭めたりreaderを緩めたりしない。

writerにはENOENT時の空ledger生成、読取側にはサイズ/mode上限とunavailable写像という別の境界もある。strict/legacy等のpolicy flagを新設して一つの汎用validatorへ詰める案も採らない。まず同じ読取責務3か所をまとめる。書込み側との共通化は、残る受理差をSolで全確認し、挙動変更を伴わず意味がある場合に次の設計まとまりで判断する。

### 全wireの台帳投影をまとめる

見送り。v2/v4にはoperationまたはpost-gate失敗をfailへ投影する旧契約があり、v5には起動根拠によるwarn/high、latest確認失敗のunverified、post-gate失敗のunverifiedがある。共通readerを入れても、旧wireの出力を最新wireへ更新しない。全wireの呼出関係・外部利用はSolの次工程で確認する。

### 4applierを汎用transaction/command parserへ置き換える

見送り。config-only/複数file、Grok hookのunlink、未知hook保持、Windows引用、symlink拒否、exit/例外形式には違いがある。共通化には複数のpolicyと新しいPython import/配布経路が必要になる。今回は親別の所有が既に分かれており、共通化で削れる重複より保持契約とcaller追従が増える。既`lib/hook-command.py`への集約は全親hook調査後に適合を判断する。

### updaterを段階ごとの新scriptへ切り分ける

見送り。既source同期・台帳・runner・失敗reportの公開窓口で処理本体は分かれている。Bashの段階を外部scriptへ分けると、現在の変数・結果flag・report IDを新しい引数やfileで受け渡す必要がある。OS callerとtransport調査前に再試行や部分成功の意味を変えない。長い行/関数の整形は、その責務を変更する差分に限定する。

### ACL/atomic保存/lockを全機能共通の層へまとめる

保留。台帳record、runner owner、失敗state、outbox、GPT writerは保持/信頼/排他の単位が異なる。未読callerが残っている。renameの原子性、fsync耐久性、read-modify-write排他、全更新期間の直列化を一つの保証として扱わない。新lockやlost-update修理を、この設計上の観測だけから始めない。

## Sol実装前の接点確認と検証

まず次の範囲を実コードから確定する。211件の参照索引は候補に留まり、v2/v4の新たな接点を追記する。全体未読の完了数へ加算しない。

| 対象 | 必要な確認と受入根拠 |
| --- | --- |
| 実caller/alias/export | v2/v4/v5のpath/read使用箇所、scan exportとv6〜v9の継承、finalize runner、拡張子なしCLI・動的wire dispatch。旧wireの削除や外部caller不在を推測しない |
| 既存helperの依存 | 3readerの`exact/semver/utc`の意味と例外、関連Node importsを比較。違いが見つかればそのまま共通化せず、同じ責務内の保持策を記録する |
| 既存test/fixture | `tests/factory-scan/v2.test.mjs`、v4/v5/v6〜v9関連、`tests/update/finalize-report.test.mjs`、`toolchain-ledger.test.mjs`、`tests/factory-reporter/scheduler.test.mjs`、`cron-env.sh`。source文字列を検査するfixtureも追跡し、単に期待を削らない |
| 共通readerの最小試験 | 隔離fileで正常・null・version型/許容形式・exact key・未知product/status/reason・不正UTC・不正JSON・欠測・symlink・サイズ/mode拒否を確認。通常stateを読まない。OS条件を明記し、未実行Windowsを合格へ数えない |
| wire互換 | 旧wireとv5の投影差、post-gate失敗/到達不明、report ID/時刻/他製品check保持を既fixtureで確認。reader整理でプローブを追加しない |
| 配布/CI/config | 新moduleは既binからの相対importで到達するlib。新HOME link/CLI/envは不要。Makefile・CI分類・fixtureの実経路を読み、新testが既gateへ入ることを確認。共通JS変更をMarkdown-onlyとして扱わない |

接点が確定したらreader抽出を一つのSol差分として実装し、同差分で現状図を更新する。変更moduleの構文検査、focused reader test、影響する既fixture、文書link/図の描画・目視を通す。変更しない全製品試験・4host照合は反復しない。最終の全体通し試験/対応OSのCIは全機能整理後に既契約へ従って行い、今回の局所試験と区別する。

失敗や入力差を隠すために新設定・skip・権限を足さない。変更が既契約を維持できない場合は、その変更候補だけを止めて理由を記録し、残る全体調査を進める。

## 次の全体調査へつなぐ

reader整理後のSolのまとまりは、診断から報告保存・outbox・分割送信・受付・ACK・receiptまで。現在のupdate詳細から続けて、state所有と拒否/不明/取消/再送/後始末を確定する。実ネットワーク送信・実credential・Host操作は必要ない。

その後に親hook/skill/model、3OS setup/scheduler/製品公開setup、GPT writer/lease/authority、CI/配布の残りを全体図へつなぐ。並びは依存から調整できるが、機能の除外はしない。1Password現状と接点もこの全体に含め、任意化の挙動変更は全体完了後の別差分とする。

本書の完了は第1設計の完了だけを意味する。完成候補、適用済みAstraによる最後の全体整合、指導担当の成果確認、既承認手順の公開/反映結果は未完として別に保持する。

## 第1実装への接続

この設計時点の提案を実装し、[台帳readerの現状図と確認](../feature-map/toolchain-reader.md)へ接続した。上記の未実装表記は設計時点の記録であり、現在の所有・検証は現状図を参照する。
