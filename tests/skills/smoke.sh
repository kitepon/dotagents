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

# 現行 Claude surface: 配布される skill / command / agent の入口契約だけを確認する。
for skill in auto-deploy-on-push gpt-connector; do
  file="$ROOT/claude/skills/$skill/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
  contains "$file" "name: $skill"
done

# gpt-connectorは全harnessで同じ製品正本を指し、各面にはrouting差分だけを置く。
for harness in claude codex grok cursor; do
  file="$ROOT/$harness/skills/gpt-connector/SKILL.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_is_name_and_description_only "$file"
done

for command in auto-deploy-on-push polish-github; do
  file="$ROOT/claude/commands/$command.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_has_keys "$file" description
done

for agent in implementer refuter; do
  file="$ROOT/claude/agents/$agent.md"
  [ -f "$file" ] || fail "$file がない"
  frontmatter_has_keys "$file" name description
  contains "$file" "name: $agent"
done

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

echo 'skills smoke: OK'
