import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { parseEnv } from 'node:util';
import { run } from './command.mjs';
import { windowsOwnerOnlyAclScript } from './windows-scheduler.mjs';

export const typeSafeKeyPath = (home = homedir()) => join(home, '.config', 'dotagents', 'credentials', 'typesafe', 'api.env');
// Windows標準のssh.exeは非対話sessionで出力を受け取ると終了しないため、Git for Windows同梱のOpenSSHを使う。
const sshCommand = (platform, env) => (platform === 'win32'
  ? win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'ssh.exe') : 'ssh');
// cronは~/.bashrc.dを読まないため、main-serverの暗号化済みService Accountがあればopの子の環境だけへ渡す。
export const serverServiceAccountPath = (home = homedir()) => join(home, '.config', 'dotagents', 'credentials', '1password', 'main-server.cred');

function parseKey(text) {
  const key = parseEnv(text).TYPESAFE_API_KEY;
  if (!key?.trim() || /[\r\n]/u.test(key)) throw new Error('TYPESAFE_CREDENTIAL_INVALID');
  return key;
}

// 1Passwordは任意の配置。env／api.envの値が`op://`参照の時だけopで読み、平文の値はそのまま使う。
async function resolveKey(value, { home, env, execute, platform }) {
  const key = value.trim();
  if (!key.startsWith('op://')) return key;
  const opEnv = { ...env };
  const serviceAccount = serverServiceAccountPath(home);
  if (!opEnv.OP_SERVICE_ACCOUNT_TOKEN && platform === 'linux' && existsSync(serviceAccount)) {
    const decrypted = await execute('systemd-creds', ['--user', '--refuse-null', '--name=op-service-account-token',
      'decrypt', serviceAccount, '-'], { input: '', timeoutMs: 15000, maxOutputBytes: 8192 });
    if (!decrypted.ok) throw new Error('TYPESAFE_SERVICE_ACCOUNT_DECRYPT_FAILED');
    opEnv.OP_SERVICE_ACCOUNT_TOKEN = decrypted.stdout.trim();
  }
  // stdoutには秘密が含まれるため出力しない。
  const read = await execute('op', ['read', '--no-newline', key], { env: opEnv, input: '', timeoutMs: 30000, maxOutputBytes: 16384 });
  if (!read.ok) throw new Error('TYPESAFE_OP_READ_FAILED: 1Passwordの参照を読めません（未導入・未認証・ロック中・保管庫の権限なし）');
  const resolved = read.stdout.trim();
  if (!resolved || /\s/u.test(resolved)) throw new Error('TYPESAFE_CREDENTIAL_INVALID');
  return resolved;
}

export async function loadTypeSafeKey({ home = homedir(), env = process.env, execute = run, platform = process.platform } = {}) {
  const context = { home, env, execute, platform };
  if (env.TYPESAFE_API_KEY?.trim()) return resolveKey(env.TYPESAFE_API_KEY, context);
  const file = typeSafeKeyPath(home);
  let stored;
  try { stored = parseKey(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('TYPESAFE_CREDENTIAL_READ_FAILED');
  }
  if (stored) return resolveKey(stored, context);

  // 工場の配布元からSSHで受け取る。stdoutには秘密が含まれるため出力しない。
  const transferred = await execute(sshCommand(platform, env), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
    env.MAIN_SERVER_SSH_TARGET ?? 'kite@192.168.1.2',
    'cat .config/dotagents/credentials/typesafe/api.env'], {
    input: '', timeoutMs: 15000, maxOutputBytes: 16384,
  });
  if (!transferred.ok) throw new Error('TYPESAFE_CREDENTIAL_TRANSFER_FAILED');
  const key = parseKey(transferred.stdout);
  const directory = dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform === 'win32') {
    const secured = await execute('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', windowsOwnerOnlyAclScript()], {
      env: { ...env, DOTAGENTS_FACTORY_ACL_TARGET: directory }, timeoutMs: 15000,
    });
    if (!secured.ok) throw new Error('TYPESAFE_CREDENTIAL_ACL_FAILED');
  } else {
    await chmod(directory, 0o700);
  }
  // 親directoryを保護してから保存する。既存のキーを上書きしない。
  await writeFile(file, transferred.stdout, { mode: 0o600, flag: 'wx' });
  return resolveKey(key, context);
}
