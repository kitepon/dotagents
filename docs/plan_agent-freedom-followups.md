# 聖典整理の後続作業

作成日: 2026-09-23。オーナーと合意した順序で進める。完了した段階は現在地に1行残す。

## 方針

- AIが自分で判断できることは、憲章・聖典・runbookに書かない。書くのはオーナーにしか決められないことと、AIが系統的に間違えることだけ。
- 書き換えを止める検査・安全装置は置かない。残すのは実際の壊れ（リンク切れ・生成物のずれ・導入失敗）を見つける検査と、未commit差分を消すgit操作のゲートだけ。

## 段階

1. **憲章（PLAN.md）**: 原則1（知能の使い所）・5（F/A/Hラベル）・8（重い検証構造）と、文書の作法の計画項目を削除して番号を詰める。世代交代の手順を model-ranking-authoring runbook へ置き直す。
2. **`pick-model`**: 任務を渡すとハーネス×モデル×effortを返す1コマンド。Jevへ02と利用枠の状態を渡して選ばせる。Codexの週次利用枠はCodexのセッション記録から読み、他のハーネスはレートリミットに当たった時に `pick-model --closed <ハーネス> --until <時刻>` で閉鎖を記録する。完了確認は代表任務での実呼出し。
3. **他の端末への反映**: main-server・rabbit・Windows nativeで正規のセットアップ入口を実行し、廃止したhookとorchestrate skillを外す。SSHで届かない端末はオーナー操作待ち。
4. **統括の残骸**: implementerの説明、lattice-workflow runbookのControl記録、docs直下の旧統括の互換stubと履歴文書、孤立したControl記録、端末メモリ。Lattice工程 `product-document-autonomy` は閉じる。
5. **全プロジェクトのAGENTS.md統一**: 1行importのCLAUDE.mdを削除、CLAUDE.mdだけのrepoはAGENTS.mdへ改名、両方に中身があるrepoは統合する。
6. **製品hookのコンテキスト消費**: Caveat・Spotter・Lattice・Throughlineの毎ターン注入を実測し、製品ごとに削減案を出す。
7. **runbookの点検**: 8本を同じ方針で見直す。

## 現在地

- 段階1完了（2026-09-23、`3c91a08`）。
- 段階2完了（2026-09-23）。9役割の代表任務で02の規則どおりの選択を確認。
- 段階4完了（2026-09-23）。Lattice工程 `product-document-autonomy` のpda-006を保留→退役。各repoの`.git/dotagents/orchestrate`（Control記録）、廃止hookのcacheと責務境界の宣言は`~/Archives/dotagents-retired-state-20260923T112731.tar.gz`へ保存してから削除。docs直下の旧統括の互換stubは、進行中のLattice計画から参照されうるため動かさない。
- 段階3（2026-09-23）: main-serverとrabbitは廃止hookとorchestrate skillの撤去まで反映済み。foxはsetup入口の`ssh -G main-server`がSSH越しの非対話実行で応答せず中断した。foxでの直接実行が残る。
- 段階3で見つけた別問題: main-serverの工場レポーターの送信先がwire v8のまま（入口はv9を要求して停止）。rabbitでcodex-sidecarのsetupが`SETUP_CONFIG_UNSUPPORTED`で失敗（smol-toml 1.9.0がnull prototypeのobjectを返し、往復確認のisDeepStrictEqualが不一致になる。Macは1.8.0で成功）。
- codex-sidecarを工場のコア製品から外した（2026-09-23、オーナー裁定）。導入・更新・setupをやめ、wire v9では対象外（not_applicable）として報告する。各端末のMCP登録とpackageは残っている。
- main-serverの工場レポーターをwire v9へ切り替えた（2026-09-23）。v9切替でsetup入口の検査とrabbit用の設定書込みはv9になったが、server profileの設定を書き換える手順がなかった。endpointをv9へ変えて`factory-reporter-scheduler install --apply`でcronをv9 runnerへ張り替え、setupは17製品の報告と配送確認まで通った。
- rabbitでnpmによるCodex CLI 0.156.0→0.156.1の更新がLinux本体のoptional dependencyを落とし、aiterm setupが`codex_parent_delivery_unavailable`で失敗した。工場のledgerは`post_version_unavailable`として正しく失敗を記録していた。公式の再導入で復旧。
- foxへの反映完了（2026-09-23）。止まっていた原因はWindows標準のssh.exeで、SSH越しの非対話sessionで出力を受け取ると終了しない（Win32-OpenSSH #1769）。工場のWindows SSHをGit for Windows同梱のOpenSSHへ切り替えた。あわせてfoxのdotagentsを`Developer\dotagent`から`Developer\dotagents`へ改名し、setupは17製品の報告と2時のタスクのsmokeまで通った。
- codex-sidecarのMCP登録を4台（Mac・main-server・rabbit・fox）のClaude・Codex・Grok・Cursorから外した（2026-09-23）。npm packageは各端末に残っている。
- 段階5の棚卸し（2026-09-23、Mac の ~/Developer 直下、worktree含む）: 1行importだけのCLAUDE.md＋AGENTS.mdは31件（削除対象。多くはLattice・Spotter・peertableのworktreeで元repoに従う）。CLAUDE.mdに中身がありAGENTS.mdもあるのは24件（統合対象。中身が短いhost固有差分だけのものは残す判断もありうる）。CLAUDE.mdだけのrepoは9件（ConnectC2X・MMOAuction・agent-desktop・Kikoeru・nextflic・entry・tools-manager・dobojo・browser-to-api、AGENTS.mdへ改名）。AGENTS.mdだけは11件、どちらも無いのは10件（対象外）。
- 段階5の1行importの削除（2026-09-23）: Claude Code 2.1.277以降はCLAUDE.mdが無ければAGENTS.mdを直接読むことを4台の版（2.1.280）と実測で確認。元repo11件でCLAUDE.mdを削除し、AGENTS.md等の「CLAUDE.mdはimportする」という記述も消した。push既定のLattice・Spotter・peertable・kitepon-dev-businessはpush済み、BellTeam・OpenDS360・WebAICoding・asr-worker・nope・sprite-forge-mcp・videomarketingはローカルcommitだけ。CLAUDE.mdを生成するコード・手順（BellTeamのbot作成、peertableの`.team/CLAUDE.md`、videomarketingのcommand）は製品の動作なので別途。
- peertableの憲章を`.team/CLAUDE.md`から`.team/charter.md`へ移し、全席が着任時に最初に読む手順を明記した（peertable `62f7b72`、0.8.59準備）。実測では`.team/`の指示書はCLAUDE.mdでもAGENTS.mdでも自動では読まれない。npm publishは全端末のnpm認証が401で、オーナーの`npm login`待ち。BellTeamとvideomarketingの生成物はオーナー判断で対象外。
- peertable 0.8.59をnpmへ公開し、4台（Mac・main-server・rabbit・fox）へ導入した（2026-09-23）。各端末で4 hostのskillがcurrent、着任手順の一文を確認、診断はfailなし。npmの公開は2段階認証の承認が要り、Bashからはexpectで「Press ENTER」に応答するとブラウザで承認画面が開く。
- npm公開をTrusted Publishingへ移す（2026-09-23、オーナー指示）。2FAを飛ばすtokenは2027年1月ごろ直接公開できなくなる。peertableは`.github/workflows/publish.yml`（`v<version>` tag起動、GitHub-hosted runner）を置き（peertable `6581149`）、`npm trust github peertable --file publish.yml --repository kitepon/peertable --allow-publish`で信頼設定を登録した。実際の公開での確認は次のrelease（0.8.60）。他の自作コアnpm製品は、次のreleaseのついでに同じ形へ切り替える。npmの2FA承認はexpectで認証URLを取り出し、`open -a "Google Chrome"`で前面に開くとオーナーが見つけられる。
- 保留: npm v12は依存と導入対象の導入時スクリプトを既定で実行しない。4台はまだnpm 11。v12へ上がる前に、導入時スクリプトに頼る製品（ネイティブモジュールの作成済み実行ファイル取得など）を確かめる。
- 段階5のCLAUDE.mdだけのrepoの改名（2026-09-23）: ConnectC2X・MMOAuction・Kikoeru・nextflic・entry・tools-manager・dobojo・browser-to-apiでCLAUDE.mdをAGENTS.mdへ改名し、現行文書の参照も直した（履歴・ADR・監査記録と`~/.claude/CLAUDE.md`への参照は残す）。dobojoだけpush済み、残り7件はローカルcommit。agent-desktopは第三者製品（lahfir/agent-desktop）なので対象外。
