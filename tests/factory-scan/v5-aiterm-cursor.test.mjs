import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { scanV5 } from '../../lib/factory/v5.mjs';
import { writeCommandFixture } from './command-fixture.mjs';

function aitermBase() {
  return {
    diagnostic_schema: 'aiterm-mcp.factory-diagnostics.v1',
    version: '0.28.3',
    overall: 'ready',
    mcp: { transport: 'stdio', initialize: 'ready', tool_call: 'ready' },
    pty_list: { access: 'read_only', status: 'ready', session_count: 0 },
    runtime_error_store: {
      status: 'not_applicable', collection: 'disabled', record_count: 0, unacknowledged_count: 0,
    },
    vendor_dependencies: {
      claude: { status: 'ready', optional: true, required_for: ['claude_agent'] },
      codex: { status: 'ready', optional: true, required_for: ['codex_agent'] },
      grok: { status: 'ready', optional: true, required_for: ['grok_agent', 'composer_agent'] },
    },
  };
}

test('v5 aiterm scannerは cursor vendor_dependencies を受理し、未知vendorは拒否する', { concurrency: false }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-v5-aiterm-cursor-'));
  const bin = join(root, 'bin');
  await mkdir(bin);
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = (name, body) => writeCommandFixture(bin, name, body);
  for (const name of [
    'caveat', 'throughline', 'spotter', 'codex-sidecar', 'gpt-connector', 'lattice',
    'markitdown', 'claude', 'codex', 'npm', 'grok', 'aishell-mcp',
  ]) await script(name, 'exit 1');
  const setAiterm = async (payload) => script('aiterm-mcp', `cat >/dev/null; echo '${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: JSON.stringify(payload) }] } })}'`);
  const scan = () => scanV5({
    host: { id: 'test-host', profile: 'wsl' },
    cwd: root,
    arch: 'x64',
    platform: process.platform === 'win32' ? 'win32' : process.platform,
  });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${delimiter}${previous}`;
  t.after(() => { process.env.PATH = previous; });

  const three = aitermBase();
  await setAiterm(three);
  let report = await scan();
  assert.equal(report.products['aiterm-mcp'].presence_status, 'installed');
  assert.equal(report.products['aiterm-mcp'].compatibility_status, 'compatible');

  const four = structuredClone(three);
  four.vendor_dependencies.cursor = { status: 'not_applicable', optional: true, required_for: ['agent_launch'] };
  await setAiterm(four);
  report = await scan();
  assert.equal(report.products['aiterm-mcp'].presence_status, 'installed');
  assert.equal(report.products['aiterm-mcp'].compatibility_status, 'compatible');
  assert.equal(report.products['aiterm-mcp'].installed_version, '0.28.3');

  const unknown = structuredClone(four);
  unknown.vendor_dependencies.unknown = { status: 'not_applicable', optional: true, required_for: [] };
  await setAiterm(unknown);
  report = await scan();
  assert.equal(report.products['aiterm-mcp'].presence_status, 'unverified');
  assert.equal(report.products['aiterm-mcp'].checks[0].reason_code, 'native_diagnostics_schema');
});
