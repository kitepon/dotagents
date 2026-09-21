# Grok の quota・catalog 公開入口（2026-09-21）

取得日: 2026-09-21。確度: SpaceXAI公式文書、現Macの認証済みGrok Settings、
Grok Build CLIと製品所有catalog cacheの実測。対象版: Grok Build CLI 1.0.30
（stable、commit `04b7ffed98c6`）。

## 結論

Grokの現行個人契約は、Build、Chat、Imagine、Voiceなどで一つの週次poolを共有する。
2026-09-21T19:21Z頃、認証済みGrok Settings→UsageではSuperGrok Heavyの週次枠が
19% used（81% remaining）、内訳はGrok Build 19%、resetは2026-09-27 19:39
（画面のローカル時刻、Asia/Tokyo。UTCでは10:39）だった。絶対上限、token数、金額は
表示されないので、割合をAPI tokenや契約価格へ換算しない。

Grok Botは別の週次枠で、0% used、2026-09-28 09:10 resetと表示された。推薦用の
Grok直接poolへ混ぜない。Extra Usage Credits欄には購入・自動チャージ入口があったが、
残高の数値は表示されなかったため`unknown`とする。

継続的に呼べる公式のaccount残量面はSettings→Usageである。CLIの`grok usage
<session-id> [turn]`は保存済みsessionのtoken/costであり、契約pool残量ではない。
個人契約残量を返す公開CLI/APIは確認できなかった。未文書のdashboard API、cookie、token、
account identifierを取得経路にしてはならない。自動収集では現時点のGrok直接poolを
`observation_unavailable`として扱い、人が公式画面を観測したsnapshotだけを時刻付きで使う。

## 現契約の実測

ブラウザの認証済みproduct sessionを使い、cookie、token、email、account ID、会話本文は
読まず、成果物にも保存していない。

| 観測 | 結果 |
|---|---|
| 2026-09-21T19:21Z頃 Settings→Usage | SuperGrok Heavy週次枠19% used、81% remaining |
| 同画面のproduct内訳 | Grok Build 19%。他productの数値行は表示なし |
| 同画面のreset | 2026-09-27 19:39 Asia/Tokyo（2026-09-27T10:39Z） |
| 同画面のGrok Bot | 別枠、0% used、2026-09-28 09:10 Asia/Tokyo reset |
| Extra Usage Credits | 購入・自動チャージ入口あり。数値残高は表示されず不明 |

更新遅延のための生成は行っていない。現端末のGrok CLIは`grok models`で
`You are not authenticated.`と報告し、最小requestはlogin操作を要する。過去のloginや
ブラウザcookieをCLIへ移植せず、rate limitまでの消費もしなかった。このため、生成完了から
Usage反映までの遅延は`not_measured`である。

## Grok Buildのmodel×effort

`grok models`は認証切れを明示しながら4 modelのfallback一覧を表示した。これだけを現在の
callable catalogとは扱わない。一方、製品所有の`~/.grok/models_cache.json`は
2026-09-21T19:08:38ZにGrok 1.0.30が取得した4 entryを保持していた。identity、etag、endpoint、
header、key fieldは読出し・転記せず、公開catalog項目だけを投影した。

| model ID | context | effort（既定） | 公開catalog上の状態 |
|---|---:|---|---|
| `grok-4.7` | 500K | low / medium / high / xhigh（high） | Responses、Grok Build plan、`supported_in_api=true` |
| `grok-4.7-build-fast` | 500K | low / medium / high / xhigh（high） | Responses、Grok Build plan、`supported_in_api=true` |
| `grok-4.6` | 500K | low / medium / high / xhigh（high） | Responses、Grok Build plan、`supported_in_api=true` |
| `grok-4.5` | 500K | low / medium / high（high） | Responses、Grok Build plan、`supported_in_api=true` |

公式Reasoning文書も4.7／4.6の4段階と、4.5の3段階を定める。`none`は有効値ではなく、
reasoningは無効化できない。CLIは`--reasoning-effort`（alias `--effort`）を公開するが、
effortはmodel catalogの対応値からだけ選ぶ。認証切れのため、この観測時点では4 entryの
実request成功までは確認していない。

Grok 4.7 Fastは同じmodelの高速提供で、公式にはCursorとGrok Buildだけで利用でき、公開xAI API
にはない。catalogの`grok-4.7-build-fast`をAPIの別slugへ読み替えない。

## Cursor上のGrokとの分離

hmer-001の受理済み実測（commit `adb63ac8881e5c2847175cb5ed4dd850fa320de4`）では、Cursor
UltraのCursor Models poolが6% used（94% remaining）、月次resetは10月17日だった。
Cursor Grok 4.6はlow / medium / high / xhighと各fast variantを持つ。これはCursor契約の
Cursor Models poolを消費し、Grok Settingsの週次SuperGrok Heavy poolとは共有しない。

したがって同じGrok familyでも少なくとも次を別候補にする。

- Grok Build直接: `pool=grok-supergrok-weekly`、週次19% used、CLI catalogは4.7系を含むが
  request時のloginは現在不成立。
- Cursor Agent: `pool=cursor-models-monthly`、月次6% used、現account catalogではGrok 4.6。

provider名やmodel familyだけからpoolを決めない。Cursorの割合とGrokの割合も、絶対容量と
reset windowが異なるため大小比較しない。

## Codex既存観測入口の現行確認

Codex CLI 0.155.1の公式対話入口は`/status`、account画面はusage dashboardである。このMacの
product-owned session eventから秘密fieldを除いて最新`token_count.rate_limits`を投影すると、
2026-09-21T15:55:08Z観測でProの7日枠は97% used（3% remaining）、window 10080分、
resetは2026-09-26T09:13:21Z、追加creditなしだった。

`lib/orchestrate/quota-adapter.mjs`はこの`limit_id`、primary/secondary window、
`used_percent`、`window_minutes`、`resets_at`を検証して残量basis pointsへ投影する。保存eventの
schemaは公開互換契約ではないため、CLI version、観測時刻、schema drift、stale判定を必須にする。
2026-07のfixtureや今回の値を将来の現在値へ再利用しない。

## 取得契約への含意

| 対象 | 取得元 | 取得項目 | 取得不能・注意 |
|---|---|---|---|
| Grok直接契約 | Settings→Usage | 使用率、product内訳、reset、credit表示有無 | 公開CLI/APIなし、絶対上限なし、今回はcredit数値なし |
| Grok Build catalog | product-owned models cache / 認証済み`grok models` | ID、context、effort、既定、capability | cacheはstale判定必須。現在CLIは未認証 |
| Cursor上Grok | Cursor dashboard / `agent models` | 別poolの使用率、ID組込みeffort | Grok直接poolと非共有 |
| Codex | 対話`/status`、product-owned event | window使用率、期間、reset、credit状態 | 保存schemaはversion characterization必須 |

工程3でGrokを一度の自動推薦へ接続するには、SpaceXAIがaccount quotaの公開API/CLIを提供するか、
製品所有repoが秘密を露出しない公開取得入口を所有する必要がある。dotagentsでcookie scraperや
内部endpoint wrapperを作って不足を補完しない。

## 公式出典

- [SpaceXAI: Grok Website / Apps FAQ](https://docs.x.ai/grok/faq)
- [SpaceXAI: Grok 4.7](https://docs.x.ai/developers/grok-4-7)
- [SpaceXAI: Reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning)
- [SpaceXAI: Grok Build source](https://github.com/xai-org/grok-build)
- [OpenAI: Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [既存Codex quota実測](../../docs/archive/research/2026-07-15-provider-quota-and-claude-runtime.md)
