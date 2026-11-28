import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './command.mjs';

// 認証仲介の品目名。鍵は認証仲介の中だけにあり、この製品は結果だけを受け取る。
// BugHubのcredentialはhostに結ばれている（別hostのtokenは403 host_binding_mismatch）ため、品目はhostごと。
export const bughubItem = (hostId) => `bughub-reporter-${hostId}`;
export const TYPESAFE_ITEM = 'typesafe';

// Windowsは標準のOpenSSH。fox-module-agentのような名前付きpipeのagentはGit for Windows同梱のsshが使えない。
// 出力pipeはrunが非同期I/Oで渡すので、非対話でも終了する（fox 2026-11-28で確認）。
export const sshCommand = (platform, env) => (platform === 'win32'
  ? win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh');

export const authRoutePath = (home = homedir()) => join(home, '.config', 'dotagents', 'auth-route');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const LOCAL_BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin');
const REMOTE_RELAY = (env) => env.DOTAGENTS_MAIN_SERVER_RELAY ?? '/home/kite/Developer/dotagents/bin/factory-relay-http.sh';

// 経路: fileが`local`ならこの端末の中継scriptを直接走らせる（main-server）。それ以外はmain-serverへssh（rabbit・mac-kite・fox）。
async function routeOf(home) {
  try { return (await readFile(authRoutePath(home), 'utf8')).trim() === 'local' ? 'local' : 'ssh'; }
  catch (error) { if (error.code === 'ENOENT') return 'ssh'; throw error; }
}

// 中継scriptを走らせる。main-serverは直接、他の端末はmain-serverへssh（本文は標準入力）。
async function runRelay(script, words, input, { execute, home, env, platform, timeoutMs }) {
  const route = await routeOf(home);
  const [command, args] = route === 'local'
    ? ['sh', [join(LOCAL_BIN, script), ...words]]
    : [sshCommand(platform, env), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', env.MAIN_SERVER_SSH_TARGET ?? 'kite@192.168.1.2',
      ['sh', REMOTE_RELAY(env).replace(/factory-relay-http\.sh$/u, script), ...words].map(quote).join(' ')]];
  return execute(command, args, { input, timeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
}

function statusOf(result) {
  const found = /HTTP (\d{3})/u.exec(result.stderr ?? '');
  if (found) return Number(found[1]);
  return result.ok ? 200 : null;
}

// fetchと同じ形で呼べる要求関数。認証仲介が品目の鍵で要求を出し、応答だけを返す。
// shortcut: 応答statusは`auth http`のstderr「HTTP nnn」から読む。成功時に出ない版では200とみなす、モジュールが毎回出す版になれば消す。
export function moduleRequest(item, { execute = run, home = homedir(), env = process.env, platform = process.platform, timeoutMs = 60_000 } = {}) {
  return async (url, init = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { pathname, search } = new URL(url);
    const sentAt = init.headers?.['x-factory-sent-at'];
    const words = [item, (init.method ?? 'POST').toUpperCase(), pathname + search, ...(sentAt ? [sentAt] : [])];
    const result = await runRelay('factory-relay-http.sh', words, init.body ?? '', { execute, home, env, platform, timeoutMs });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const status = statusOf(result);
    if (status === null) {
      // 拒否・module停止・ssh不達。秘密は出ないので理由の先頭行だけ残し、呼び手には到達不能として返す。
      process.stderr.write(`auth module: ${(result.stderr ?? '').split('\n')[0].slice(0, 200) || result.reason}\n`);
      throw new Error('AUTH_MODULE_UNREACHABLE');
    }
    return { ok: status < 400, status, text: async () => result.stdout, json: async () => JSON.parse(result.stdout) };
  };
}

// 認証仲介の署名品目（HMAC）でtextに署名し、小文字hexで返す。鍵は端末に来ない。`auth sign`はbase64で返す。
export async function moduleSign(item, text, { execute = run, home = homedir(), env = process.env, platform = process.platform, timeoutMs = 30_000 } = {}) {
  const result = await runRelay('factory-relay-sign.sh', [item], text, { execute, home, env, platform, timeoutMs });
  const signature = (result.stdout ?? '').trim();
  if (!result.ok || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) {
    process.stderr.write(`auth module: ${(result.stderr ?? '').split('\n')[0].slice(0, 200) || result.reason}\n`);
    throw new Error('AUTH_MODULE_UNREACHABLE');
  }
  return Buffer.from(signature, 'base64').toString('hex');
}
