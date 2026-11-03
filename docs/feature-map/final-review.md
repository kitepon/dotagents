# Astra全体整合レビュー

2026年11月3日、gpt-6-astra/xhigh・fast OFF・適用acceptedを確認して実施。対象は基準main `9fca2c8bf002b9b0ac8bd22d13d8076142a02ff5`から候補`36dfb28bdd4d540acd27b711b33fd82c95af6a82`までと、本レビューによる現状文書の訂正。runtime実装は第3実装`095455f`から変えていない。

**三整理の責務・接続・保持契約は、固定sourceと局所検証の範囲で受入可能。新たなruntime是正事項は検出しなかった。全体の完成・公開可否は保留する。** 指導担当の独立成果確認と、未実行の3OS受入・公開/反映結果は別に残る。全fixture全文や実OSを確認済みにする判断ではない。

## 照合した範囲と根拠

[全体入口](../09_feature-map.md)から全機能詳細と現状Mermaid原本、[第1](../adr/20261103-feature-map-responsibility-phase1.md)・[第2](../adr/20261103-feature-map-responsibility-phase2.md)・[第3](../adr/20261103-feature-map-responsibility-phase3.md)の採否、[検証対応](verification.md)と既review記録を照合した。三整理の実装/追加fixture/既fixture変更、Makefile所属、実caller/import/exportも確認した。未変更source全行の独立再監査ではなく、各段階の本文確認・固定hashを使った全体整合レビューである。

| 整理 | コードと図の整合判断 | 保持できている境界 |
| --- | --- | --- |
| toolchain台帳reader | `toolchain-ledger.mjs`の2export→v2/v4/v5 scan・v5 finalize、v6〜v9継承を[現状図](toolchain-reader.md)から追跡。旧wireの残部一致根拠と新helper/試験本文を照合 | call-time path、file/mode/JSON/exact schema、unavailable返却。writerの受理差とwire投影差は残る。新書込み/修復なし |
| reporter CLI/巡回 | main→preview/enqueue/flush、lock内flushQueue→postOneと処分を[関数図](delivery-functions.md)から追跡。main前の本文一致、queueの空白以外一致を基準版から再照合 | OFFの読取順、endpoint/identity/ACK境界、処分順/counter/診断優先順位、postOneのpromise catch境界、controlled holdと通常retryを維持 |
| 8report reader | contract内private helper→元validatorと8public async入口。旧v1/v2/v4、v5〜v8 WIRE、GPT閉鎖entryのV9を確認 | read errorは元error、UTF8/JSONだけ固定error、validator errorは元のまま。元bytesを返し、v9 Rabbit独自readerは別に保持 |
| scheduler state | `scheduler-state.mjs`の3export→v2/v4/v5、v6〜v9 relay、v5保存時ACLを[runner図](legacy-runners.md)から追跡 | ACL/state/lock本文はexport以外が一致、各runner残部はimport/移動以外が一致。引数/PATH/basename/元state/gate/receipt・finallyを維持 |

台帳readerの`validateLedger`は役割別のprivate補助へ分けただけで、新しいvalidator policyは持たない。8readerの共通化も公開名/引数を変えず、schedulerの新exportは製品内部の相対importだけである。installのbinリンク、module相対参照、既config/CLI名を保持し、新HOME link/依存/設定移行は無い。

基準からの実行source差分はこの三整理だけ。新exportの逆依存はrepo内literalと既relayを確認したが、未知の外部caller不存在は証明しない。旧parser/Caveat受理/重大度/指紋/ACK、v1/queue/event/native排他を統合していない。

## 全体の状態と失敗の追跡

| 機能群 | 責任・返却・保持について確認したこと |
| --- | --- |
| 規範/導入/設定/親hook | 生成・link配置・設定保存・検査・親への出力を分離。SKIP、複数file rollback差、Grok途中保持、Cursor stampと読了の非同一性、hook観測不能時の現返却を説明できる |
| 同期/更新/日次・毎時/setup | source ff-only、製品公開入口、pending/final台帳、同report確定、OS登録/自然発火/配送票を分離。先行更新や原本は後段失敗で巻き戻さず、強制終了時の保証を増やさない |
| 診断/旧wire/外部イベント | 起動→製品別parse→公開投影→report/sidecarと、旧collection/prefix ACKを追跡。現行通常空ACK、各世代の重大度/指紋/required差を維持 |
| 配送/保持 | enqueue受付、HTTP受理、fragment全体受理、各製品ACK、queue処分、runner receipt、中央UIを区別。取消/応答消失/先行ACK/cleanup途中失敗は原本・部分結果へ戻れる |
| GPT/Rabbit/authority | 通常観測入口の閉鎖、過去一回枠のclaim、EX writer/二SH/元Node/kernel資格/issuer照合/private原本の責任を分離。供給されないportや実trustを図で補わない |
| Caveat | 製品コピーcollector、通常診断のbinding、未接続pure validation/retentionを分離。metadata予約/削除計画は実workerや物理削除完了ではない |
| model/互換wrapper/CI配布 | 選定JSONとモデル適用、Oracle明示rollback、Community順次委譲、CI分類/各gate/実配布を分離。実Host/他製品内部の責任を取り込まない |

現状文書に残っていた「未実装」「次の調査」「clean-home後半未読」などを現在の接続へ訂正した。ADR本文の設計時点の履歴は改変せず、各現状詳細へ案内する。既図のノード/入出力/状態/失敗経路に変更は不要だったため、今回図の追加・再描画は行わない。既段階の描画/目視根拠を維持する。

## 検証の十分性と限界

三整理に対しては、移動前後の本文照合、新境界の拒否/元bytes/原本保持case、影響する既callerの局所試験を組み合わせている。第1の5file60、第2の122、第3の6file60を別の結果として採用する。最新scheduler変更後のfinalize/旧gate/v9flagは第3試験に含まれる。既60や122の全量再走、未変更診断の全fixture全文再監査を追加条件にはしない。

全体の追加静的確認は`make lint test-current-docs test-ci-plan`成功。文書10/CI分類10はruntime試験と別。ShellCheck PATH欠測の初回exit127は既自席envで解消した。現lintが全lib/factory再帰構文や履歴保護まで検査するわけではなく、新moduleの構文確認は別に行っている。

fixture未読の残部は[検証対応](verification.md)へ残す。clean-home/authorityの後続本文確認を古い未読記述で上書きせず、旧独立observer、未変更の個別診断/config/hook/setup/wire5〜8の各枝を全文読了へ格上げしない。機械120path索引はこの判断の代わりではない。

実Mac/Windowsと3OS full CIは未実行。特にWindowsのPS7解決・ACL・hardlinkとbin相対module読込みは、Linux成功やsource文字列fixtureだけでは受入済みにできない。既CI分類は共通JS/図を3OS fullへ送るままである。実CI起動/Host照会/credential/送信を本レビューでは許可・実行しない。

ADR0136のclosed current集合/履歴保護と比較base未伝搬は、未解消の要件差として残る。今回の候補がその要件を実装したとはしない。Windows markerはsource上読まず待たないが、Host導入版は不明。通常GPT閉鎖/Rabbit過去枠、native別`539896`fixture、live issuer/store/resource/allwriter、Caveat実worker、SEC002本人later/旧stage停止も維持する。

今回の現状文書訂正と本レビュー追加後も、Markdown269file/0error、current-docs658文書、差分確認が成功した。runtime試験と変更の無い図の再描画は反復していない。

## 完成判断と次の受渡し

本レビューにより、三整理と全体の責任/状態/失敗接続についてAstraの整合判断を記録した。新たな設計案やruntime修理は要求しない。未確認を取り除いて「全体完成」とすることもない。

指導担当へ固定候補・本レビュー・検証/未確認を一通で渡し、独立した成果確認を依頼する。追加指摘は具体file/function/callerと根拠へ限定し、実装が必要なら正式Sol High適用後に是正、必要試験と図同期後にAstraでその差分を確認する。

並行して担当内で、固定base/候補、既CIの入力と3OS対象、未実行の受入、公開/反映前の条件を一つの具体的な引渡し資料へまとめる。これを新しいCI起動や公開の許可にしない。既承認手順と結果確認が終わるまで全体専任は継続する。1Password任意化はその後の別差分である。
