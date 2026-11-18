#!/usr/bin/env bash
# oracle rollback用Chromeへ旧画面外座標を付ける互換シム（CHROME_PATH に指定して使う）。
# oracle の hideWindow(Cmd-H) は非表示アプリの描画停止により ChatGPT の送信・DOM 検知が
# 壊れるため使えない（2026-07-11 実測: 送信が下書きのまま残り、後続 run に混入する）。
# 2026-07-14の複数display実測ではmacOS/Chromeが画面内へclampしたため、非可視を保証しない。
# Oracle rollback互換のためだけに残す（gpt-connectorは2026-11-18に廃止）。
set -euo pipefail

normalize_path() {
  case "$1" in
    [A-Za-z]:\\* | [A-Za-z]:/*)
      if command -v cygpath >/dev/null 2>&1; then
        cygpath -u "$1"
      else
        printf '%s\n' "$1"
      fi
      ;;
    *) printf '%s\n' "$1" ;;
  esac
}

chrome="${ORACLE_CHROME_BIN:-}"
if [ -z "$chrome" ]; then
  case "$(uname -s)" in
    Darwin)
      chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      ;;
    MINGW* | MSYS* | CYGWIN*)
      local_app_data="$(normalize_path "${LOCALAPPDATA:-}")"
      for candidate in \
        "$local_app_data/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files/Google/Chrome/Application/chrome.exe" \
        "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"; do
        if [ -n "$candidate" ] && [ -x "$candidate" ]; then
          chrome="$candidate"
          break
        fi
      done
      ;;
    *)
      for command_name in google-chrome google-chrome-stable chromium chromium-browser; do
        if command -v "$command_name" >/dev/null 2>&1; then
          chrome="$(command -v "$command_name")"
          break
        fi
      done
      ;;
  esac
fi

if [ -z "$chrome" ] || [ ! -x "$chrome" ]; then
  printf 'FATAL: Oracle 用 Chrome を解決できない（ORACLE_CHROME_BIN で明示可能）\n' >&2
  exit 1
fi

exec "$chrome" --window-position=-32000,-32000 "$@"
