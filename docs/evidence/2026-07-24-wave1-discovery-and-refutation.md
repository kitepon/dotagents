# Wave 1 discovery と設計反証の記録（2026-07-24）

Composable Orchestration戦役 Wave 1（Lattice `factory-master` / fm-0663・fm-0664）のdiscovery調査と、
初案設計への敵対的反証の結果。結論は[ADR 0114](../adr/0114-typed-lane-admission-contract.md)へ畳まれている。
本書は「何を調べ、何が殺されたか」の証跡として残す。

## discoveryで確定した事実

Codex中位(`gpt-5.6-terra`)×medium のread-onlyレーン2本による実読調査。

型付きlane admission側:

- ADR 0061の4条件を**機械的に検査するコードは存在しない**。散文の規範（ADR・共通憲法・統括契約・両skill
  frontmatter）と、hookのINFO文言（onset-gate／plan-gate／codex-callout）だけ。hookは条件を入力として
  受け取らず、拒否もControl作成もしない。
- Control `init`の外部入力はexact key setであり、unknown keyを拒否する。条件を足すこと自体が
  公開契約の変更になる。
- 既存の"admission"は3つあり全て別物。Taskの改竄検出digest、Worker Runの遷移、配置予約。
- phase gate強制はlibrary `taskRecord`にあり、CLI側pre-checkはWave 0で削除済み。
- hookの書込み先はXDG cacheと一時fileだけで、Control state・manifest・transition receiptに接続しない。
  「通常レーンに永続receiptを作らない」は実装上すでに保たれている。

固定Recipe側:

- 二型`adversarial-audit`／`bulk-curation`はClaude skillのMarkdown内JSコードブロックとしてのみ存在し、
  実行可能な雛形ファイルはリポ内に無い。
- **Codex側には二型のPhase・入力・出力schema・reducer・gateの定義が一切無い**。あるのは入口と回収の
  契約だけ。
- 比較した6観点（対象二型・Phase表現・fan-out・出力の構造化・reducer・失敗時）はすべて
  「入口差ではなく意味差」と判定された。
- Claude側の雛形自体にも未定義項目が多い（入力schema・最大件数・最大並列度・Critic出力schema・
  Dedupの判定規則・全体の合否gate・timeout・partial・retry・最大ラウンド数）。

## 実測で決着した論点

> 2026-08-30訂正: 次の1点目はWindows配布面を含む実測ではなく、全hostへ一般化した誤判定だった。
> Windowsではsymlink外へ抜ける`..`が配布先の親へ解決され、参照先を読めない。
> 現行契約と修正は[ADR 0115](../adr/0115-fixed-recipe-shared-contract.md)を正とする。

- skillは**ディレクトリごと** symlinkされるため、配布後の
  `~/.claude/skills/orchestrate/../../../shared/orchestrate/contract.md` はkernelのpath解決がsymlinkを
  辿って実在ファイルへ到達する。`install.sh`が`shared/`を配布対象に走査しないことは、host共通契約を
  `shared/`へ置く裁定の障害にならない。
- Lattice `run abandon`は`INVALID_RUN_STORE`のstoreを退役できない。`list`／`status`／`observe`／`abandon`が
  同じstore検証を通るため、キーがdriftしたrun storeは公開CLIから一切退役できない。詳細と影響は罠DBの
  `dotagents-smoke-run-store-1-lattice-run-list-invalid-run-store-brick`が正本。
  公開入口での退役手段が無いため、オーナー承認を得てstale store 1件をfilesystemから削除した
  （tar退避取得済み・live run無し・`.lattice/runs/`はgitignore済みの端末ローカル）。削除後
  `lattice run list --json`は`lattice.run_list.v1`で`active_runs: []`を正常に返す。
  Lattice製品側の修理（abandonが検証失敗storeを退役できない件、run requestのkey renameに対する
  schema版据え置き）はオーナー裁定により本戦役へ畳まず後回しとする。

## 反証で棄却された初案

Codex旗艦(`gpt-5.6-sol`)×high のrefuter 3レンズ（schema・互換／非目標抵触／単体成立・二重正本）。
3本すべて`refuted`判定。致命傷17件はレンズ間でほぼ重複しなかった。棄却された設計の一覧は
[ADR 0114](../adr/0114-typed-lane-admission-contract.md)「反証で棄却した設計」節が正本。

反証が明らかにした構造的な問題のうち、lane admissionに固有でないもの:

- manifest版に依存する能力判定に、単一版との等値判定が残っている。新しい版を足すほど
  consultation cancel・selector decision・artifact generationの能力を失う。同種の罠は過去に一度
  指摘され、コード内コメントに記録されているが、artifact generationでは解消されていない。
- `controlMigrate`の既定分岐は最新版からのrollback専用であり、新しいedgeを足すだけでは
  upgradeもrollback分岐へ落ちる。receiptを持たないControlでは偶然通るため、data-dependentに壊れる。
- migration receiptは恒久追記であり、旧版readerは新版名を知らないため、新版receiptを持つmanifestを
  旧binaryで読めない。「双方向edgeを張れば戻せる」は成立しない。

## 実行上の記録

- 最上位ティア(`fable`)のrefuterは利用枠上限で3本とも起動できず、Codex旗艦×highで代替した。
  契約クリティカル範囲を最上位でスポット反証する規律からは外れている。
- 同一repoへの複数writer並列は、discovery時点ではLattice run storeがfail closedのため使えず、
  [ADR 0113](../adr/0113-composable-orchestration-invariants.md) Decision 4のsupported degraded modeとして
  明示直列化する裁定だった。stale store削除後は`run list`が復旧し、この制約は解消している。
- 並列化の裁定（campaign単位・一度だけ）: Wave 1のfm-0663とfm-0664はwriter scopeが交差しうる
  （両者とも`shared/orchestrate/`と`tests/`へ書きうる）。run store復旧後は`plan compile`の競合検出へ
  判定を委ねられるため、親の自前交差判断で並列強行しない。fm-0664は設計Decisionが未確定であり
  dispatch可能な状態にないため、fm-0663を先行させ、fm-0664のDecision確定後に競合検出の結果で
  並列可否を決める。
