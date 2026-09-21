import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseEnv } from 'node:util';
import { run } from './command.mjs';
import { windowsOwnerOnlyAclScript } from './windows-scheduler.mjs';

export const typeSafeKeyPath = (home = homedir()) => join(home, '.config', 'dotagents', 'credentials', 'typesafe', 'api.env');

function parseKey(text) {
  const key = parseEnv(text).TYPESAFE_API_KEY;
  if (!key?.trim() || /[\r\n]/u.test(key)) throw new Error('TYPESAFE_CREDENTIAL_INVALID');
  return key;
}

export async function loadTypeSafeKey({ home = homedir(), env = process.env, execute = run, platform = process.platform } = {}) {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY;
  const file = typeSafeKeyPath(home);
  try { return parseKey(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('TYPESAFE_CREDENTIAL_READ_FAILED');
  }

  // 工場の配布元からSSHで受け取る。stdoutには秘密が含まれるため出力しない。
  const transferred = await execute('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
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
  return key;
}
