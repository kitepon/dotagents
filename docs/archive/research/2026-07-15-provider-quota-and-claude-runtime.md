# Claude runtime／両provider quota観測の実測契約

**取得日:** 2026-07-15  
**確度:** 公式仕様=高、現Mac実測=高、未ログインClaudeの実行挙動=未検証  
**対象:** Observer同provider伴走、異provider相談、一般Workerのrate-aware配置

## 単位・向きの対照表（2026-07-17固定。使用量⇄残量の取り違え防止・オーナー注意喚起起点）

**運用中の入口は各provider 1本＝計2本**（Codex `token_count`／Claude statusline）。全field
「使用済み」向きで、残量への反転は`quota-adapter.mjs`のprojection一箇所だけが行う
（`remaining_bp` = 残量basis points）。fixtureは実測値ごと固定済み＝意味が反転すれば落ちる。

| 状態 | 入口 | field | 向き（公式文言） | 変換 |
|---|---|---|---|---|
| **運用中** | Codex `token_count` | `used_percent` 0..100 | 使用済み | `10000 − round(×100)` |
| **運用中** | Claude statusline | `used_percentage` 0..100 | 使用済み（"consumed"） | `10000 − round(×100)` |
| 休眠（前方互換コードのみ） | Claude SDK RateLimitEvent | `utilization` 0.0..1.0 | 使用済み（"Fraction … consumed"。wire未配信＝snapshot不可） | `10000 − round(×10000)` |

**罠**: 人間向けUI表示には残量向き（"X% left"等。statuslineのcontext系は`used_percentage`と
`remaining_percentage`が両方存在）が混在する。**UI目視値を`source: "manual"`でsnapshotへ入れる時が
最大の反転混入口**——manual入力時は必ず「その表示が使用か残量か」を確認してからused系へ正規化する。

## live H実測追記（2026-07-17・ADR 0058。原文は保持）

O4 live quota観測（Control `observer-factory-20260715` Task `o4-live-quota-observation`）の実測で
本文の2箇所が更新された。

1. **Codex token_count（0.144.3）の完全shapeは本文の抜粋より広い。** 本文の3 key引用は抜粋であり、
   実イベントは`{limit_id, limit_name, primary, secondary, credits{has_credits, unlimited, balance},
   individual_limit, plan_type, rate_limit_reached_type}`を持つ（2026-07-16T23:32:39.061Z実測、
   used_percent 24.0／window_minutes 10080／resets_at 1784780155）。projection純関数はこの完全形を
   characterizeし、実イベント→`dotagents.quota-snapshot.v1`（remaining_bp 7600）の往復をfixture固定
   した。`individual_limit`はnullしか観測されておらず、非nullは`SCHEMA_DRIFT`で拒否する。
   **OpenAI laneのquota snapshot取得はlive verified。**
2. **Claude Code 2.1.211の実stream `rate_limit_event`はSDK文書と形が違い、utilizationを持たない。**
   実wireはcamelCaseの`{status, resetsAt, rateLimitType, overageStatus, overageDisabledReason,
   isUsingOverage}`だけで、SDK文書（snake_case・`utilization: float|None`）はSDK側の正規化形である。
   utilization不在のため**この入口単独ではremaining_bpを導出できず、snapshotは作れない**。adapterは
   `normalizeClaudeCliRateLimitEvent`（wire→SDK形正規化）と`UTILIZATION_UNAVAILABLE`（捏造禁止の
   typed error）で実態を固定した。CLIがutilizationを載せた場合の前方互換fixtureは通済み。
   **Anthropic laneのsnapshot取得は未達**——候補はCLI側のutilization追加、またはstatusline補助入口
   （`used_percentage`。設定変更＝別H）。両provider verifiedまでrate-aware自動配置は開始しない。
3. **（同日追記・ADR 0059）Anthropic laneはstatusline入口でlive verifiedになった。** session限定
   `--settings`のstatusline capture（global設定非変更）で実取得:
   `five_hour {used_percentage: 31, resets_at: 1784257800}`／`seven_day {used_percentage:
   28.999999999999996, resets_at: 1784275200}`。five_hourのresets_atは同日のstream
   `rate_limit_event`と完全一致（相互整合）。FPノイズはbp整数化が吸収。正規観測entryは
   `claude-statusline-rate-limits`へ切替え、stream event pathはCLIのutilization配信開始に備えた
   前方互換として保持。**これで両providerのquota snapshot取得がlive verified**。statuslineは
   対話TUIでだけ発火する（headless `-p`では発火しない）ことも実測で確認した。

## 失効注記（2026-07-16・原文は当時の実測として保持）

本記事の一部は後続の実測・正典で失効した。原文を書き換えず、以下を正とする。

1. **「Claude未認証」（結論6・adapter裁定表の「未login」）は失効。** 後続のClaude live
   characterization（Observer queue 19c2、dotagents `docs/adr/0029`〜`0032`受入）で認証済み
   headless／resume実行が確認された。現在の入口状態は`docs/02_models.md`「入口の既知の事実」を正とする。
2. **Claude background session（`--bg`／`--agent observer`）をObserver hostにする候補（結論2・3、
   adapter裁定表1行目、残る実測gateのbackground Observer項）は失効。** Claude Code 2.1.210の
   background job経路には公開reply／terminal exact result readがなくcanonical resultも拒否された
   （dotagents `docs/adr/0032`）。Observer hostはAiterm所有の永続PTY対話session（`claude_agent`）へ
   置換済み（`docs/adr/0033`、実装受入は`docs/adr/0038`〜`0039`）。
3. **Consultationを「`--bare --tools ""`相当」とする方針（公式契約節）は失効。** Claude Code 2.1.211の
   `--bare`はOAuth／keychainを読まずAPI key経路だけを使うため、subscription（OAuth）routeへ使わない。
   Worker adapterの確定契約（同一UUID start/resume、`--continue`／`--fallback-model`／`--bare`／
   `--safe-mode`／`--no-session-persistence`禁止、timeout unknown、strict Worker Report import）は
   `docs/adr/0043`と`shared/orchestrate/executor-adapters.md`を正とする。

## 結論

1. Claude親のcompleted turnは`TaskCompleted`ではなく`Stop`を正規証拠にできる。`Stop`は`session_id`、`cwd`、`last_assistant_message`、`background_tasks`、`session_crons`を持ち、API失敗は`StopFailure`へ分離される。進行中projectionやmtimeを完了扱いする必要はない。
2. Claude ObserverはClaude Codeのbackground sessionを正規hostにできる。`claude --agent observer --bg --name <id> <prompt>`で起動し、返されたjob IDをhandleとして`claude agents --json --cwd`、`logs`、`stop`、`respawn`で観測・停止・継続できる。同じagent viewで見えるため、オーナーの「親と同じアプリで監視する」UXに合う。
3. Claude background sessionはwrite時にworktreeへ移動し、条件次第でcommit／push／draft PRまで自動実行する。Observerはread-only tool集合に固定する。一般writerの正規入口はbackground sessionへ直結せず、統括が所有する隔離worktree上のheadless `claude -p --output-format stream-json`を第一候補にし、session IDと`--resume`を相関する。
4. Claude subscription quotaは公式に`five_hour`／`seven_day`の`used_percentage`と`resets_at`を公開する。Claude Agent SDKはさらに`five_hour`、`seven_day`、model別7日枠、overageを`RateLimitEvent`として持つ。推測や画面OCRは不要である。
5. Codexは公式TUIの`/status`と`/usage`でrate limitを表示する。現行CLIのproduct-owned session eventにも`used_percent`、`window_minutes`、`resets_at`があることをこのMacで実測した。公開manualはこの保存schemaを互換契約としては明記していないため、adapterはversion characterizationとstale判定を必須にする。
6. 現MacではClaude Code 2.1.207はinstalledだが`claude auth status`が`loggedIn=false`、Agent viewのObserver対象sessionも0件だった。したがってClaude laneは現時点でinstalled止まりで、registered／verified／execution-verifiedではない。実account smokeはlogin後に行う。

## 公式契約

### Claude completed-turn feed

- [[raw/claude-hooks]]: `Stop`はmain agentが応答を終えた時だけ発火し、user interruptでは発火しない。API errorは`StopFailure`へ分離される。
- `last_assistant_message`が完了応答を直接持つ。公式もStop時点ではtranscriptへ最終messageが未反映のversionがあるため、このfieldをtranscript再読より優先するよう指定している。
- `stop_hook_active`を見て再入を避ける。`background_tasks`が空でない時は「turn完了」と「session全体の作業完了」を分ける。
- `TaskCompleted`はClaude内部Taskのcloseであり、親turnの完了証拠ではない。`SessionEnd`はcleanup用で、turn feedには遅すぎる。

### Claude execution／continuation

- [[raw/claude-agent-view]]: `--bg`は短いjob IDを返す。`agents --json`は`working | blocked | done | failed | stopped`を返し、`logs`／`stop`／`respawn`で同じsessionを管理する。supervisor restartやsleep後もstateを保持する。
- [[raw/claude-headless]]: `claude -p`は`json`／`stream-json`出力、session metadata、retry event、structured outputを持つ。CLIの`--session-id`、`--resume`、`--continue`と合わせ、timeout後に同一sessionを回収できる。
- Consultationは`--bare --tools ""`相当のworkspace toolなし、Workerは明示tool集合と隔離workspace、Observerはread-only tool集合とする。三者を同一adapter成功へ丸めない。

### Claude quota

- [[raw/claude-statusline]]: subscriberの最初のAPI response後、status line入力に`rate_limits.five_hour|seven_day.used_percentage`と`resets_at`が現れる。各windowは独立に欠落しうる。
- [[raw/claude-agent-sdk-python]]: `RateLimitEvent.rate_limit_info`は`status`、`resets_at`、`rate_limit_type`、`utilization`を持つ。typeは`five_hour | seven_day | seven_day_opus | seven_day_sonnet | overage`。
- v1 adapterは実行streamの`RateLimitEvent`を第一入口とし、直近snapshotをproduct-owned adapter stateへ保存する。status lineは既存Claude sessionへ設定変更を要するので、H承認後の補助入口に留める。

### Codex execution／quota

- [[raw/codex-manual]]: `codex exec --json`は`thread.started`、turn lifecycle、最終message等をJSONLで返し、`codex exec resume <SESSION_ID>`で非対話sessionを再開できる。Claude親→Codex相談はread-only Codex Sidecarまたは同等のCodex consultation adapterへ投影できる。
- 同manualは`/status`をrate limits表示、`/usage`をdaily／weekly／cumulative usageとresetの対話入口として記載する。
- 2026-07-15、Codex CLI 0.144.3の最新product-owned `token_count` eventから次を秘密非表示で実測した。

```json
{
  "limit_id": "codex",
  "primary": {
    "used_percent": 2.0,
    "window_minutes": 10080,
    "resets_at": 1784666224
  },
  "secondary": null
}
```

`resets_at`は`2026-07-21T20:37:04Z`。これは一時snapshotであり、quotaの恒久値ではない。adapterはevent timestamp、CLI version、window IDを束縛し、古いsessionの値を現在値へ転用しない。

## adapter裁定

| lane | 正規入口候補 | handle／回収 | 現在地 |
|---|---|---|---|
| Claude親→Claude Observer | Claude background session＋`--agent observer` | job ID、`agents --json`、`logs`、`stop`、`respawn` | installed、未login |
| Codex親→Claude Worker | headless `claude -p --output-format stream-json`＋統括隔離worktree | session ID、process receipt、`--resume` | installed、未login、adapter未登録 |
| Codex親→Claude Consultation | headless Claude、workspace toolsなし | session ID、`--resume` | installed、未login、adapter未登録 |
| Claude親→Codex Consultation | Codex Sidecar read-onlyまたは`codex exec --json --sandbox read-only` | sidecar handleまたはthread ID、同一ID resume | Codex側入口はexecution-verified、Claude親からは未実測 |
| Claude quota | Agent SDK `RateLimitEvent`、補助=status line snapshot | quota pool＋window digest | schema verified、実account未実測 |
| Codex quota | product-owned `token_count.rate_limits` snapshot | quota pool＋window digest | current hostで実測済み |

現行aiterm MCPのcallable toolはCodex／Grok／Composerだけで、Claude Agent toolはない。現行ElasticがCodexへ寄るのはselectorの好みだけでなく、Codex親からClaudeへdispatchする登録済みexecution adapter自体が欠けているためである。

## 残る実測gate

- Claude loginはcredential操作なのでH。login後、最小一回のClaude responseで`RateLimitEvent`またはstatus line quotaを取得し、秘密を出さずに5h／7d windowをfixture化する。
- Claude background Observerをread-onlyで一回起動し、job ID、`agents --json` state、Stop hook、stop／respawnをcharacterizationする。
- headless Claudeを固定session IDで実行し、normal completion、rate limit、timeout、resume、malformed reportを確認する。
- Codex quota eventはCLI updateでschema driftしうる。0.144.3 fixtureを固定し、unknown／欠落／secondary nullをfail loudにする。
- 両provider snapshotがverified以上になるまで、rate-aware自動配置は開始しない。
