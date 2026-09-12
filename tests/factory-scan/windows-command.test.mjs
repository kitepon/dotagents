import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { run } from '../../lib/factory/command.mjs';

const windowsOnly = { skip: process.platform !== 'win32' };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'factory-standard-windows-'));
  const bin = join(root, 'bin with space');
  await mkdir(bin);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(bin, 'inspect.mjs');
  await writeFile(executable, `let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input, cwd: process.cwd(), marker: process.env.FACTORY_TEST_MARKER }));
  process.exitCode = Number(process.env.FACTORY_TEST_EXIT ?? 0);
});
`);
  const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
  await writeFile(join(bin, 'factory-ps.ps1'), `& ${quote(process.execPath)} ${quote(executable)} @args\nexit $LASTEXITCODE\n`);
  await writeFile(join(bin, 'factory-cmd.cmd'), `@echo off\r\n"${process.execPath}" "${executable}" %*\r\n`);
  const laterBin = join(root, 'later-bin');
  await mkdir(laterBin);
  await writeFile(join(laterBin, 'factory-cmd.cmd'), '@echo off\r\nexit /b 99\r\n');
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'path'));
  env.PATH = `${bin}${delimiter}${laterBin}${delimiter}${process.env.PATH}`;
  env.FACTORY_TEST_MARKER = 'kept';
  return { root, bin, executable, env };
}

test('Windows標準起動は絶対exeと公開ps1で引数・stdin・cwd・envを保持する', windowsOnly, async (t) => {
  const box = await fixture(t);
  const args = ['a b', "single'quote", 'double"quote', '$env:PATH', '$(throw 1)', '; exit 99', '日本語', ''];
  for (const [command, prefix] of [[process.execPath, [box.executable]], ['factory-ps', []]]) {
    const result = await run(command, [...prefix, ...args], { cwd: box.root, env: box.env, input: 'stdin-kept', timeoutMs: 10000 });
    assert.equal(result.ok, true, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args, input: 'stdin-kept', cwd: await realpath(box.root), marker: 'kept',
    });
  }
});

test('Windows標準起動はcmdをOSへ渡し、非zero終了とcommand不在を失敗として返す', windowsOnly, async (t) => {
  const box = await fixture(t);
  const result = await run('factory-cmd', ['one', 'two words'], {
    env: { ...box.env, FACTORY_TEST_EXIT: '7' }, timeoutMs: 10000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 7);
  assert.deepEqual(JSON.parse(result.stdout).args, ['one', 'two words']);
  const missing = await run('dotagents-command-does-not-exist', [], { env: box.env, timeoutMs: 10000 });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'spawn');
  assert.equal(missing.error.code, 'ENOENT');
  assert.match(missing.stderr, /dotagents-command-does-not-exist/u);
  const exit127 = await run('factory-ps', [], {
    env: { ...box.env, FACTORY_TEST_EXIT: '127' }, timeoutMs: 10000,
  });
  assert.equal(exit127.reason, 'exit');
  assert.equal(exit127.code, 127);
});

test('Windows標準起動は引数をPowerShellコードとして評価しない', windowsOnly, async (t) => {
  const box = await fixture(t);
  const marker = join(box.root, 'must-not-exist');
  const arg = `'; Set-Content -LiteralPath '${marker}' -Value changed; #`;
  const result = await run('factory-ps', [arg], { env: box.env, timeoutMs: 10000 });
  assert.equal(result.ok, true, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).args, [arg]);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
