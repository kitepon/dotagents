import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { run } from './command.mjs';
import { extendedSchedulerPath } from './scheduler-path.mjs';

// 無人実行の1Password。1Passwordは任意で、値が`op://`参照の時だけ使う。平文の値はそのまま返す。
// 端末ごとの読取専用Service Account（その端末専用の保管庫だけ）のtokenは、各OSの暗号化storeから読む。
export const UNATTENDED_KEYCHAIN_SERVICE = 'dotagents-1password-unattended';
export const UNATTENDED_CREDENTIAL_NAME = 'op-service-account-token';
export const unattendedTokenPath = (platform = process.platform, { home = homedir(), env = process.env } = {}) => (platform === 'win32'
  ? join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'dotagents', 'credentials', '1password', 'unattended.dpapi')
  : join(home, '.config', 'dotagents', 'credentials', '1password', 'unattended.cred'));

// Windowsは保存時と同じCurrentUserのDPAPIで戻す。値はstdoutだけに出し、引数へ載せない。
const DPAPI_READ = '$ErrorActionPreference = "Stop"; Get-Content -Raw -LiteralPath $env:DOTAGENTS_UNATTENDED_TOKEN_FILE'
  + ' | ConvertTo-SecureString | ConvertFrom-SecureString -AsPlainText';

// 保存されていなければundefined（opの本人認証へ任せる）。保存済みで読めなければ名前付きで止まる。
export async function unattendedToken({ platform = process.platform, home = homedir(), env = process.env, execute = run } = {}) {
  const options = { input: '', timeoutMs: 15000, maxOutputBytes: 8192 };
  let result;
  if (platform === 'darwin') {
    result = await execute('security', ['find-generic-password', '-s', UNATTENDED_KEYCHAIN_SERVICE,
      '-a', env.USER ?? userInfo().username, '-w'], options);
    if (!result.ok && result.code === 44) return undefined; // errSecItemNotFound
  } else {
    const file = unattendedTokenPath(platform, { home, env });
    if (!existsSync(file)) return undefined;
    result = platform === 'win32'
      ? await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_READ],
        { ...options, env: { ...env, DOTAGENTS_UNATTENDED_TOKEN_FILE: file } })
      : await execute('systemd-creds', ['--user', '--refuse-null', `--name=${UNATTENDED_CREDENTIAL_NAME}`, 'decrypt', file, '-'], options);
  }
  const token = result.ok ? result.stdout.trim() : '';
  if (!token) throw new Error('OP_UNATTENDED_TOKEN_UNREADABLE: 保存済みService Account tokenを復号できません');
  return token;
}

export async function resolveSecret(value, { platform = process.platform, home = homedir(), env = process.env, execute = run } = {}) {
  const text = value.trim();
  if (!text.startsWith('op://')) return text;
  // launchd/cronの最小PATHでもHomebrew等の公式opを見つける（scheduler runnerと同じ補完）。
  const opEnv = platform === 'win32' ? { ...env }
    : { ...env, PATH: extendedSchedulerPath({ platform, path: env.PATH, execPath: process.execPath, home }) };
  if (!opEnv.OP_SERVICE_ACCOUNT_TOKEN) {
    const token = await unattendedToken({ platform, home, env, execute });
    if (token) opEnv.OP_SERVICE_ACCOUNT_TOKEN = token;
  }
  // stdoutには秘密が含まれるため出力しない。
  const read = await execute('op', ['read', '--no-newline', text], { env: opEnv, input: '', timeoutMs: 30000, maxOutputBytes: 65536 });
  if (!read.ok) throw new Error('OP_READ_FAILED: 1Passwordの参照を読めません（未導入・未認証・ロック中・保管庫の権限なし・到達不能）');
  const secret = read.stdout.trim();
  if (!secret) throw new Error('OP_READ_EMPTY: 1Passwordの参照が空です');
  return secret;
}
