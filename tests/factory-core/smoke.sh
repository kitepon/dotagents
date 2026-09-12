#!/usr/bin/env bash
# 工場所有の配線だけを確認し、製品CLIを再検査しない。
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HOME_DIR="$TMP/home"
BIN_DIR="$TMP/bin"
mkdir -p "$HOME_DIR/.local/bin" "$BIN_DIR"
printf '#!/bin/sh\nexit 0\n' > "$HOME_DIR/.local/bin/oracle-mcp-stable"
chmod +x "$HOME_DIR/.local/bin/oracle-mcp-stable"
for product in caveat throughline spotter lattice markitdown gpt-connector aiterm-mcp codex-sidecar unai aishell-mcp claude codex; do
  cat > "$BIN_DIR/$product" <<'EOF'
#!/bin/sh
printf 'called\n' >> "$FACTORY_PRODUCT_CALLS"
exit 91
EOF
  chmod +x "$BIN_DIR/$product"
done
verify_core() {
  HOME="$HOME_DIR" PATH="$BIN_DIR:$PATH" FACTORY_PRODUCT_CALLS="$TMP/product-calls" \
    DOTAGENTS_FACTORY_CORE_ONLY=1 bash "$ROOT/bin/verify-install.sh" --profile official
}
verify_core
[ ! -e "$TMP/product-calls" ] || { echo 'FAIL: 工場が製品CLIを追加検査した'; exit 1; }
chmod -x "$HOME_DIR/.local/bin/oracle-mcp-stable"
if verify_core >/dev/null 2>&1; then echo 'FAIL: 工場所有wrapperの実行不能を検出しない'; exit 1; fi
chmod +x "$HOME_DIR/.local/bin/oracle-mcp-stable"
printf '#!/bin/sh\nexit 0\n' > "$BIN_DIR/codegraph"
chmod +x "$BIN_DIR/codegraph"
if verify_core >/dev/null 2>&1; then echo 'FAIL: 工場の退役配線を検出しない'; exit 1; fi
echo 'factory ownership smoke: OK'
