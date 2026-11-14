import { randomUUID } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
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

const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

// SSHの席はlogin Keychainの値を読めない（security -wがexit 36 = errSecInteractionNotAllowed）。
// 同じuserのGUI domain（gui/<uid>）へ一度だけのjobを入れて読み、0700のtmp dirのFIFO経由で受け取る。
// tokenはfile・argv・logへ出ない。rootは要らない。GUI sessionが無ければ読めずに名前付きで止まる。
async function readThroughGuiDomain({ args, options, execute, uid = process.getuid?.(), tmp = tmpdir() }) {
  const dir = await mkdtemp(join(tmp, 'dotagents-op-'));
  const fifo = join(dir, 'token');
  const plist = join(dir, 'job.plist');
  const label = `dev.dotagents.op-token.${randomUUID()}`;
  const domain = `gui/${uid}`;
  const program = ['/bin/sh', '-c', 'exec /usr/bin/security "$@" > "$0" 2>/dev/null', fifo, ...args];
  let booted = false;
  try {
    if (!(await execute('mkfifo', ['-m', '600', fifo], options)).ok) return { ok: false };
    await writeFile(plist, '<?xml version="1.0" encoding="UTF-8"?>\n'
      + '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
      + `<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>RunAtLoad</key><true/>`
      + `<key>ProgramArguments</key><array>${program.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array></dict></plist>\n`,
    { mode: 0o600 });
    const reading = execute('cat', [fifo], options);
    booted = (await execute('launchctl', ['bootstrap', domain, plist], options)).ok;
    if (!booted) {
      // 読み手のcatを空のEOFで返す（書き手が来ないまま時間切れまで待たせない）。
      await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).then((handle) => handle.close(), () => {});
    }
    return await reading;
  } finally {
    if (booted) await execute('launchctl', ['bootout', `${domain}/${label}`], options);
    await rm(dir, { recursive: true, force: true });
  }
}

// 保存されていなければundefined（opの本人認証へ任せる）。保存済みで読めなければ名前付きで止まる。
export async function unattendedToken({ platform = process.platform, home = homedir(), env = process.env, execute = run, gui = {} } = {}) {
  const options = { input: '', timeoutMs: 15000, maxOutputBytes: 8192 };
  let result;
  if (platform === 'darwin') {
    const args = ['find-generic-password', '-s', UNATTENDED_KEYCHAIN_SERVICE, '-a', env.USER ?? userInfo().username, '-w'];
    result = await execute('security', args, options);
    if (!result.ok && result.code === 44) return undefined; // errSecItemNotFound
    if (!result.ok && result.code === 36) result = await readThroughGuiDomain({ args, options, execute, ...gui });
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

// trim=falseは`op run`と同じく値をそのまま返す（PEMの末尾改行など）。既定のtrimはtoken用。
export async function resolveSecret(value, { platform = process.platform, home = homedir(), env = process.env, execute = run, trim = true } = {}) {
  const text = value.trim();
  if (!text.startsWith('op://')) return trim ? text : value;
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
  const secret = trim ? read.stdout.trim() : read.stdout;
  if (!secret.trim()) throw new Error('OP_READ_EMPTY: 1Passwordの参照が空です');
  return secret;
}
