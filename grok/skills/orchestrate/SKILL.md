---
name: orchestrate
description: 統括レーン（①計画に中断が組込済み②受入が多段連鎖③複数repoの書込調整④裁定証跡が必要、のいずれか確定）の実装、監査、移行を Grok 親のnative・外部実行・相談レーンで安全に統括する時に使う。技法は通常レーンでも参照可、Control儀式は統括レーンだけ。
---

# Orchestrate

まず[共通契約](references/shared-orchestrate/contract.md)と[委譲契約](references/shared-orchestrate/delegation-contract.md)を全文読む。使う時・使わない時、F/A/H、Control lifecycle、Packet/Report、反証、原因特定、focused検証、通し試験の最終確認、レーン分離、統括ゲートは共有文書が正本である。

## Grok appendix

- **円卓の入口は peertable room だけ**（`peertable` skill。Windows native も 2026-08-16 修理後に利用可）。campaign またはオーナーが円卓を指定した実装物量は、`spawn_subagent` へ流さない。Grok 親は room MCP を持たないので HTTP API で着卓し、席は `launch-seat.sh` で立てる。
- host 内の子は`spawn_subagent`を使う。工場roleは`implementer`と`refuter`。円卓の代替ではない。modelは親継承を避け、docs/02_models.md 順位表の当該役割のGrok配置（model×effort）を毎回明示する。
- 日常shellはGrok nativeの`run_terminal_command`。aiterm永続PTYは外部子（Claude/Codex/Composer）を張る時だけ使い、Grok親の日常shellへ流さない。
- MCPは`search_tool`でschemaを取ってから`use_tool`する。Claudeの`mcp__*`名前やCodexの`spawn_agent`を正入口にしない。
- `gpt_connector`は親直轄のconsultation専用。Worker・実装・shellの担当にしない。製品操作は[gpt-connector skill](../gpt-connector/SKILL.md)から製品正本へ辿り、このappendixへ複製しない。
- ClaudeのWorkflow / Agent matcherと、Codex nativeの`agent_type`/`fork_turns`はこの入口の正本ではない。

## 固定RecipeのGrok入口

固定Recipe `adversarial-audit`／`bulk-curation` のPhase・入出力schema・reducer・gate・失敗条件の正本は[固定Recipe契約](references/shared-orchestrate/recipes.md)。本節はGrok実行入口だけを所有する。

- **fan-out**: 各視点・各指摘・各対象を1子1任務として`spawn_subagent`へ出す。read-only段は並列してよい。同一repoへ書込む対象が2つ以上ありLatticeが選択されていなければ直列（正本は[合成契約](references/shared-orchestrate/composition.md)）。
- **schema強制**: 子の最終出力を該当schemaのJSONだけにし、不一致は`failed`として扱う。
- **回収**: 子の完了はhost固有handleだけで確定する。timeout・中断は`unknown`とし、同一handleで回収する。`partial_failure`を`success`へ丸めない。
- **Control投影**: Controlが選択されている場合だけstrict Worker Reportへ投影する。通常レーンではPacket/Reportを作らない。
