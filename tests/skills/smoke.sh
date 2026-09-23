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

for skill in auto-deploy-on-push polish-github; do
  file="$ROOT/codex/skills/$skill/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
  rg -q '^name: ' "$file" || fail "$file に frontmatter name がない"
  rg -q '^description: ' "$file" || fail "$file に frontmatter description がない"
  yaml="$ROOT/codex/skills/$skill/agents/openai.yaml"
  [ -f "$yaml" ] || fail "$yaml がない"
  contains "$yaml" "\$$skill"
done

contains "$ROOT/PLAN.md" 'ラベル運用は統括レーンの4関節（writer委譲・受入裁定・Phase gate・H操作）の裁定用とする。'
contains "$ROOT/PLAN.md" '作業後はpushで真実を返す（本原則は、dotagentsと製品契約台帳で自作コアに分類された製品の正規repoに対する恒久push裁定である。第三者製品・基盤toolchainには適用しない。認定手順は憲法git鉄則に従う）'
contains "$ROOT/PLAN.md" '10. （書込みscopeは憲法「調査と知識の置き場」冒頭に従う）**知識は還流させて育てる（第二の脳）**'
contains "$ROOT/PLAN.md" '（書込みscopeは憲法「調査と知識の置き場」冒頭に従う）**方針級の発見はその場で正典へ**'
contains "$ROOT/shared/runbooks/02_models.md" '| 反証 | GPT-6 Sol×high、Grok 4.7×high（同格） | Opus 5.5×high | — |'
contains "$ROOT/shared/runbooks/02_models.md" '| 実装 | GPT-6 Sol×high、Opus 5.5×medium（同格） | Grok 4.7×medium | — |'
contains "$ROOT/docs/05_codex-fragments.md" 'codex mcp add codex-sidecar -- codex-sidecar-mcp'

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
contains "$polish" 'C:\Users\kite_\Developer\dotagents'
contains "$polish" '正本が読めない場合はエラーとして報告'
contains "$polish" '以下の要約だけで代行しない（フォールバック禁止）'

# 現行の主要 workflow 3件と Codex 正規入口を固定する。
contains "$ROOT/README.md" "| Claude skill | \`auto-deploy-on-push\` |"
contains "$ROOT/README.md" "| Codex skill | \`auto-deploy-on-push\` |"
contains "$ROOT/README.md" "| Claude command | \`auto-deploy-on-push\` / \`polish-github\` |"
contains "$ROOT/README.md" "| Codex skill | \`polish-github\` |"
contains "$ROOT/README.md" "| \`/auto-deploy-on-push\` | \`\$auto-deploy-on-push\` |"
contains "$ROOT/README.md" "| \`/polish-github\` | \`\$polish-github\` |"
[ ! -e "$ROOT/codex/skills/audit-gauntlet" ] || fail 'retired Codex skill audit-gauntlet が残っている'
for file in \
  "$ROOT/codex/skills/auto-deploy-on-push/SKILL.md" \
  "$ROOT/codex/skills/polish-github/SKILL.md"; do
  for claude_entry in AskUserQuestion EnterPlanMode ExitPlanMode TaskCreate TaskUpdate TodoWrite 'Agent(' 'Task(' 'Workflow('; do
    absent "$file" "$claude_entry"
  done
done

# 現行 Claude surface: 配布される skill / command / agent の入口契約だけを確認する。
for skill in auto-deploy-on-push gpt-connector; do
  file="$ROOT/claude/skills/$skill/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
  contains "$file" "name: $skill"
done
contains "$ROOT/claude/skills/auto-deploy-on-push/SKILL.md" 'GitHub Actions'
# shellcheck disable=SC2016 # backticks are literal Markdown from the skill contract.
contains "$ROOT/claude/skills/gpt-connector/SKILL.md" '正規MCP server IDは `gpt_connector`'
contains "$ROOT/claude/skills/gpt-connector/SKILL.md" 'https://github.com/kitepon/gpt-connector#readme'
contains "$ROOT/claude/skills/gpt-connector/SKILL.md" '製品の操作契約を複製しない'

# gpt-connectorは全harnessで同じ製品正本を指し、各面にはrouting差分だけを置く。
for harness in claude codex grok cursor; do
  file="$ROOT/$harness/skills/gpt-connector/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
  # shellcheck disable=SC2016 # backticksを含むMarkdownのliteralを検査する。
  contains "$file" '`gpt_connector`'
  # shellcheck disable=SC2016 # backticksを含むMarkdownのliteralを検査する。
  contains "$file" '`gpt-connector-mcp`'
  contains "$file" 'https://github.com/kitepon/gpt-connector#readme'
  contains "$file" '製品の操作契約を複製しない'
done

contains "$ROOT/codex/skills/oracle/SKILL.md" '../../../docs/archive/2026-08_06_oracle-mcp.md'
contains "$ROOT/codex/skills/oracle/SKILL.md" '通常入口はgpt-connector'

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

for skill in auto-deploy-on-push polish-github gpt-connector; do
  file="$ROOT/cursor/skills/$skill/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
done
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
