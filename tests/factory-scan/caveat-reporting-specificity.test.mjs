import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { caveatChecks } from '../../lib/factory/v5.mjs';

const NOW = '2026-10-25T09:00:00.000Z';
function diagnostic(id, reason) {
  const part = { status: 'not_ready', reason_code: reason };
  if (['database', 'sync'].includes(id)) return { [id]: part };
  if (id.endsWith('_mcp')) return { connectors: { [id.slice(0, -4)]: { mcp: part } } };
  const [host, event] = id.split('_hook_');
  return { connectors: { [host]: { hooks: { [event]: part } } } };
}
test('各clientのMCP/hook不足に処理と観測・必要状態を添え、通常failの全情報を保持する', () => {
  const ids = ['claude_mcp', 'grok_mcp', 'claude_hook_post_tool_use', 'codex_hook_stop', 'cursor_hook_before_submit_prompt'];
  for (const id of ids) {
    const reason = id.endsWith('_mcp') ? 'not_registered' : 'not_installed';
    const input = diagnostic(id, reason), original = structuredClone(input);
    const [check] = caveatChecks(input, 'not_ready', NOW);
    const { message_template: message, ...fields } = check;
    assert.deepEqual(fields, { check_id: id, status: 'fail', severity: 'warn',
      fingerprint: createHash('sha256').update(`caveat\0${id}`).digest('hex'),
      occurrence_count: 1, first_seen: NOW, last_seen: NOW, reason_code: reason });
    assert.ok(message.startsWith(`caveat ${id} failed。処理=`));
    assert.ok(message.includes(`観測=not_ready、理由=${reason}`));
    assert.ok(message.includes(id.endsWith('_mcp') ? 'MCP登録を確認できない' : 'hook定義を確認できない'));
    assert.ok(message.includes(id.endsWith('_mcp') ? '必要状態=診断CLIに対応する有効なCaveat MCP登録があること' : '必要状態=診断CLIに対応するhook定義があること'));
    assert.ok(message.includes('実利用の成否・原因・影響は未確認'));
    assert.deepEqual(input, original);
  }
});
test('未知理由と部品に対応しない理由でも、元fail/重大度/指紋を残して説明不足を明記する', () => {
  for (const [id, reason] of [['sync', 'new_public_reason'], ['database', 'not_installed'], ['sync', 'constructor']]) {
    const [check] = caveatChecks(diagnostic(id, reason), 'not_ready', NOW);
    assert.equal(check.status, 'fail'); assert.equal(check.severity, 'warn'); assert.equal(check.reason_code, reason);
    assert.ok(check.message_template.includes(`理由=${reason}（理由の具体的な意味は未確認）`));
    assert.ok(!check.message_template.includes('function Object'));
  }
});
test('部品へ特定できないoverall不足を通常failとして保持し、成功や原因へ読み替えない', () => {
  const [check] = caveatChecks({}, 'not_ready', NOW);
  assert.equal(check.status, 'fail'); assert.equal(check.severity, 'warn');
  assert.equal(check.reason_code, 'native_not_ready_unattributed');
  assert.ok(check.message_template.includes('製品全体の不足を部品へ特定できない'));
  assert.ok(check.message_template.includes('必要状態='));
});
