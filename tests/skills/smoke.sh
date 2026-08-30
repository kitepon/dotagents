#!/usr/bin/env bash
# Codex skill の静的契約を検証する。外部サービスや本番環境は操作しない。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PYTHON=python3
if [ "${OS:-}" = "Windows_NT" ]; then
  PYTHON=python
fi

fail() { echo "FAIL: $*" >&2; exit 1; }
contains() { rg -Fq "$2" "$1" || fail "$1 に $2 がない"; }
absent() { ! rg -Fq "$2" "$1" || fail "$1 に Claude 固有入口 $2 が残っている"; }
assert_order() {
  local file="$1"
  shift
  "$PYTHON" - "$file" "$@" <<'PY' || fail "$file の語句が存在しないか想定順序でない"
from pathlib import Path
import sys

content = Path(sys.argv[1]).read_text(encoding="utf-8")
cursor = 0
for token in sys.argv[2:]:
    position = content.find(token, cursor)
    if position < 0:
        raise SystemExit(1)
    cursor = position + len(token)
PY
}
frontmatter_is_name_and_description_only() {
  awk '
    NR == 1 { if ($0 != "---") exit 1; next }
    /^---$/ { closed = 1; exit }
    {
      if ($0 !~ /^(name|description): /) exit 1
      key = $0; sub(/:.*/, "", key)
      if (seen[key]++) exit 1
      count++
    }
    END { exit !(closed && count == 2 && seen["name"] && seen["description"]) }
  ' "$1" || fail "$1 の frontmatter は name/description だけではない"
}
frontmatter_has_keys() {
  local file="$1"
  shift
  "$PYTHON" - "$file" "$@" <<'PY' || fail "$file の frontmatter に必須キーがない"
from pathlib import Path
import sys

lines = Path(sys.argv[1]).read_text(encoding="utf-8").splitlines()
if not lines or lines[0] != "---":
    raise SystemExit(1)

keys = set()
for line in lines[1:]:
    if line == "---":
        break
    if ":" not in line:
        raise SystemExit(1)
    key, value = line.split(":", 1)
    if not key or not value.strip():
        raise SystemExit(1)
    keys.add(key)
else:
    raise SystemExit(1)

if not set(sys.argv[2:]).issubset(keys):
    raise SystemExit(1)
PY
}

for skill in orchestrate auto-deploy-on-push polish-github; do
  file="$ROOT/codex/skills/$skill/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
  rg -q '^name: ' "$file" || fail "$file に frontmatter name がない"
  rg -q '^description: ' "$file" || fail "$file に frontmatter description がない"
  yaml="$ROOT/codex/skills/$skill/agents/openai.yaml"
  [ -f "$yaml" ] || fail "$yaml がない"
  contains "$yaml" "\$$skill"
done

[ -d "$ROOT/codex/skills/orchestrate" ] || fail 'Codex orchestrate は実ディレクトリでない'
[ ! -L "$ROOT/codex/skills/orchestrate" ] || fail 'Codex orchestrate が symlink のまま'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" '](../../../shared/orchestrate/contract.md)'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" '](../../../shared/orchestrate/delegation-contract.md)'
contains "$ROOT/shared/orchestrate/contract.md" '統括の共通契約'
contains "$ROOT/shared/orchestrate/contract.md" '非目標（やらないこと）、既知の罠、検証方法を必ず含める'
contains "$ROOT/shared/orchestrate/contract.md" 'Control Recordの最小lifecycle'
contains "$ROOT/shared/orchestrate/delegation-contract.md" 'Delegation Packet（8点）'
contains "$ROOT/shared/orchestrate/delegation-contract.md" 'Worker Reportの受入'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" '](../../../shared/orchestrate/contract.md)'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" '](../../../shared/orchestrate/delegation-contract.md)'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" 'references/workflow-templates.md'
contains "$ROOT/PLAN.md" 'ラベル運用は統括レーンの4関節（writer委譲・受入裁定・Phase gate・H操作）の裁定用とする。'
contains "$ROOT/PLAN.md" '作業後はpushで真実を返す（本原則は、dotagentsと製品契約台帳で自作コアに分類された製品の正規repoに対する恒久push裁定である。第三者製品・基盤toolchainには適用しない。認定手順は憲法git鉄則に従う）'
contains "$ROOT/PLAN.md" '10. （書込みscopeは憲法「調査と知識の置き場」冒頭に従う）**知識は還流させて育てる（第二の脳）**'
contains "$ROOT/PLAN.md" '（書込みscopeは憲法「調査と知識の置き場」冒頭に従う）**方針級の発見はその場で正典へ**'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" '**配置は統括レーンの4関節で宣言**'
contains "$ROOT/shared/orchestrate/contract.md" '統括レーンへ入った後、4関節で扱う役割をF/A/Hに分ける。'
# shellcheck disable=SC2016 # backticks are literal Markdown from the contract.
contains "$ROOT/shared/orchestrate/contract.md" '対象projectの`docs/`にあるcampaign計画正本を最初に確認し、実行TODOの正本はtyped discovery（憲法「計画文書の作法」）で決める。'
contains "$ROOT/shared/orchestrate/control-record.md" 'docs計画正本（実行TODOの正本はtyped discoveryで解決）'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" '反証は親と同値のaliasを明示×high。finderはsonnet×low'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" '親と同値のaliasを明示×順位表のeffort'
contains "$ROOT/claude/skills/orchestrate/references/workflow-templates.md" "model:'sonnet', effort:'low'"
contains "$ROOT/claude/skills/orchestrate/references/workflow-templates.md" "model:'sonnet', effort:'medium'"
contains "$ROOT/claude/skills/orchestrate/references/workflow-templates.md" "const PARENT_ALIAS = 'opus'; // copy時に親と同値のfloating aliasへ変更（docs/02_models.md 順位表「反証」行）"
assert_order "$ROOT/claude/skills/orchestrate/references/workflow-templates.md" \
  "phase('Verify')" \
  "model:PARENT_ALIAS, effort:'high'" \
  "phase('Critic')" \
  "model:PARENT_ALIAS, effort:'high'"
# shellcheck disable=SC2016 # backticks are literal Markdown from the workflow contract.
contains "$ROOT/claude/skills/orchestrate/references/workflow-templates.md" '`fable×high`の使用は、親が最上位未満かつ契約クリティカルのPhase gateで1回だけ（02_models 順位表「相談」行のFable 5×highスポット）。雛形の既定にしない。'
[ ! -e "$ROOT/claude/skills/orchestrate/references/delegation-contract.md" ] || fail 'Claude 固有の旧 delegation-contract.md が残っている'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" 'agent_type=<role>'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" 'fork_turns="none"'
assert_order "$ROOT/codex/skills/orchestrate/SKILL.md" \
  'Control配下の書込み Workerだけは最初のspawnをrouting smoke のみにする' \
  'verify-codex-agent-routing' \
  'follow-up で実作業を渡す'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" '通常のnative audit・refuter・sorterはspawn時の任務をそのまま実行し、事前smokeを要求しない'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" '実効sandboxは親から継承し、role TOMLで別権限を保証しない'
contains "$ROOT/README.md" '通常のnative audit・refuter・sorterは事前smokeなしで実行できる'
contains "$ROOT/README.md" 'Control配下の書込みWorkerだけは'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" '呼び出し側が手指定しない'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" '入れ子のCodexを起動してよい'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" 'execution-verified'
contains "$ROOT/shared/orchestrate/delegation-contract.md" '同一taskを重複起動しない'
contains "$ROOT/shared/orchestrate/contract.md" '対象diff、受入条件、関連gate、未検証範囲を自ら確認してaccept/reject'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" 'tightに結合した作業ならCodex native'
contains "$ROOT/codex/skills/orchestrate/SKILL.md" '通常レーンは委譲を既定にしない'
contains "$ROOT/shared/orchestrate/executor-adapters.md" 'まず新規admissionを止める'
# shellcheck disable=SC2016 # backticks are literal Markdown from the contract.
contains "$ROOT/shared/orchestrate/executor-adapters.md" '`unknown`を別terminal stateへ暗黙変換しない'
# 2026-07-16裁定: 委譲3レーン・4段階はdocs/02、worker安全契約はdelegation-contractが正典（生成憲法は共通部のみ）
contains "$ROOT/docs/02_models.md" '① native subagent＝'
contains "$ROOT/docs/02_models.md" '② external execution＝'
contains "$ROOT/docs/02_models.md" '③ consultation＝'
contains "$ROOT/shared/orchestrate/delegation-contract.md" 'branch切替、commit、push、merge、rebase、reset、stash'
contains "$ROOT/shared/orchestrate/delegation-contract.md" '秘密・token・cookie・OAuth・private key'
contains "$ROOT/docs/02_models.md" 'installed→registered→verified→execution-verified'
contains "$ROOT/docs/05_codex-fragments.md" 'codex mcp add codex-sidecar -- codex-sidecar-mcp'
if rg -qi 'Workflow' "$ROOT/codex/skills/orchestrate/SKILL.md"; then
  fail 'Codex orchestrate が Claude 専用 Workflow を実行入口としている'
fi

deploy="$ROOT/codex/skills/auto-deploy-on-push/SKILL.md"
assert_order "$deploy" \
  '読み取り専用で' \
  '目的、影響範囲、失敗時の rollback を説明する' \
  '説明のあと対象範囲を狭く保ち' \
  '変更後は静的検証'
# shellcheck disable=SC2016 # backticks are literal Markdown from the skill contract.
contains "$deploy" '説明せずに鍵生成、`authorized_keys` 変更、Secrets 登録、workflow 書き込み、push、workflow 実行をしてはならない'
contains "$deploy" '秘密値は表示・収集・保存しない'
contains "$deploy" '秘密をログ・文書・commit に含めない'
contains "$deploy" '承認待ちにしない'
contains "$deploy" '../../../claude/skills/auto-deploy-on-push/SKILL.md'

polish="$ROOT/codex/skills/polish-github/SKILL.md"
# shellcheck disable=SC2016 # backticks are literal Markdown from the skill contract.
contains "$polish" '同じdotagents checkoutの`claude/commands/polish-github.md`'
contains "$polish" 'C:\Users\kite_\Developer\dotagent'
contains "$polish" '正本が読めない場合はエラーとして報告'
contains "$polish" '以下の要約だけで代行しない（フォールバック禁止）'

# 現行の主要 workflow 3件と Codex 正規入口を固定する。
contains "$ROOT/README.md" "| Claude skill | \`orchestrate\` |"
contains "$ROOT/README.md" "| Codex skill | \`orchestrate\` |"
contains "$ROOT/README.md" "| Claude skill | \`auto-deploy-on-push\` |"
contains "$ROOT/README.md" "| Codex skill | \`auto-deploy-on-push\` |"
contains "$ROOT/README.md" "| Claude command | \`auto-deploy-on-push\` / \`polish-github\` |"
contains "$ROOT/README.md" "| Codex skill | \`polish-github\` |"
contains "$ROOT/README.md" "| \`/auto-deploy-on-push\` | \`\$auto-deploy-on-push\` |"
contains "$ROOT/README.md" "| \`/polish-github\` | \`\$polish-github\` |"
[ ! -e "$ROOT/codex/skills/audit-gauntlet" ] || fail 'retired Codex skill audit-gauntlet が残っている'
for file in \
  "$ROOT/codex/skills/orchestrate/SKILL.md" \
  "$ROOT/codex/skills/auto-deploy-on-push/SKILL.md" \
  "$ROOT/codex/skills/polish-github/SKILL.md"; do
  for claude_entry in AskUserQuestion EnterPlanMode ExitPlanMode TaskCreate TaskUpdate TodoWrite 'Agent(' 'Task(' 'Workflow('; do
    absent "$file" "$claude_entry"
  done
done

# 現行 Claude surface: 配布される skill / command / agent の入口契約だけを確認する。
for skill in auto-deploy-on-push gpt-connector orchestrate; do
  file="$ROOT/claude/skills/$skill/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
  contains "$file" "name: $skill"
done
contains "$ROOT/claude/skills/auto-deploy-on-push/SKILL.md" 'GitHub Actions'
# shellcheck disable=SC2016 # backticks are literal Markdown from the skill contract.
contains "$ROOT/claude/skills/gpt-connector/SKILL.md" '正規MCP server IDは `gpt_connector`'
contains "$ROOT/claude/skills/gpt-connector/SKILL.md" 'Oracle/OpenAI APIへの暗黙fallbackはしない'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" '共通契約'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" '委譲契約'
contains "$ROOT/claude/skills/orchestrate/SKILL.md" 'references/workflow-templates.md'

for command in auto-deploy-on-push polish-github; do
  file="$ROOT/claude/commands/$command.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_has_keys "$file" description
done
# shellcheck disable=SC2016 # backticks are literal Markdown from the command contract.
contains "$ROOT/claude/commands/auto-deploy-on-push.md" 'スキル `auto-deploy-on-push`'
contains "$ROOT/claude/commands/polish-github.md" '次に **現状監査** だけ実行'
contains "$ROOT/claude/commands/polish-github.md" 'ユーザーが GO サインを出してから着手する'

for agent in implementer refuter; do
  file="$ROOT/claude/agents/$agent.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_has_keys "$file" name description
  contains "$file" "name: $agent"
done
contains "$ROOT/claude/agents/implementer.md" 'model: sonnet'
contains "$ROOT/claude/agents/implementer.md" 'git commit`・push は禁止'
contains "$ROOT/claude/agents/refuter.md" '読み取り専用'
contains "$ROOT/claude/agents/refuter.md" '書き込み禁止'

for skill in orchestrate auto-deploy-on-push polish-github gpt-connector; do
  file="$ROOT/cursor/skills/$skill/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
done
contains "$ROOT/cursor/skills/orchestrate/SKILL.md" '](../../../shared/orchestrate/contract.md)'
contains "$ROOT/cursor/skills/orchestrate/SKILL.md" '](../../../shared/orchestrate/delegation-contract.md)'
contains "$ROOT/cursor/skills/orchestrate/SKILL.md" 'GetDynamicTools'
absent "$ROOT/cursor/skills/orchestrate/SKILL.md" 'mcp__aiterm__pty_'
absent "$ROOT/cursor/skills/orchestrate/SKILL.md" 'spawn_agent'
[ ! -e "$ROOT/cursor/skills-cursor" ] || fail 'cursor/skills-cursor を工場所有にした'
for agent in implementer refuter; do
  file="$ROOT/cursor/agents/$agent.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_has_keys "$file" name description
  contains "$file" "name: $agent"
done
contains "$ROOT/cursor/agents/implementer.md" 'git commit`・pushは禁止'
contains "$ROOT/cursor/agents/refuter.md" '書き込み禁止'

[ ! -e "$ROOT/claude/skills/audit-gauntlet" ] || fail 'retired Claude skill audit-gauntlet が残っている'
[ ! -e "$ROOT/claude/commands/audit-gauntlet.md" ] || fail 'retired Claude command audit-gauntlet が残っている'
[ ! -e "$ROOT/claude/agents/audit-gauntlet.md" ] || fail 'retired Claude agent audit-gauntlet が残っている'

echo 'skills smoke: OK'
