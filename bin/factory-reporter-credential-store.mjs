#!/usr/bin/env node
// reporterのcredential file（--typesafeの時はTypeSafeのapi.env）へ、標準入力のtokenを平文で置く（1Passwordを使わない端末向け）。
// main-serverの呼び手がsshの標準入力で渡す。tokenはargv・環境・出力へ出さない。
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { readConfig } from '../lib/factory/contract.mjs';
import { ownerOnlyAcl } from '../lib/factory/scheduler-state.mjs';
import { typeSafeKeyPath } from '../lib/factory/typesafe-credentials.mjs';

const MAX_BYTES = 4096;
const defaultConfigPath = () => (platform() === 'win32'
  ? join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'dotagents', 'factory-reporter', 'config.json')
  : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dotagents', 'factory-reporter.json'));

async function readStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('tokenが大きすぎます');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

try {
  const args = process.argv.slice(2);
  const typesafe = args[0] === '--typesafe';
  const configPath = args[0] === '--config' && args[1] ? args[1] : defaultConfigPath();
  // 空・空白入り・op://参照は置かない（置くと次のrunのflushが壊れる）。
  const token = (await readStdin()).replace(/\r?\n$/u, '');
  if (!/^[\x21-\x7e]+$/u.test(token) || token.startsWith('op://')) throw new Error('tokenが空か、使えない文字を含みます');
  // .envの引用・コメント記号に化ける文字は、api.envの形式（TYPESAFE_API_KEY=値）では置かない。
  if (typesafe && !/^[\w.~+/=:-]+$/u.test(token)) throw new Error('TypeSafeのtokenに使えない文字を含みます');
  const config = typesafe ? null : await readConfig(configPath);
  const file = typesafe ? typeSafeKeyPath() : (config.source === 'file' ? config.reporting?.credential_file : null);
  if (typeof file !== 'string' || !file) throw new Error('設定にreporting.credential_fileがありません');
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  if (typesafe && platform() === 'win32') ownerOnlyAcl(dirname(file));
  try { if ((await lstat(file)).isDirectory()) throw new Error('credential_fileがdirectoryです'); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, typesafe ? `TYPESAFE_API_KEY=${token}\n` : token, { flag: 'wx', mode: 0o600 });
    if (platform() === 'win32') ownerOnlyAcl(temporary); else await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
  process.stdout.write(`${JSON.stringify({ ok: true, command: 'store', bytes: Buffer.byteLength(token) })}\n`);
} catch (error) {
  process.stderr.write(`[factory-reporter-credential-store] ${error?.message || '失敗'}\n`);
  process.exitCode = 1;
}
