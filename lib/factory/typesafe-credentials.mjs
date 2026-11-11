import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { run } from './command.mjs';

// 工場キーの正本は1Passwordだけに置く（2026-11-11 FOX事案後のOwner指示）。端末へキーのfileを作らない。
// 保管庫・項目はIDで指し、題名の変更で参照が切れないようにする。
export const TYPESAFE_OP_REFERENCE = 'op://ablyc4nqivsby66iw463zofefu/yigy5ieikyoqvqdim4zp234gj4/credential';
// cronは~/.bashrc.dを読まないため、main-serverの暗号化済みService Accountをopの子の環境だけへ渡す。
// shortcut: main-serverの既存SAだけを使う。端末ごとの読取専用SA（サクラ裁定D1）ができたらそのpathへ替える。
export const serverServiceAccountPath = (home = homedir()) => join(home, '.config', 'dotagents', 'credentials', '1password', 'main-server.cred');

function parseKey(text) {
  const key = text.trim();
  if (!key || /\s/u.test(key)) throw new Error('TYPESAFE_CREDENTIAL_INVALID');
  return key;
}

export async function loadTypeSafeKey({ home = homedir(), env = process.env, execute = run, platform = process.platform } = {}) {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
  const opEnv = { ...env };
  const serviceAccount = serverServiceAccountPath(home);
  if (!opEnv.OP_SERVICE_ACCOUNT_TOKEN && platform === 'linux' && existsSync(serviceAccount)) {
    const decrypted = await execute('systemd-creds', ['--user', '--refuse-null', '--name=op-service-account-token',
      'decrypt', serviceAccount, '-'], { input: '', timeoutMs: 15000, maxOutputBytes: 8192 });
    if (!decrypted.ok) throw new Error('TYPESAFE_SERVICE_ACCOUNT_DECRYPT_FAILED');
    opEnv.OP_SERVICE_ACCOUNT_TOKEN = decrypted.stdout.trim();
  }
  // stdoutには秘密が含まれるため出力しない。
  const read = await execute('op', ['read', '--no-newline', TYPESAFE_OP_REFERENCE], {
    env: opEnv, input: '', timeoutMs: 30000, maxOutputBytes: 16384,
  });
  if (!read.ok) throw new Error('TYPESAFE_OP_READ_FAILED: 1Passwordから読めません（未認証・ロック中・保管庫の権限なし）');
  return parseKey(read.stdout);
}
