#!/usr/bin/env node
// 子processへ秘密を渡す入口。env fileの`op://`参照だけを1Passwordから読み、平文の値はそのまま渡す。
// 読めなければ子を起動しない。子はService Account tokenを受け取らない。
import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { resolveSecret } from '../lib/factory/op-secret.mjs';

const USAGE = '使い方: dotagents-op-run --env-file <file> -- <command> [args...]';

export async function prepare(argv, { env = process.env, readText = (file) => readFile(file, 'utf8'), resolve = resolveSecret } = {}) {
  const separator = argv.indexOf('--');
  if (argv[0] !== '--env-file' || !argv[1] || separator !== 2 || !argv[3]) throw new Error(`OP_RUN_USAGE: ${USAGE}`);
  let text;
  try { text = await readText(argv[1]); } catch (error) { throw new Error(`OP_RUN_ENV_FILE_UNREADABLE: ${error.code ?? error.message}`); }
  const childEnv = { ...env };
  delete childEnv.OP_SERVICE_ACCOUNT_TOKEN;
  for (const [name, value] of Object.entries(parseEnv(text))) {
    childEnv[name] = await resolve(value, { env });
  }
  return { command: argv[3], args: argv.slice(4), env: childEnv };
}

async function main() {
  let prepared;
  try { prepared = await prepare(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`dotagents-op-run: ${error.message}\n`); process.exit(2); }
  const child = spawn(prepared.command, prepared.args, { env: prepared.env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { process.stderr.write(`dotagents-op-run: OP_RUN_SPAWN_FAILED: ${error.code ?? error.message}\n`); process.exit(127); });
  child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exit(code ?? 1); });
}

// ~/.local/binのsymlinkから呼ばれても実体pathで比べる。
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
