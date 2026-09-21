# Cursor の quota・catalog 公開入口（2026-09-21）

取得日: 2026-09-21。確度: Cursor 公式文書と現 Mac の認証済み公開 CLI／dashboard の実測。
対象版: Cursor.app 3.21.16、Cursor Agent CLI `2026.09.18-9a7762b`。

## 結論

Cursor の現行個人契約は、`Cursor Models` と `Other Models` の2つの月次 pool を別々に管理する。
現アカウントの Spending 画面では Ultra（$200/月）、Cursor Models 6% used、Other Models 50%
used、月次 reset は10月17日、on-demand は無効だった。したがって割合としての残量はそれぞれ
94% と50%である。ただし画面は pool の絶対額・token 上限・reset の時刻を表示しない。
プラン価格を pool 上限へ読み替えたり、割合だけで容量の異なる pool を比較したりしてはならない。

個人契約で継続取得できる公式面は Spending／Usage dashboard である。`agent models` はアカウントで
実際に使える catalog を返すが、Cursor Agent CLI に account pool 残量を返す command はない。
Cursor SDK の `Agent.getUsage()` は SDK agent/run 単位、Admin API は team 管理者向けであり、個人
Ultra の2 pool 残量取得を置き換えない。dashboard が内部で呼ぶ未文書 API は観測できるが、session
cookie を持ち出す必要がある非公開契約なので実装入口にしない。工程3で自動取得を要求する場合は
`unsupported`／`observation_unavailable`として扱い、画面値を架空の programmatic API で補わない。

## 現契約の実測

観測時刻は UTC。ブラウザの認証済み product session を使い、cookie、token、email、account ID は
表示・保存していない。

| 観測 | 結果 |
|---|---|
| 2026-09-21T14:16頃 Spending | Ultra、Cursor Models 6% used、Other Models 50% used、月次 reset 10月17日、on-demand disabled |
| 同画面の Grok Bot | weekly usage 0% used、9月28日 reset。Agent の2 poolとは別表示であり、推薦用 pool に混ぜない |
| 2026-09-21T14:24:04Z 最小 request | 空の一時 workspace、`agent -p --mode ask --model gpt-5.6-luna-none --trust`、出力 `OK`、14:24:14Z完了 |
| 2026-09-21T14:24:31Z Usage | `gpt-5.6-luna-none`、Included、1.9万 tokens の新規行を確認。完了から17秒以内に反映 |
| 2026-09-21T14:24:50Z Spending | Cursor Models 6%、Other Models 50%のまま。1回分は整数%表示を動かさない |

14:23:52Z の最初の試行は空 workspace の trust preflight で request 前に exit 1となり、生成していない。
rate limit 到達、枠の使い切り、追加 request は試していない。Usage 行の token 数は user prompt だけで
なく Cursor harness の入力を含むため、「OK」の文字数から消費を推定してはならない。

## pool と provider の対応

公式の [Usage and limits](https://prod.cursor.com/help/models-and-usage/usage-limits) と
[Models & Pricing](https://cursor.com/docs/models-and-pricing) は次を定める。

- Cursor Models pool: Cursor Grok 4.6、Cursor Grok 4.5、Composer 2.5。
- Other Models pool: OpenAI、Anthropic、Google 等の third-party model。model provider の API 価格で消費する。
- Auto／Cursor Router: 実際に route された model に応じて両 pool のどちらも消費しうる。
- 個人契約の BYOK request は Cursor の2 poolを消費せず、provider が直接課金する。

よって provider と消費 pool は別 field にする。例として Claude Fable 5.1 は provider=Anthropic でも
pool=Cursor Other Models、Cursor Grok 4.6 は提供元名に Grok を含んでも pool=Cursor Models である。
Grok 直接契約の残量とは共有しない。

## 公開 CLI と model×effort

認証状態は `agent status --format json` で確認でき、秘密 field を除いた結果は
`status=authenticated`、`isAuthenticated=true` だった。catalog は `agent models` または
`agent --list-models` で取得する。2026-09-21の現アカウントでは223 IDが返った。

Cursor Agent CLI には独立した `--effort` option がない。effort は `--model <id>` の ID に含まれ、
parameterized model は `model[context=1m,effort=high,fast=false]` の形も受ける。SDKでは
`Cursor.models.list()` が modelごとの parameter IDs、許可値、preset variants を返す。固定表より
この account/team 固有 catalog を正とする。

推薦対象になる現行familyの実測対応は次のとおり。`fast` は一覧に存在する時だけ別 variant として
選択でき、通常 variant と同じ消費とは仮定しない。

| family | effort／mode（実測IDから集約） | fast |
|---|---|---|
| Cursor Grok 4.6 | low, medium, high, xhigh | 各 effort にあり |
| GPT-5.6 Sol | none, low, medium, high, xhigh, max | 各 effort にあり |
| GPT-5.6 Terra | none, low, medium, high, xhigh, max | 各 effort にあり |
| GPT-5.6 Luna | none, low, medium, high, xhigh, max | 各 effort にあり |
| Claude Fable 5.1 | low, medium, high, xhigh, max。thinking も同じ5段階 | 観測一覧にはなし |
| Claude Opus 5 | low, medium, high。thinking は low, medium, high, xhigh, max | 観測一覧には各 variant の fast あり |
| Claude Sonnet 5 | low, medium, high, xhigh, max。thinking も同じ5段階 | 観測一覧にはなし |

このほか catalog には Composer 2.5、Gemini、Muse、旧世代modelがある。全223 IDを設定へ複製せず、
推薦時に live catalog から絞る。利用地域・plan・admin policyで一覧は変わりうる。

## harness 固有機能

`agent --help` の現行公開面は、ask／plan（read-only）、workspace指定、MCP、plugins、sandbox、
isolated worktree、persistent session、JSON／stream-JSON outputを持つ。公式 model page は Cursor Agent
で file search/read/edit、shell、web、browser、image generation、質問、rule取得を使えると説明する。
同じ基盤modelを直接 harness で使う場合にこれらが同一とは仮定しない。

## Claude既存観測入口の現行確認

dotagents の `lib/orchestrate/quota-adapter.mjs` は Anthropic の正規入口を
`claude-statusline-rate-limits` とし、statusline の `five_hour`／`seven_day` にある
`used_percentage` と `resets_at`を残量basis pointsへ投影する。focused testは9/9成功した。

一方、この Mac の Claude Code 2.1.269 は `claude auth status --json` で `loggedIn=false`、
`authMethod=none`だった。statuslineは最初のAPI応答後にだけ rate limits を持ち、headless `-p`では
発火しないため、現契約値のlive再取得は不可能だった。必要条件は既存正規入口でのClaude loginと、
session限定 `--settings` を使う最小対話TUI responseである。過去fixtureを現在値として再利用しない。

## 公式出典

- [Cursor: Models & Pricing](https://cursor.com/docs/models-and-pricing)
- [Cursor: Usage and limits](https://prod.cursor.com/help/models-and-usage/usage-limits)
- [Cursor: Available models](https://prod.cursor.com/help/models-and-usage/available-models)
- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript)
- [Cursor Admin API](https://prod.cursor.com/docs/account/teams/admin-api)
- [Cursor: GPT-5.6 Sol](https://prod.cursor.com/docs/models/gpt-5-6-sol)
- [dotagentsの既存Claude/Codex quota実測](../../docs/archive/research/2026-07-15-provider-quota-and-claude-runtime.md)
