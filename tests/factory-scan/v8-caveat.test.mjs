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
    },
  };
}

test('現行v8はCursor必須のCaveat公開診断を読み、overallとexitの不一致を拒否する', async (t) => {
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
if [ "$#" -ne 4 ] || [ "$1" != factory-diagnostics ] || [ "$2" != --json ] || [ "$3" != --require-connector ] || [ "$4" != cursor ]; then
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
  assert.equal(ready.checks[0].status, 'pass');

  const cursorFailure = diagnostic();
  cursorFailure.overall.status = 'not_ready';
  cursorFailure.connectors.cursor.compatibility_status = 'not_ready';
  cursorFailure.connectors.cursor.hooks.stop = { status: 'not_ready', reason_code: 'missing' };
  const failed = await scan(cursorFailure, 1);
  assert.equal(failed.compatibility_status, 'incompatible');
  assert.equal(failed.checks[0].reason_code, 'native_not_ready');

  const mismatch = await scan(diagnostic(), 1);
  assert.equal(mismatch.presence_status, 'unverified');
  assert.equal(mismatch.checks[0].reason_code, 'native_exit_mismatch');
});
