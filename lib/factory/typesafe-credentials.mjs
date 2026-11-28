import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { run } from './command.mjs';
import { resolveSecret } from './op-secret.mjs';

export const typeSafeKeyPath = (home = homedir()) => join(home, '.config', 'dotagents', 'credentials', 'typesafe', 'api.env');

function parseKey(text) {
  const key = parseEnv(text).TYPESAFE_API_KEY;
  if (!key?.trim() || /[\r\n]/u.test(key)) throw new Error('TYPESAFE_CREDENTIAL_INVALID');
  return key;
}

// 値が`op://`参照の時だけ共通readerで1Passwordから読む（任意）。
const resolveKey = (value, context) => resolveSecret(value, context).catch((error) => {
  throw new Error(`TYPESAFE_${error.message}`);
});

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

  // 鍵が端末に無い時は、認証仲介の品目が鍵を使う（呼び手は`TYPESAFE_CREDENTIAL_ABSENT`で経路を替える）。鍵を端末へ写す経路は持たない。
  throw new Error('TYPESAFE_CREDENTIAL_ABSENT');
}
