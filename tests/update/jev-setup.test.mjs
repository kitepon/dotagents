import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupJevProduct } from '../../lib/factory/jev-setup.mjs';
import { officialForkRelease } from '../../lib/factory/jev-fork-release.mjs';
import { jevProduct } from '../../lib/factory/v9.mjs';

const quiet = { write() {} };
const ok = { ok: true, stdout: '' };
async function homeFor(t) { const home = await mkdtemp(join(tmpdir(), 'jev-setup-')); t.after(() => rm(home, { recursive: true, force: true })); return home; }

test('ブラウザは公式cloneとlock付きuv導入だけを行い、GUIを起動しない', async (t) => {
  const home = await homeFor(t); const calls = [];
  const result = await setupJevProduct('jev-ultrafast', { home, platform: 'win32', output: quiet,
    execute: async (cmd, args, options) => { calls.push({ cmd, args, options }); return ok; } });
  assert.equal(result.state, 'installed');
  assert.deepEqual(calls[0].args, ['clone', 'https://github.com/browser-use/jev-ultrafast.git', join(home, 'Developer', 'jev-ultrafast')]);
  assert.deepEqual(calls[1].args, ['sync', '--locked']);
  assert.deepEqual(calls.map(({ cmd }) => cmd), ['git', 'uv', 'git']);
  assert.equal(calls.some(({ args }) => args.includes('--goal') || args.includes('jev')), false);
});

test('既存checkoutは公式originとdirtyを確認し、ff-onlyで最新版を取得する', async (t) => {
  const home = await homeFor(t); await mkdir(join(home, 'Developer', 'jev-ultrafast'), { recursive: true });
  const calls = [];
  const execute = async (cmd, args) => { calls.push(args); return { ...ok, stdout: args[0] === 'remote' ? 'https://github.com/browser-use/jev-ultrafast.git' : '' }; };
  await setupJevProduct('jev-ultrafast', { home, execute, output: quiet });
  assert.deepEqual(calls[2], ['pull', '--ff-only', 'origin', 'main']);
  assert.equal(calls.some((args) => args.includes('reset') || args.includes('checkout')), false);
  await assert.rejects(setupJevProduct('jev-ultrafast', { home, output: quiet, execute: async (cmd, args) => ({ ...ok, stdout: args[0] === 'remote' ? 'https://github.com/browser-use/jev-ultrafast.git' : ' M changed.py' }) }), /CHECKOUT_DIRTY/);
});

test('デスクトップはMacだけ、npm latestと上流Skillを導入する', async (t) => {
  const home = await homeFor(t); const calls = [];
  const execute = async (cmd, args) => { calls.push([cmd, args]); return ok; };
  for (const platform of ['win32', 'linux']) {
    assert.equal((await setupJevProduct('agent-desktop', { home, platform, execute, output: quiet })).state, 'unsupported');
  }
  assert.equal(calls.length, 0);
  await setupJevProduct('agent-desktop', { home, platform: 'darwin', execute, output: quiet });
  assert.ok(calls.some(([cmd, args]) => cmd === 'npm' && args.includes('agent-desktop@latest')));
  assert.ok(calls.some(([cmd, args]) => cmd === 'npx' && args.includes('jev-desktop')));
  assert.equal(JSON.stringify(calls).includes('0.4.7'), false);
});

test('端末別fork指定は公式npm版を外して固定revisionをCargo導入する', async (t) => {
  const home = await homeFor(t); const calls = [];
  const config = join(home, '.config', 'dotagents', 'agent-desktop-fork.json');
  const repository = 'https://github.com/quolu/agent-desktop.git';
  const revision = 'c'.repeat(40);
  await mkdir(join(home, '.config', 'dotagents'), { recursive: true });
  await writeFile(config, JSON.stringify({ repository, revision }));
  const result = await setupJevProduct('agent-desktop', { home, platform: 'darwin', output: quiet,
    releaseCheck: async () => null,
    execute: async (cmd, args) => { calls.push([cmd, args]); return ok; } });
  assert.equal(result.revision, revision);
  assert.ok(calls.some(([cmd, args]) => cmd === 'npm' && args.join(' ') === 'uninstall --global agent-desktop'));
  assert.ok(calls.some(([cmd, args]) => cmd === 'cargo' && args.includes(repository) && args.includes(revision) && args.includes(join(home, '.local'))));
  assert.equal(calls.some(([cmd, args]) => cmd === 'npm' && args.includes('agent-desktop@latest')), false);
  await writeFile(config, JSON.stringify({ repository, revision: 'bad' }));
  await assert.rejects(setupJevProduct('agent-desktop', { home, platform: 'darwin', output: quiet,
    releaseCheck: async () => null,
    execute: () => assert.fail('不正な指定でコマンドを実行しない') }), /JEV_FORK_CONFIG_INVALID/);
  await writeFile(config, 'null');
  await assert.rejects(setupJevProduct('agent-desktop', { home, platform: 'darwin', output: quiet,
    releaseCheck: async () => null,
    execute: () => assert.fail('不正な指定でコマンドを実行しない') }), /JEV_FORK_CONFIG_INVALID/);
});

test('Browser Harnessのforkを固定導入し、公式release確認後に公式版へ移す', async (t) => {
  const home = await homeFor(t); const calls = [];
  const config = join(home, '.config', 'dotagents', 'browser-harness-fork.json');
  const repository = 'https://github.com/quolu/browser-harness.git';
  const revision = 'e'.repeat(40);
  await mkdir(join(home, '.config', 'dotagents'), { recursive: true });
  await writeFile(config, JSON.stringify({ repository, revision }));
  const execute = async (cmd, args) => { calls.push([cmd, args]); return { ...ok, stdout: cmd === 'browser-harness' ? '0.1.14\n' : '' }; };
  await setupJevProduct('browser-harness', { home, output: quiet, execute, releaseCheck: async () => null });
  assert.ok(calls.some(([cmd, args]) => cmd === 'uv' && args.includes(`git+${repository}@${revision}`)));
  assert.ok((await readFile(config, 'utf8')).includes(revision));
  calls.length = 0;
  await setupJevProduct('browser-harness', { home, output: quiet, execute,
    releaseCheck: async () => ({ version: '0.1.14', tag: 'v0.1.14' }) });
  assert.ok(calls.some(([cmd, args]) => cmd === 'uv' && args.includes('browser-harness')));
  await assert.rejects(stat(config), { code: 'ENOENT' });
});

test('Fork卒業はPR、公式release、registry配布、releaseへの包含をすべて要求する', async () => {
  const responses = {
    'repos/lahfir/agent-desktop/pulls/231': { merged_at: null, merge_commit_sha: 'a'.repeat(40) },
    'repos/lahfir/agent-desktop/releases/latest': { tag_name: 'v0.9.5' },
    [`repos/lahfir/agent-desktop/compare/${'a'.repeat(40)}...v0.9.5`]: { status: 'ahead' },
  };
  const execute = async (cmd, args) => ({ ...ok, stdout: cmd === 'gh' ? JSON.stringify(responses[args[1]]) : '"0.9.5"' });
  assert.equal(await officialForkRelease('agent-desktop', { execute }), null);
  responses['repos/lahfir/agent-desktop/pulls/231'].merged_at = '2026-09-26T00:00:00Z';
  assert.deepEqual(await officialForkRelease('agent-desktop', { execute }), { version: '0.9.5', tag: 'v0.9.5' });
  const npm12 = async (cmd, args) => ({ ...ok, stdout: cmd === 'gh' ? JSON.stringify(responses[args[1]]) : '["0.9.5"]' });
  assert.deepEqual(await officialForkRelease('agent-desktop', { execute: npm12 }), { version: '0.9.5', tag: 'v0.9.5' });
  responses[`repos/lahfir/agent-desktop/compare/${'a'.repeat(40)}...v0.9.5`].status = 'diverged';
  assert.equal(await officialForkRelease('agent-desktop', { execute }), null);
});

test('Browser Harnessは許可シート修正PRが先に通るまで卒業しない', async () => {
  const sha = 'b'.repeat(40);
  const responses = {
    'repos/browser-use/browser-harness/pulls/747': { merged_at: '2026-10-02T00:00:00Z', merge_commit_sha: sha },
    'repos/ironerumi/browser-harness/pulls/1': { merged_at: null },
    'repos/browser-use/browser-harness/releases/latest': { tag_name: 'v0.1.14' },
    [`repos/browser-use/browser-harness/compare/${sha}...v0.1.14`]: { status: 'ahead' },
  };
  const execute = async (_, args) => ({ ...ok, stdout: JSON.stringify(responses[args[1]]) });
  const fetchJson = async () => ({ info: { version: '0.1.14' } });
  assert.equal(await officialForkRelease('browser-harness', { execute, fetchJson }), null);
  responses['repos/ironerumi/browser-harness/pulls/1'].merged_at = '2026-10-01T00:00:00Z';
  assert.deepEqual(await officialForkRelease('browser-harness', { execute, fetchJson }), { version: '0.1.14', tag: 'v0.1.14' });
});

test('agent-desktopの公式導入と旧Cargo版除去が済んでからfork指定を削除する', async (t) => {
  const home = await homeFor(t); const calls = [];
  const config = join(home, '.config', 'dotagents', 'agent-desktop-fork.json');
  await mkdir(join(home, '.config', 'dotagents'), { recursive: true });
  await writeFile(config, JSON.stringify({ repository: 'https://github.com/quolu/agent-desktop.git', revision: 'a'.repeat(40) }));
  const execute = async (cmd, args) => { calls.push([cmd, args]); return { ...ok,
    stdout: cmd === 'git' && args[0] === 'rev-parse' ? 'a'.repeat(40) : cmd === 'agent-desktop' ? 'agent-desktop 0.9.5' : '' }; };
  await setupJevProduct('agent-desktop', { home, platform: 'darwin', output: quiet, execute,
    releaseCheck: async () => ({ version: '0.9.5', tag: 'v0.9.5' }) });
  assert.ok(calls.some(([cmd, args]) => cmd === 'cargo' && args[0] === 'uninstall'));
  await assert.rejects(stat(config), { code: 'ENOENT' });
});

test('導入失敗を停止として返し、別版や別経路へ切り替えない', async (t) => {
  const home = await homeFor(t); const calls = [];
  await assert.rejects(setupJevProduct('agent-desktop', { home, platform: 'darwin', output: quiet,
    execute: async (cmd, args) => { calls.push([cmd, args]); return cmd === 'npm' ? { ok: false, code: 1, stdout: '秘密', stderr: '秘密' } : ok; } }), (error) => /JEV_INSTALL_FAILED/.test(error.message) && !error.message.includes('秘密'));
  assert.deepEqual(calls.map(([cmd]) => cmd), ['git', 'npm']);
});

test('公開probeはOS未対応と導入済みを区別し、GUIの成功を推測しない', async () => {
  assert.equal((await jevProduct('agent-desktop', { platform: 'win32', runCommand: () => assert.fail('呼出し禁止') })).compatibility_status, 'unsupported');
  const result = await jevProduct('agent-desktop', { platform: 'darwin', runCommand: async (cmd) => ({ ok: true, stdout: cmd === 'git' ? 'a'.repeat(40) : 'agent-desktop 0.9.2\n' }) });
  assert.equal(result.installed_version, '0.9.2');
  assert.equal(result.compatibility_status, 'unverified');
  assert.equal(result.source_revision, undefined);
  assert.deepEqual(result.checks[1], { check_id: 'gui_runtime', status: 'skipped', reason_code: 'on_demand_only' });
  const browser = await jevProduct('jev-ultrafast', { runCommand: async (cmd) => ({ ok: true,
    stdout: cmd === 'uv' ? '0.1.0' : cmd === 'git' ? 'a'.repeat(40) : '0.1.13' }) });
  assert.deepEqual(browser.checks[1], { check_id: 'browser_harness_cli', status: 'pass' });
});
