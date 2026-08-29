import { spawn, spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_HELPER_FLAG = '--factory-windows-command-resolve';
const WINDOWS_HELPER_OUTPUT_BYTES = 4096;
const WINDOWS_HELPER_PATH = fileURLToPath(import.meta.url);
const WINDOWS_HELPER_ERROR_CODES = new Set(['EACCES', 'EINVAL', 'ENOENT', 'ENOTDIR']);

function commandError(message, code = 'EINVAL') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function bareCommand(command) {
  return typeof command === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(command);
}

function pathExtensions(value) {
  const extensions = (value || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((extension) => extension.toLowerCase());
  if (!extensions.length || extensions.some((extension) => !/^\.[A-Za-z0-9]+$/u.test(extension))) throw commandError('Windows PATHEXTが不正です');
  return extensions;
}

function environmentValue(env, name) {
  const key = Object.keys(env).find((entry) => entry.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

async function regularFile(path, fs) {
  const info = await fs.lstat(path);
  return info.isFile() && !info.isSymbolicLink();
}

async function npmCmdEntrypoint(shim, fs, pathModule) {
  let source;
  try {
    source = await fs.readFile(shim, 'utf8');
  } catch (error) {
    throw commandError('Windows command shimを読めません', error?.code || 'EINVAL');
  }
  source = source.replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
  const patterns = [
    /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n+IF EXIST "%dp0%\\node\.exe" \(\n {1,2}SET "_prog=%dp0%\\node\.exe"\n\) ELSE \(\n {1,2}SET "_prog=node"\n\)\n+endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"\s+"%dp0%\\(node_modules(?:\\[A-Za-z0-9@._-]+)+\.(?:cjs|mjs|js))"\s+%\*\n?$/iu,
    /^@ECHO off\nGOTO start\n:find_dp0\nSET dp0=%~dp0\nEXIT \/b\n:start\nSETLOCAL\nCALL :find_dp0\n+IF EXIST "%dp0%\\node\.exe" \(\n {1,2}SET "_prog=%dp0%\\node\.exe"\n\) ELSE \(\n {1,2}SET "_prog=node"\n  SET PATHEXT=%PATHEXT:;.JS;=;%\n\)\n+endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"  "%dp0%\\(node_modules(?:\\[A-Za-z0-9@._-]+)+\.(?:cjs|mjs|js))" %\*\n?$/iu,
  ];
  const match = patterns.map((pattern) => pattern.exec(source)).find(Boolean);
  if (!match) throw commandError('Windows command shimのNode entrypointが不正です');

  const segments = match[1].split('\\');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) throw commandError('Windows command shimのNode entrypointが不正です');
  const shimDirectory = await fs.realpath(pathModule.dirname(shim));
  const nodeModules = pathModule.join(shimDirectory, 'node_modules');
  const entrypoint = pathModule.join(shimDirectory, ...segments);
  let resolved;
  try {
    if (!await regularFile(entrypoint, fs)) throw commandError('Windows command shimのNode entrypointが不正です');
    resolved = await fs.realpath(entrypoint);
  } catch (error) {
    if (error?.code === 'EINVAL') throw error;
    throw commandError('Windows command shimのNode entrypointが不正です', error?.code || 'EINVAL');
  }
  const relative = pathModule.relative(nodeModules, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${pathModule.sep}`) || pathModule.isAbsolute(relative)) throw commandError('Windows command shimのNode entrypointが不正です');
  return resolved;
}

export async function resolveWindowsCommand(command, {
  env = process.env,
  fs = { lstat, readFile, realpath },
  pathModule = win32,
} = {}) {
  if (!bareCommand(command)) throw commandError('Windows command名が不正です');
  const pathValue = environmentValue(env, 'PATH');
  if (typeof pathValue !== 'string' || !pathValue) throw commandError('Windows PATHが不正です', 'ENOENT');
  const extensions = pathExtensions(environmentValue(env, 'PATHEXT')).filter((extension) => ['.exe', '.cmd'].includes(extension));
  const directories = pathValue.split(pathModule.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = pathModule.join(directory, `${command}${extension}`);
      let present;
      try {
        present = await regularFile(candidate, fs);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw commandError('Windows commandを検証できません', error?.code || 'EINVAL');
      }
      if (!present) throw commandError('Windows command shimが不正です');
      if (extension === '.exe') return { command: candidate, prefixArgs: [] };
      if (extension === '.cmd') return { command: process.execPath, prefixArgs: [await npmCmdEntrypoint(candidate, fs, pathModule)] };
    }
  }
  throw commandError('Windows commandがPATHにありません', 'ENOENT');
}

function helperError(code = 'EINVAL') { return commandError('Windows command helperが不正です', code); }
function exact(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function validHelperResolution(value, pathModule) {
  if (!exact(value, ['command', 'prefixArgs']) || typeof value.command !== 'string' || !Array.isArray(value.prefixArgs) || value.prefixArgs.some((item) => typeof item !== 'string' || /[\0\r\n]/u.test(item)) || /[\0\r\n]/u.test(value.command) || !pathModule.isAbsolute(value.command)) throw helperError();
  if (value.prefixArgs.length === 0 && /\.exe$/iu.test(value.command)) return value;
  const entrypoint = value.prefixArgs[0];
  const segments = typeof entrypoint === 'string' ? entrypoint.split(/[\\/]/u).filter(Boolean) : [];
  if (value.prefixArgs.length === 1 && value.command === process.execPath && pathModule.isAbsolute(entrypoint) && /\.(?:cjs|mjs|js)$/iu.test(entrypoint) && segments.includes('node_modules') && !segments.includes('.') && !segments.includes('..')) return value;
  throw helperError();
}
function helperResult(value, pathModule) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.status !== 'string') throw helperError();
  if (value.status === 'ok' && exact(value, ['status', 'command', 'prefixArgs'])) return validHelperResolution({ command: value.command, prefixArgs: value.prefixArgs }, pathModule);
  if (value.status === 'error' && exact(value, ['status', 'code']) && typeof value.code === 'string' && WINDOWS_HELPER_ERROR_CODES.has(value.code)) throw commandError('Windows command helperが失敗しました', value.code);
  throw helperError();
}

function terminateProcess(child, platform) {
  if (!child || child.killed) return;
  if (platform !== 'win32') {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
    return;
  }
  const taskkill = process.env.SystemRoot
    ? win32.join(process.env.SystemRoot, 'System32', 'taskkill.exe')
    : 'taskkill.exe';
  const result = spawnSync(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
    stdio: 'ignore', timeout: 5000, windowsHide: true,
  });
  if (result.error || result.status !== 0) child.kill('SIGKILL');
}

function resolveWindowsCommandInHelper(command, { env, deadlineAt, pathModule, helperPath, helperNode, onChild }) {
  return new Promise((resolve, reject) => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) { reject(helperError('ETIMEDOUT')); return; }
    let helper;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timer;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      onChild(null);
      fn(value);
    };
    const terminate = () => { if (helper && !helper.killed) helper.kill('SIGKILL'); };
    try {
      helper = spawn(helperNode, [helperPath, WINDOWS_HELPER_FLAG], { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) { finish(reject, error); return; }
    onChild(helper);
    const collect = (kind) => (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > WINDOWS_HELPER_OUTPUT_BYTES) { terminate(); finish(reject, helperError()); return; }
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
    };
    helper.stdout.on('data', collect('stdout'));
    helper.stderr.on('data', collect('stderr'));
    helper.on('error', (error) => finish(reject, error));
    helper.on('close', (code) => {
      if (code !== 0) { finish(reject, helperError()); return; }
      try { finish(resolve, helperResult(JSON.parse(stdout), pathModule)); } catch (error) { finish(reject, error); }
    });
    timer = setTimeout(() => { terminate(); finish(reject, helperError('ETIMEDOUT')); }, remaining);
    try {
      helper.stdin.end(JSON.stringify({ command, path: environmentValue(env, 'PATH'), pathext: environmentValue(env, 'PATHEXT') ?? null }));
    } catch (error) { terminate(); finish(reject, error); }
  });
}

async function helperMain() {
  try {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > WINDOWS_HELPER_OUTPUT_BYTES) throw helperError(); }
    const value = JSON.parse(input);
    if (!exact(value, ['command', 'path', 'pathext']) || typeof value.command !== 'string' || typeof value.path !== 'string' || (value.pathext !== null && typeof value.pathext !== 'string')) throw helperError();
    const resolved = await resolveWindowsCommand(value.command, { env: { PATH: value.path, ...(value.pathext === null ? {} : { PATHEXT: value.pathext }) } });
    process.stdout.write(JSON.stringify({ status: 'ok', ...resolved }));
  } catch (error) {
    process.stdout.write(JSON.stringify({ status: 'error', code: WINDOWS_HELPER_ERROR_CODES.has(error?.code) ? error.code : 'EINVAL' }));
  }
}

export function run(command, args, {
  cwd,
  timeoutMs = 5000,
  maxOutputBytes = 64 * 1024,
  env = process.env,
  input,
  platform = process.platform,
  windowsPathModule = win32,
  windowsHelperPath = WINDOWS_HELPER_PATH,
  windowsHelperNode = process.execPath,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    let helperChild;
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timer;
    let terminationResult;

    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const terminate = () => {
      terminateProcess(child, platform);
      if (helperChild && !helperChild.killed) helperChild.kill('SIGKILL');
    };
    const terminateAndSettle = (value) => {
      if (settled || terminationResult) return;
      if (!child) {
        terminate();
        settle(value);
        return;
      }
      terminationResult = value;
      clearTimeout(timer);
      terminate();
    };

    const collect = (kind) => (chunk) => {
      if (settled || terminationResult) return;
      bytes += chunk.length;
      if (bytes > maxOutputBytes) {
        terminateAndSettle({ ok: false, reason: 'output_limit', stdout: '', stderr: '' });
        return;
      }
      if (kind === 'stdout') stdout += chunk;
      else stderr += chunk;
    };

    const start = async () => {
      let executable = command;
      let commandArgs = args;
      if (platform === 'win32') {
        try {
          const resolved = await resolveWindowsCommandInHelper(command, {
            env, deadlineAt, pathModule: windowsPathModule, helperPath: windowsHelperPath, helperNode: windowsHelperNode,
            onChild: (value) => { helperChild = value; },
          });
          if (settled) return;
          executable = resolved.command;
          commandArgs = [...resolved.prefixArgs, ...args];
        } catch (error) {
          settle({ ok: false, reason: 'spawn', stdout: '', stderr: '', error });
          return;
        }
      }
      try {
        child = spawn(executable, commandArgs, {
          cwd, env, detached: platform !== 'win32',
          stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        settle({ ok: false, reason: 'spawn', stdout: '', stderr: '', error });
        return;
      }
      if (input !== undefined) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
      child.stdout.on('data', collect('stdout'));
      child.stderr.on('data', collect('stderr'));
      child.on('error', (error) => {
        settle(terminationResult ?? { ok: false, reason: 'spawn', stdout: '', stderr: '', error });
      });
      child.on('close', (code) => {
        settle(terminationResult ?? { ok: code === 0, code, reason: code === 0 ? null : 'exit', stdout, stderr });
      });
    };
    const deadlineAt = Date.now() + timeoutMs;
    timer = setTimeout(() => {
      terminateAndSettle({ ok: false, reason: 'timeout', stdout: '', stderr: '' });
    }, timeoutMs);
    start();
  });
}

if (process.argv[1] === WINDOWS_HELPER_PATH && process.argv[2] === WINDOWS_HELPER_FLAG) {
  helperMain().catch(() => { process.exitCode = 1; });
}
