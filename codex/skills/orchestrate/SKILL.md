---
name: orchestrate
description: 統括レーン（①計画に中断が組込済み②受入が多段連鎖③複数repoの書込調整④裁定証跡が必要、のいずれか確定）の実装、監査、移行を Codex のnative・外部実行・相談レーンで安全に統括する時に使う。技法は通常レーンでも参照可、Control儀式は統括レーンだけ。
---

# Orchestrate

まず[共通契約](references/shared-orchestrate/contract.md)と[委譲契約](references/shared-orchestrate/delegation-contract.md)を全文読む。使う時・使わない時、F/A/H、Control lifecycle、Packet/Report、反証、原因特定、focused検証、通し試験の最終確認、レーン分離、統括ゲートは共有文書が正本である。

## Codex appendix

- Control配下の書込みWorkerだけはrouting smokeの確認後に同一子へfollow-upし、必要時のみinterruptする。通常のnative audit・refuter・sorterはspawn時の任務をそのまま実行し、事前smokeを要求しない。external executionはsidecar/aitermの固有task/session/job handleでdispatch・observe・resumeし、Controlには参照と観測だけを記録する。aitermレーンの運用型（完了受信・レーン構成・親専任）は[aiterm-dispatch.md](references/shared-orchestrate/aiterm-dispatch.md)を先に読む。
- **Codex親→Codex子はnative sub-agentを既定にする。** nativeは同じ子へのfollow-upで対話とTask相関を保てるため、repo密結合の実装・調査・反証をaitermの`codex_agent`へ流さない。aitermを永続shellとして使うことはこの制約の対象外であり、Grok／Composer等の別harness laneとも混同しない。
- Controlへ記録済みのnative Runを`agents.interrupt_agent`で止める時は、先に`worker-cancel-request`を記録する。interrupt receiptを回収してから`observe-worker=cancelled`へ進め、外部interruptを先行させない。
- nativeへ実作業をfollow-upする前に、`delegation-packet`と`worker-report-skeleton`の出力をそれぞれ安全な一意pathへ保存し、follow-up本文で両方の実pathを明示する。schemaを親が要約転記したり、field一覧だけで代用したりしない。子には両原本を読んでskeletonのexact shapeを保ったまま埋めるよう指示し、pathを渡せない時はdispatchしない。
- 統括レーンで委譲すると裁定したAは、tightに結合した作業ならCodex native、隔離、durable work、harness固有機能、独立capacityが適合する時はsidecar/aitermを選ぶ。通常レーンは委譲を既定にしない。nativeでは`agent_type=<role>`と`fork_turns="none"`を指定する。Control配下の書込み Workerだけは最初のspawnをrouting smoke のみにする。
- Control配下の書込み Workerは、`verify-codex-agent-routing <role> <agent-path>` が role・model・effort・developer instructions の一致を確認してから、同じ子へ follow-up で実作業を渡す。
- `implementer` は仕様固定の実装・テスト、`refuter` は書込み禁止の行動契約で敵対的検証、`sorter` は書込み禁止の行動契約で分類・抽出を担う。実効sandboxは親から継承し、role TOMLで別権限を保証しない。model と effort は role TOML によって決まり、呼び出し側が手指定しない。
- native枠は工場全体の上限ではない。隔離・durable work・独立capacity・役割適合でexternal executionに具体的利益がある時は、`codex-sidecar`またはaitermの`grok_agent` / `composer_agent`を積極利用する。aitermの`codex_agent`は、nativeで満たせないdurable external session等の利益が準備・回収コストを上回る時だけ例外的に使い、単なるcapacity追加や起動可能性を理由に選ばない。Codex親から入れ子のCodexを起動してよいが、通常入口はnativeとする。
- `gpt_connector` は親直轄のconsultation専用であり、Worker、external capacity、独立監査票、実装・shell・テストの担当として扱わない。timeout後は同じslugをsessionsで回収し、重複送信しない。
- Codexの入口はinstalled / registered / verified / execution-verifiedを区別し、external writerにはexecution-verifiedの入口だけを使う。

## 固定Recipe（二型）のCodex入口

固定Recipe `adversarial-audit`／`bulk-curation` のPhase・入出力schema・reducer・gate・失敗条件の
正本は[固定Recipe契約](references/shared-orchestrate/recipes.md)であり、本節はCodex実行入口だけを所有する。
型の使用はレーンを問わない——Control儀式だけが統括レーン専用である。

- **fan-out**: 各視点（Find）・各指摘（Verify）・各対象（Apply）を1子1任務としてnative sub-agentへ
  dispatchする。read-only段（Find/Dedup/Verify/Critic、readのApply）は本数制限なく並列してよい。
  同一repoへ書込む対象が2つ以上あり、Latticeが選択されていなければ、そのrepoの対象は直列に実行する
  （正本は[合成契約](references/shared-orchestrate/composition.md)「同一repo writerの直列化」。
  自前交差判断で並列強行しない）。
- **schema強制**: 子への指示に[recipes/](references/shared-orchestrate/recipes/)の該当schemaへ
  厳密準拠したJSONだけを最終出力とするよう明記し、親が回収時にschema不一致を`failed`として扱う
  （黙って受理・補完しない）。
- **回収**: 子の完了はhost固有handleの正規入口だけで確定する。timeout・中断は`unknown`とし、
  同一handleで回収する。集約はsharedの二軸（実行状態×payload）と全体gateに従い、
  `partial_failure`を`success`へ丸めない。
- **Control投影**: Controlが選択されている場合だけ、terminal resultをstrict Worker Reportへ投影する。
  通常レーンではterminal resultを直接親の裁定材料にし、Packet/Reportを作らない。
