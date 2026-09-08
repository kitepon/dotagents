#!/usr/bin/env bash
# apply-grok-config の Wave 1 面を実 HOME に触れず検証する。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PYTHONIOENCODING=utf-8
case "$(uname -s)" in MINGW*|MSYS*) export MSYS=winsymlinks:nativestrict ;; esac
HOME_FIXTURE="$(mktemp -d)"
ABSENT_HOME="$(mktemp -d)"
SYMLINK_HOME="$(mktemp -d)"
RESOLVE_HOME="$(mktemp -d)"
SUBTABLE_HOME="$(mktemp -d)"
STUB_BIN="$(mktemp -d)"
trap 'rm -rf "$HOME_FIXTURE" "$ABSENT_HOME" "$SYMLINK_HOME" "$RESOLVE_HOME" "$SUBTABLE_HOME" "$STUB_BIN"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

HOME="$HOME_FIXTURE" "$ROOT/install.sh" --profile official >/dev/null
[ -L "$HOME_FIXTURE/.local/bin/apply-grok-config" ] \
  || fail 'apply-grok-config を ~/.local/bin へ配布しない'
assert_link() {
  if [ ! -L "$1" ] || [ "$(readlink "$1")" != "$2" ]; then
    fail "$1 が $2 向き symlink でない"
  fi
}
assert_link "$HOME_FIXTURE/.grok/rules/AGENTS.md" "$ROOT/grok/AGENTS.md"
assert_link "$HOME_FIXTURE/.grok/runbooks" "$ROOT/shared/runbooks"
assert_link "$HOME_FIXTURE/.grok/skills/orchestrate" "$ROOT/grok/skills/orchestrate"
assert_link "$HOME_FIXTURE/.grok/agents/refuter.md" "$ROOT/grok/agents/refuter.md"
assert_link "$HOME_FIXTURE/.grok/hooks/factory.json" "$ROOT/grok/hooks/factory.json"

mkdir -p "$HOME_FIXTURE/.grok"
cat >"$HOME_FIXTURE/.grok/config.toml" <<'EOF'
[models]
default = "keep-me"
default_reasoning_effort = "xhigh"

[ui]
permission_mode = "always-approve"

[privacy]
privacy_banner_acked = "keep-login"

[mcp_servers.x-article]
url = "https://example.invalid/mcp"
enabled = true

[compat.claude]
skills = true
agents = true
hooks = true
EOF
before="$(cat "$HOME_FIXTURE/.grok/config.toml")"
hook_dry="$(HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-grok-config" --hooks-only --dry-run)"
grep -Fq 'symlink → 実ファイル' <<<"$hook_dry" || fail 'hook限定dry-runが実ファイル化を示さない'
if grep -Fq 'config.toml' <<<"$hook_dry"; then
  fail 'hook限定dry-runがconfig変更を含む'
fi
dry="$(HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-grok-config" --dry-run)"
grep -Fq 'agents = false' <<<"$dry" || fail 'dry-run が agents = false を出さない'
grep -Fq 'hooks = false' <<<"$dry" || fail 'dry-run が hooks = false を出さない'
grep -Fq '[mcp_servers.aiterm]' <<<"$dry" || fail 'dry-run が工場MCPを出さない'
[ "$(cat "$HOME_FIXTURE/.grok/config.toml")" = "$before" ] || fail 'dry-run が config.toml を書き換えた'
[ ! -d "$HOME_FIXTURE/Archives" ] || fail 'dry-run が backup を作った'
grep -Fq 'symlink → 実ファイル' <<<"$dry" || fail 'dry-run がhookの実ファイル化を示さない'
assert_link "$HOME_FIXTURE/.grok/hooks/factory.json" "$ROOT/grok/hooks/factory.json"

HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply >/dev/null
applied="$(cat "$HOME_FIXTURE/.grok/config.toml")"
grep -Fq 'default = "keep-me"' <<<"$applied" || fail 'models.default を書き換えた'
grep -Fq 'default_reasoning_effort = "xhigh"' <<<"$applied" || fail 'models.effort を書き換えた'
grep -Fq 'permission_mode = "always-approve"' <<<"$applied" || fail 'permission を書き換えた'
grep -Fq 'privacy_banner_acked = "keep-login"' <<<"$applied" || fail 'login/privacy を書き換えた'
grep -Fq 'skills = true' <<<"$applied" || fail 'compat.claude.skills を書き換えた'
grep -Fq 'hooks = false' <<<"$applied" || fail 'compat.claude.hooks を false にしない'
grep -Fq 'agents = false' <<<"$applied" || fail 'compat.claude.agents を false にしない'
if grep -Eq 'hooks[ \t]*=[ \t]*true' <<<"$applied"; then
  fail 'hooks = true が残っている'
fi
if grep -Eq 'agents[ \t]*=[ \t]*true' <<<"$applied"; then
  fail 'agents = true が残っている'
fi
grep -Fq 'url = "https://example.invalid/mcp"' <<<"$applied" || fail '個人MCP x-article を消した'
for name in aiterm caveat lattice codex-sidecar gpt_connector aishell; do
  grep -Fq "[mcp_servers.$name]" <<<"$applied" || fail "工場MCP $name を書かない"
done
if ! grep -Eqi 'command = "([^"]*[/\\])?caveat(\.cmd)?"' <<<"$applied"; then
  fail 'caveat command が契約と違う'
fi
grep -Fq 'args = ["mcp-server"]' <<<"$applied" || fail 'caveat args が契約と違う'
grep -Fq 'AISHELL_CAPABILITY_SET = "expanded-v1"' <<<"$applied" || fail 'aishell env が契約と違う'
[ ! -L "$HOME_FIXTURE/.grok/hooks/factory.json" ] \
  || fail 'factory.json が symlink のまま'
if [ "${OS:-}" = "Windows_NT" ]; then
  grep -Fq 'grok-lattice-gantt-hook' "$HOME_FIXTURE/.grok/hooks/factory.json" \
    || fail 'Windows factory.json に工場hook名が無い'
  grep -Eiq 'python' "$HOME_FIXTURE/.grok/hooks/factory.json" \
    || fail 'Windows factory.json が python interpreter を書かない'
fi

HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply | grep -Fq '変更なし' \
  || fail '2回目 apply が冪等でない'

printf '%s\n' '{"hooks":{}}' >"$HOME_FIXTURE/.grok/hooks/factory.json"
printf '%s\n' "$before" >"$HOME_FIXTURE/.grok/config.toml"
hook_only_config="$(cat "$HOME_FIXTURE/.grok/config.toml")"
HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-grok-config" --hooks-only --apply >/dev/null
[ "$(cat "$HOME_FIXTURE/.grok/config.toml")" = "$hook_only_config" ] \
  || fail 'hook限定適用がconfig.tomlを変更した'
grep -Fq 'grok-lattice-gantt-hook' "$HOME_FIXTURE/.grok/hooks/factory.json" \
  || fail '実ファイル化後のapplyがrepo正本を再反映しない'
HOME="$HOME_FIXTURE" "$HOME_FIXTURE/.local/bin/apply-grok-config" --hooks-only --apply | grep -Fq '変更なし' \
  || fail '正本再反映後のapplyが冪等でない'

HOME="$ABSENT_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply >/dev/null
grep -Fq '[compat.claude]' "$ABSENT_HOME/.grok/config.toml" || fail '不在の config.toml を作らない'
grep -Fq 'agents = false' "$ABSENT_HOME/.grok/config.toml" || fail '新規 config に agents = false を書かない'
grep -Fq 'hooks = false' "$ABSENT_HOME/.grok/config.toml" || fail '新規 config に hooks = false を書かない'
grep -Fq '[mcp_servers.lattice]' "$ABSENT_HOME/.grok/config.toml" || fail '新規 config に工場MCPを書かない'

mkdir -p "$SYMLINK_HOME/.grok" "$SYMLINK_HOME/target"
printf '%s\n' 'agents = true' >"$SYMLINK_HOME/target/config.toml"
ln -s "$SYMLINK_HOME/target/config.toml" "$SYMLINK_HOME/.grok/config.toml"
if HOME="$SYMLINK_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply >/dev/null 2>&1; then
  fail 'symlink config.toml への apply を受理した'
fi
grep -Fq 'agents = true' "$SYMLINK_HOME/target/config.toml" || fail 'symlink 先を書き換えた'

if [ "${OS:-}" = "Windows_NT" ]; then
  printf '%s\n' '@echo off' >"$STUB_BIN/caveat.cmd"
  mkdir -p "$RESOLVE_HOME/.grok"
  PATH="$STUB_BIN:$PATH" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply >/dev/null
  python - "$RESOLVE_HOME/.grok/config.toml" <<'PY'
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
if "caveat.cmd" not in text.lower():
    raise SystemExit("FAIL: 解決できた caveat を絶対パスで書かない")
if ";" not in text or "PATH = " not in text:
    raise SystemExit("FAIL: Windows の env.PATH が pathsep になっていない")
PY
  PATH="$STUB_BIN:$PATH" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply \
    | grep -Fq '変更なし' || fail '絶対パス適用の2回目が冪等でない'
  PYWIN="$(command -v python)"
  PATH="/usr/bin:/bin" HOME="$RESOLVE_HOME" "$PYWIN" "$ROOT/bin/apply-grok-config.sh" --apply \
    | grep -Fq '変更なし' || fail 'GUI PATH の apply が実行可能な絶対パスを名前へ戻した'
else
  printf '%s\n' '#!/bin/sh' 'exit 0' >"$STUB_BIN/caveat"
  chmod +x "$STUB_BIN/caveat"
  mkdir -p "$RESOLVE_HOME/.grok"
  PATH="$STUB_BIN:/usr/bin:/bin" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply >/dev/null
  grep -Fq "command = \"$STUB_BIN/caveat\"" "$RESOLVE_HOME/.grok/config.toml" \
    || fail '解決できた caveat を絶対パスで書かない'
  grep -Fq "PATH = \"$STUB_BIN:/usr/bin:/bin:/usr/sbin:/sbin\"" "$RESOLVE_HOME/.grok/config.toml" \
    || fail '解決できた command の親を env.PATH に置かない'
  PATH="$STUB_BIN:/usr/bin:/bin" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply \
    | grep -Fq '変更なし' || fail '絶対パス適用の2回目が冪等でない'
  PATH="/usr/bin:/bin" HOME="$RESOLVE_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply \
    | grep -Fq '変更なし' || fail 'GUI PATH の apply が実行可能な絶対パスを名前へ戻した'
fi

mkdir -p "$SUBTABLE_HOME/.grok"
cat >"$SUBTABLE_HOME/.grok/config.toml" <<'EOF'
[mcp_servers.caveat]
command = "caveat"
args = ["mcp-server"]
enabled = true

[mcp_servers.caveat.env]
PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

[mcp_servers.x-article]
url = "https://example.invalid/mcp"
enabled = true
EOF
HOME="$SUBTABLE_HOME" "$HOME_FIXTURE/.local/bin/apply-grok-config" --apply >/dev/null
subtable_applied="$(cat "$SUBTABLE_HOME/.grok/config.toml")"
if grep -Fq '[mcp_servers.caveat.env]' <<<"$subtable_applied"; then
  fail '工場MCPの env 表を残して inline env と二重にする'
fi
grep -Fq '[mcp_servers.caveat]' <<<"$subtable_applied" || fail 'env 表の工場MCP本体を消した'
grep -Fq 'url = "https://example.invalid/mcp"' <<<"$subtable_applied" || fail 'env 表の畳み込みで個人MCPを消した'
if ! grep -Eq 'env = \{[^}]*PATH =' <<<"$subtable_applied"; then
  fail 'env 表を畳んだあと inline env を書かない'
fi

echo 'apply-grok-config: OK'
