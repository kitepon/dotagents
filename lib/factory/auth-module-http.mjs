import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from './command.mjs';

// 認証仲介の品目名。鍵は認証仲介の中だけにあり、この製品は結果だけを受け取る。
export const BUGHUB_ITEM = 'bughub-reporter';
// 品目の基点（http://192.168.1.2:39310/api/factory/v9）。要求のpathは基点からの相対で渡す。
export const BUGHUB_BASE_PATH = '/api/factory/v9';
export const TYPESAFE_ITEM = 'typesafe';

// Windows標準のssh.exeは非対話sessionで出力を受け取ると終了しないため、Git for Windows同梱のOpenSSHを使う。
export const sshCommand = (platform, env) => (platform === 'win32'
  ? win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'ssh.exe') : 'ssh');

export const authRoutePath = (home = homedir()) => join(home, '.config', 'dotagents', 'auth-route');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const LOCAL_RELAY = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'factory-relay-http.sh');

// 経路: fileが`local`ならこの端末の中継scriptを直接走らせる（main-server）。それ以外はmain-serverへssh（rabbit・mac-kite・fox）。
async function routeOf(home) {
  try { return (await readFile(authRoutePath(home), 'utf8')).trim() === 'local' ? 'local' : 'ssh'; }
  catch (error) { if (error.code === 'ENOENT') return 'ssh'; throw error; }
}

function statusOf(result) {
  const found = /HTTP (\d{3})/u.exec(result.stderr ?? '');
  if (found) return Number(found[1]);
  return result.ok ? 200 : null;
}

// fetchと同じ形で呼べる要求関数。認証仲介が品目の鍵で要求を出し、応答だけを返す。
// shortcut: 応答statusは`auth http`のstderr「HTTP nnn」から読む。成功時に出ない版では200とみなす、モジュールが毎回出す版になれば消す。
export function moduleRequest(item, { basePath = '', execute = run, home = homedir(), env = process.env, platform = process.platform, timeoutMs = 60_000 } = {}) {
  return async (url, init = {}) => {
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { pathname, search } = new URL(url);
    const relative = pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
    const words = [item, (init.method ?? 'POST').toUpperCase(), relative + search];
    const route = await routeOf(home);
    const [command, args] = route === 'local'
      ? ['sh', [LOCAL_RELAY, ...words]]
      : [sshCommand(platform, env), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', env.MAIN_SERVER_SSH_TARGET ?? 'kite@192.168.1.2',
        ['sh', env.DOTAGENTS_MAIN_SERVER_RELAY ?? '/home/kite/Developer/dotagents/bin/factory-relay-http.sh', ...words].map(quote).join(' ')]];
    const result = await execute(command, args, { input: init.body ?? '', timeoutMs, maxOutputBytes: 8 * 1024 * 1024 });
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
