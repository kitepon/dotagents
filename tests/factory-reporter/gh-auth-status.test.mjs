import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { githubAuthStatus } from '../../bin/factory-gh-auth-status.mjs';

const ROOT = resolve(import.meta.dirname, '../..');

test('状態照会は対応版のrefreshを抑止し、旧版と認証失敗を区別する', () => {
  for (const modern of [true, false]) {
    for (const status of [0, 1]) {
      const calls = [];
      let credentialWrites = 0;
      const code = githubAuthStatus(['--hostname', 'github.com'], (file, args) => {
        assert.equal(file, 'gh');
        calls.push(args);
        if (args.includes('--help')) return { status: 0, stdout: modern ? '  --no-refresh  Disable refresh\n' : '  --hostname string\n' };
        if (modern && !args.includes('--no-refresh')) credentialWrites++;
        return { status };
      });
      assert.equal(code, status);
      assert.equal(credentialWrites, 0);
      assert.equal(calls.length, 2);
      assert.deepEqual(calls[0], ['auth', 'status', '--help']);
      assert.deepEqual(calls[1], ['auth', 'status', ...(modern ? ['--no-refresh'] : []), '--hostname', 'github.com']);
    }
  }
});

test('help取得失敗や起動不能は通常statusへfallbackせず確認不能で終了する', () => {
  for (const failure of [{ status: 1, stdout: '' }, { error: new Error('ENOENT'), status: null }]) {
    let calls = 0;
    assert.equal(githubAuthStatus([], () => { calls++; return failure; }), 2);
    assert.equal(calls, 1);
  }
  let calls = 0;
  assert.equal(githubAuthStatus([], () => ++calls === 1
    ? { status: 0, stdout: '--no-refresh\n' }
    : { status: null, signal: 'SIGTERM' }), 2);
});

test('Linuxの手動認証は確認不能なら書かず、loginとsetup-gitの前に作用を表示する', () => {
  const source = readFileSync(resolve(ROOT, 'bin/setup-linux-common.sh'), 'utf8');
  const body = source.slice(source.indexOf('ensure_github_auth() {'), source.indexOf('ensure_main_server_ssh() {'));
  for (const status of [0, 3, 2, 1, 127]) {
    const result = spawnSync('bash', ['-c', `
ROOT=unused
auth_result=${status}
die() { echo "$*"; exit 1; }
node() { local result="$auth_result"; auth_result=0; return "$result"; }
gh() { echo "CALL gh $*"; }
${body}
ensure_github_auth
`], { encoding: 'utf8' });
    if (![0, 3].includes(status)) {
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /CALL gh/u);
    } else {
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /INFO: 手動setup.*setup-git.*\nCALL gh auth setup-git/u);
      if (status === 3) assert.match(result.stdout, /INFO: 手動setup.*login.*\nCALL gh auth login/u);
      else assert.doesNotMatch(result.stdout, /CALL gh auth login/u);
    }
  }
  const scheduled = source.slice(source.lastIndexOf('case "${1:-}" in'));
  assert.doesNotMatch(scheduled.slice(scheduled.indexOf('--scheduled-update)')), /ensure_github_auth/u);
});
