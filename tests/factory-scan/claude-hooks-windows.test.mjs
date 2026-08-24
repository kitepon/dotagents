import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { canonicalClaudeHookCommand } from '../../lib/factory/v5.mjs';

const home = 'C:\\Users\\kite_';
const hook = (name) => join(home, '.local', 'bin', name);

test('Claude hook command は POSIX 形をそのまま受理する', () => {
  assert.equal(canonicalClaudeHookCommand('~/.local/bin/delegation-gate-hook', home, '~/.local/bin/delegation-gate-hook'), true);
  assert.equal(canonicalClaudeHookCommand('~/.local/bin/todo-gate-hook session-start', home, '~/.local/bin/todo-gate-hook session-start'), true);
});

// validator（canonicalClaudeHookCommand）はhost相対のpath.joinで期待hook pathを組む設計なので、
// Windows形の受理はwin32 hostでだけ成立する。POSIX hostでの実行は仕様どおりfalseになるためskipする
//（macOSローカルで恒常failしていた既存の欠陥testの修理。CIのWindows laneでは従来どおり検証される）。
test('Claude hook command は Windows の interpreter + 絶対 path を受理する', { skip: process.platform !== 'win32' }, () => {
  assert.equal(
    canonicalClaudeHookCommand(
      `C:\\Users\\kite_\\AppData\\Local\\Programs\\Python\\Python312\\python3.exe ${hook('delegation-gate-hook')}`,
      home,
      '~/.local/bin/delegation-gate-hook',
    ),
    true,
  );
  assert.equal(
    canonicalClaudeHookCommand(
      `C:\\Users\\kite_\\AppData\\Local\\Programs\\Python\\Python312\\python3.exe ${hook('todo-gate-hook')} session-start`,
      home,
      '~/.local/bin/todo-gate-hook session-start',
    ),
    true,
  );
  assert.equal(
    canonicalClaudeHookCommand(
      `"C:\\Program Files\\Git\\bin\\sh.exe" ${hook('plan-gate-hook')}`,
      home,
      '~/.local/bin/plan-gate-hook',
    ),
    true,
  );
  assert.equal(
    canonicalClaudeHookCommand(
      `"C:\\Users\\kite_\\AppData\\Local\\Programs\\Python\\Python312\\python3.exe" "${hook('delegation-gate-hook')}"`,
      home,
      '~/.local/bin/delegation-gate-hook',
    ),
    true,
  );
});

test('Claude hook command は別 script・引数ずれ・prefix を拒否する', () => {
  assert.equal(
    canonicalClaudeHookCommand(
      `C:\\Users\\kite_\\AppData\\Local\\Programs\\Python\\Python312\\python3.exe ${hook('onset-gate-hook')}`,
      home,
      '~/.local/bin/delegation-gate-hook',
    ),
    false,
  );
  assert.equal(
    canonicalClaudeHookCommand(
      `C:\\Users\\kite_\\AppData\\Local\\Programs\\Python\\Python312\\python3.exe ${hook('todo-gate-hook')}`,
      home,
      '~/.local/bin/todo-gate-hook session-start',
    ),
    false,
  );
  assert.equal(
    canonicalClaudeHookCommand(
      `prefix ${hook('delegation-gate-hook')}`,
      home,
      '~/.local/bin/delegation-gate-hook',
    ),
    false,
  );
});
