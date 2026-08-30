#!/usr/bin/env bash
# Symlink dotagents entries into ~/.claude/{skills,commands}, a selected Codex skill surface, ~/.grok/rules, and ~/.cursor/rules.
# Idempotent: re-running overwrites existing symlinks but never removes unrelated files.
set -euo pipefail

profile=official
profile_set=false
usage() {
  cat <<'EOF'
使い方: ./install.sh [--profile official|legacy]

Codex skill 配布先:
  official  ~/.agents/skills （既定）
  legacy    ~/.codex/skills
EOF
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --profile)
      [ "$#" -ge 2 ] || { echo 'FAIL: --profile には official または legacy が必要' >&2; exit 2; }
      [ "$profile_set" = false ] || { echo 'FAIL: --profile を重複指定できない' >&2; exit 2; }
      profile="$2"; profile_set=true; shift 2 ;;
    --profile=*)
      [ "$profile_set" = false ] || { echo 'FAIL: --profile を重複指定できない' >&2; exit 2; }
      profile="${1#--profile=}"; profile_set=true; shift ;;
    *) echo "FAIL: 不明な引数: $1" >&2; usage >&2; exit 2 ;;
  esac
done
case "$profile" in official|legacy) ;; *) echo "FAIL: 不正な profile: $profile" >&2; exit 2 ;; esac

# MSYS/Git Bash（Windows native）: 無指定だと ln -s が実コピーになり正本化が静かに不成立する。
# 開発者モード ON 前提で本物の symlink を強制（非対応なら ln が失敗して止まる＝静かなコピーへ逃げない）。
case "$(uname -s)" in MINGW*|MSYS*) export MSYS=winsymlinks:nativestrict ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "Codex skill profile: $profile"

link_one() {
  local src="$1" dst="$2"
  if [ -e "$dst" ] && [ ! -L "$dst" ]; then
    echo "SKIP (real file exists — 退避しないと本リポ版が使われない): $dst" >&2
    return 0
  fi
  ln -sfn "$src" "$dst"
  echo "linked: $dst -> $src"
}

remove_retired_link() {
  local path="$1" expected_target="$2"
  [ -L "$path" ] || return 0
  if [ "$(readlink "$path")" = "$expected_target" ]; then
    rm "$path"
    echo "removed retired link: $path"
  fi
}

# 廃止済みの dotagents 所有入口だけを除去する。実ファイルや別所有者の
# symlink は触らず、旧 official / legacy の双方に残る dangling link を防ぐ。
remove_retired_link "$HOME/.claude/skills/audit-gauntlet" "$HERE/claude/skills/audit-gauntlet"
remove_retired_link "$HOME/.claude/commands/audit-gauntlet.md" "$HERE/claude/commands/audit-gauntlet.md"
remove_retired_link "$HOME/.agents/skills/audit-gauntlet" "$HERE/codex/skills/audit-gauntlet"
remove_retired_link "$HOME/.codex/skills/audit-gauntlet" "$HERE/codex/skills/audit-gauntlet"

# Claude
mkdir -p "$HOME/.claude/skills" "$HOME/.claude/commands" "$HOME/.claude/agents"
# global CLAUDE.md (canonical copy lives in this repo; terminals must remove any
# pre-existing real file first — link_one SKIPs real files by design)
if [ -e "$HERE/claude/CLAUDE.md" ]; then
  link_one "$HERE/claude/CLAUDE.md" "$HOME/.claude/CLAUDE.md"
fi
if [ -d "$HERE/shared/runbooks" ]; then
  link_one "$HERE/shared/runbooks" "$HOME/.claude/runbooks"
fi
for d in "$HERE/claude/skills"/*/; do
  [ -d "$d" ] || continue
  link_one "${d%/}" "$HOME/.claude/skills/$(basename "$d")"
done
for f in "$HERE/claude/commands"/*.md; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.claude/commands/$(basename "$f")"
done
for f in "$HERE/claude/agents"/*.md; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.claude/agents/$(basename "$f")"
done

# Codex（skill 面は profile ごとに一方だけへ配布）
mkdir -p "$HOME/.codex/rules" "$HOME/.codex/agents"
if [ "$profile" = official ]; then
  codex_skills_dir="$HOME/.agents/skills"
else
  codex_skills_dir="$HOME/.codex/skills"
fi
mkdir -p "$codex_skills_dir"
if [ -e "$HERE/codex/AGENTS.md" ]; then
  link_one "$HERE/codex/AGENTS.md" "$HOME/.codex/AGENTS.md"
fi
if [ -d "$HERE/shared/runbooks" ]; then
  link_one "$HERE/shared/runbooks" "$HOME/.codex/runbooks"
fi
for d in "$HERE/codex/skills"/*/; do
  [ -d "$d" ] || continue
  link_one "${d%/}" "$codex_skills_dir/$(basename "$d")"
done
for f in "$HERE/codex/rules"/*; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.codex/rules/$(basename "$f")"
done
for f in "$HERE/codex/agents"/*.toml; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.codex/agents/$(basename "$f")"
done

# Grok（憲法・runbook・skill・agent・hook）
mkdir -p "$HOME/.grok/rules" "$HOME/.grok/skills" "$HOME/.grok/agents" "$HOME/.grok/hooks"
if [ -e "$HERE/grok/AGENTS.md" ]; then
  link_one "$HERE/grok/AGENTS.md" "$HOME/.grok/rules/AGENTS.md"
fi
if [ -d "$HERE/shared/runbooks" ]; then
  link_one "$HERE/shared/runbooks" "$HOME/.grok/runbooks"
fi
for d in "$HERE/grok/skills"/*/; do
  [ -d "$d" ] || continue
  link_one "${d%/}" "$HOME/.grok/skills/$(basename "$d")"
done
for f in "$HERE/grok/agents"/*.md; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.grok/agents/$(basename "$f")"
done
for f in "$HERE/grok/hooks"/*.json; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.grok/hooks/$(basename "$f")"
done

# Cursor（憲法は native rules の factory.mdc のみ。AGENTS.md は生成物として保持し ~/.cursor へは置かない）
mkdir -p "$HOME/.cursor/rules" "$HOME/.cursor/skills" "$HOME/.cursor/agents"
if [ -e "$HERE/cursor/rules/factory.mdc" ]; then
  link_one "$HERE/cursor/rules/factory.mdc" "$HOME/.cursor/rules/factory.mdc"
  # Desktop 3.17.8 の getGlobalRules は workspace 内 .cursor/rules だけ always-apply する。
  # 同一正本の overlay。窓への --add はしない（last-active を誤る）。
  mkdir -p "$HOME/.cursor/factory-constitution/.cursor/rules"
  link_one "$HERE/cursor/rules/factory.mdc" "$HOME/.cursor/factory-constitution/.cursor/rules/factory.mdc"
fi
if [ -d "$HERE/shared/runbooks" ]; then
  link_one "$HERE/shared/runbooks" "$HOME/.cursor/runbooks"
fi
for d in "$HERE/cursor/skills"/*/; do
  [ -d "$d" ] || continue
  link_one "${d%/}" "$HOME/.cursor/skills/$(basename "$d")"
done
for f in "$HERE/cursor/agents"/*.md; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.cursor/agents/$(basename "$f")"
done

# caveat own entries — Caveat v0.15+ manages its own sync (dotagents no longer
# owns the trap DB). The knowledge repo lives at ~/.caveat/own as a standalone
# git repo whose remote is the PRIVATE github.com/<you>/Caveat-Private (public
# + private entries; the public subset is mirrored to Caveat-Public via
# `caveat publish`). Set it up per machine with the tool, not a symlink:
#   caveat sync --init            # first machine: gh-creates Caveat-Private, pushes
#   caveat sync --init --repo <Caveat-Private-url>   # later machines: clones it
# and thereafter `caveat sync` round-trips. This installer intentionally does
# not wire ~/.caveat/own — that is Caveat's job now.
if [ -d "$HERE/caveat" ]; then
  echo "NOTE: dotagents/caveat is a leftover from the pre-v0.15 symlink model." >&2
  echo "      Caveat now syncs ~/.caveat/own to Caveat-Private itself; see comment above." >&2
fi

# bin scripts (extension dropped at the destination, e.g. agents-update.sh -> agents-update)
mkdir -p "$HOME/.local/bin"
remove_retired_link \
  "$HOME/.local/bin/windows-native-product-smoke" \
  "$HERE/bin/windows-native-product-smoke.mjs"
remove_retired_link \
  "$HOME/.local/bin/render-current-docs" \
  "$HERE/bin/render-current-docs.mjs"
for f in "$HERE/bin"/*.sh; do
  [ -e "$f" ] || continue
  link_one "$f" "$HOME/.local/bin/$(basename "$f" .sh)"
done
for f in "$HERE/bin"/*.mjs; do
  [ -e "$f" ] || continue
  [ "$(basename "$f")" != render-current-docs.mjs ] || continue
  link_one "$f" "$HOME/.local/bin/$(basename "$f" .mjs)"
done

# Windows Codex Desktop から WSL2 projectを開く経路を、Windows native projectと分離する。
# 非WSL hostではSKIP。WSLではSSH配線に加え、WSL正規hooksをWindows Desktopへ投影する。
"$HERE/bin/configure-windows-wsl-ssh.sh" --apply

echo "done."
