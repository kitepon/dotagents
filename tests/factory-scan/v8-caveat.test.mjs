import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { scanV8 } from '../../lib/factory/v8.mjs';
import { writeCommandFixture } from './command-fixture.mjs';

function diagnostic() {
  const ready = () => ({ status: 'ready', reason_code: 'ready' });
  const hooks = (names) => Object.fromEntries(names.map((name) => [name, ready()]));
  return {
    schema: 'caveat.native_factory_diagnostics.v1', product: 'caveat', version: '0.19.1',
    overall: { status: 'ready' },
    database: { ...ready(), schema_version: 3, supported_schema_version: 3, migration_status: 'current' },
    sync: ready(),
    connectors: {
      claude: { status: 'ready', mcp: ready(), hooks: hooks(['user_prompt_submit', 'post_tool_use', 'post_tool_use_failure', 'stop']) },
      codex: { status: 'ready', hooks: hooks(['user_prompt_submit', 'post_tool_use', 'stop']) },
      cursor: { compatibility_status: 'ready', hooks: hooks(['before_submit_prompt', 'post_tool_use', 'post_tool_use_failure', 'stop']) },
      grok: { status: 'ready', mcp: ready() },
    },
  };
}

test('現行v8はCursorとGrokを必須にしたCaveat公開診断を読み、overallとexitの不一致を拒否する', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v8-caveat-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const command of [
    'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'lattice',
    'markitdown', 'claude', 'codex', 'npm', 'grok', 'aishell-mcp',
    'aiterm-mcp', 'peertable', 'peertable-client', 'unai',
  ]) await writeCommandFixture(bin, command, 'exit 1');
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });
  const scan = async (value, exitCode) => {
    await writeCommandFixture(bin, 'caveat', `
if [ "$#" -ne 6 ] || [ "$1" != factory-diagnostics ] || [ "$2" != --json ] || [ "$3" != --require-connector ] || [ "$4" != cursor ] || [ "$5" != --require-connector ] || [ "$6" != grok ]; then
  exit 64
fi
echo '${JSON.stringify(value)}'
exit ${exitCode}
`);
    const report = await scanV8({
      host: { id: 'test-host', profile: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows-native' : 'server' },
      cwd: root, arch: process.arch, platform: process.platform,
    });
    return report.products.caveat;
  };
  const ready = await scan(diagnostic(), 0);
  assert.equal(ready.compatibility_status, 'compatible');
  assert.equal(ready.installed_version, '0.19.1');
  assert.deepEqual(ready.checks[0], { check_id: 'native_diagnostics', status: 'pass' });
  assert.equal(ready.checks.length, 16);
  assert.ok(ready.checks.every((item) => item.status === 'pass'));
  assert.deepEqual(ready.checks.at(-1), { check_id: 'grok_mcp', status: 'pass' });
  assert.deepEqual([ready.runtime_errors, ready.resolutions], [[], []]);

  const cursorFailure = diagnostic();
  cursorFailure.overall.status = 'not_ready';
  cursorFailure.connectors.cursor.compatibility_status = 'not_ready';
  cursorFailure.connectors.cursor.hooks.stop = { status: 'not_ready', reason_code: 'missing' };
  const failed = await scan(cursorFailure, 1);
  assert.equal(failed.compatibility_status, 'incompatible');
  // 不足は部品のcheckが製品の理由のままwarnで運ぶ。旧check（native_diagnostics）は出さない。
  const failures = failed.checks.filter((item) => item.status === 'fail');
  assert.deepEqual(failures.map((item) => [item.check_id, item.reason_code, item.severity]), [['cursor_hook_stop', 'missing', 'warn']]);
  assert.ok(!failed.checks.some((item) => item.check_id === 'native_diagnostics'));
  assert.deepEqual([failed.runtime_errors, failed.resolutions], [[], []]);

  // Grokだけが不足の回も、製品のoverallに従う。旧checkのpassを出さない（旧issueを閉じない）。
  const grokFailure = diagnostic();
  grokFailure.overall.status = 'not_ready';
  grokFailure.connectors.grok = { status: 'not_ready', mcp: { status: 'not_ready', reason_code: 'disabled' } };
  const grokFailed = await scan(grokFailure, 1);
  assert.equal(grokFailed.compatibility_status, 'incompatible');
  assert.deepEqual(grokFailed.checks.filter((item) => item.status !== 'pass').map((item) => [item.check_id, item.status, item.reason_code, item.severity]),
    [['grok_mcp', 'fail', 'disabled', 'warn']]);

  // Grokだけが未確認の回は、未確認のまま運ぶ。
  const grokUnverified = diagnostic();
  grokUnverified.overall.status = 'unverified';
  grokUnverified.connectors.grok = { status: 'unverified', mcp: { status: 'unverified', reason_code: 'config_unreadable' } };
  const unverified = await scan(grokUnverified, 1);
  assert.equal(unverified.compatibility_status, 'unverified');
  assert.deepEqual(unverified.checks.filter((item) => item.status !== 'pass'), [{ check_id: 'grok_mcp', status: 'unverified', reason_code: 'config_unreadable' }]);

  const mismatch = await scan(diagnostic(), 1);
  assert.equal(mismatch.presence_status, 'unverified');
  assert.equal(mismatch.checks[0].reason_code, 'native_exit_mismatch');
});
