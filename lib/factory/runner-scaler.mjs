// Host runner scaler: keeps 1..N listeners of one seat's runner pool running, decided from measured load.
// Contract and state diagram: docs/feature-map/runner-capacity.md. Runs as the factory runner principal with
// node builtins only (installed as one admin-owned file); it holds no admin rights and no tokens.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const TICK_MS = 30_000;
export const IDLE_STOP_MS = 120_000;
export const CPU_WINDOW_MS = 60_000;
// GitHub deletes self-hosted runners offline for 14 days; a stopped root older than this is started once.
export const REFRESH_MS = 7 * 86_400_000;
export const MIN_CPU_IDLE = 0.3;
const GIB = 1024 ** 3;
const WIN = process.platform === 'win32';
const PWSH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';

// roots: [{name, registered, running, busy, idleSince, lastRun}] -> one action per tick.
export function decide({ roots, cpuIdle, availGiB, jobGiB, reserveGiB, now }) {
  const registered = roots.filter((root) => root.registered);
  const running = registered.filter((root) => root.running);
  const busy = running.filter((root) => root.busy).length;
  const headroom = cpuIdle !== null && cpuIdle >= MIN_CPU_IDLE && availGiB >= jobGiB + reserveGiB;
  const desired = Math.max(1, Math.min(busy + (headroom ? 1 : 0), registered.length));
  const stopped = registered.filter((root) => !root.running).sort((a, b) => a.lastRun - b.lastRun);
  const base = { desired, busy, running: running.length, headroom };
  if (stopped.length && running.length < desired) return { ...base, action: 'start', name: stopped[0].name, reason: 'scale-up' };
  if (stopped.length && headroom && now - stopped[0].lastRun > REFRESH_MS) return { ...base, action: 'start', name: stopped[0].name, reason: 'refresh' };
  if (running.length > desired) {
    const idle = running.filter((root) => !root.busy && root.idleSince !== null && now - root.idleSince >= IDLE_STOP_MS)
      .sort((a, b) => a.idleSince - b.idleSince);
    if (idle.length) return { ...base, action: 'stop', name: idle[0].name, reason: 'scale-down' };
  }
  return { ...base, action: null };
}

// "pid path..." lines (ps -A -o pid=,args= or the Windows CIM projection) -> listener pid and busy flag per root.
export function rootProcesses(text, instances, win = WIN) {
  const norm = (value) => (win ? value.toLowerCase() : value);
  const sep = win ? '\\' : '/';
  const result = Object.fromEntries(instances.map((item) => [item.name, { listener: null, busy: false }]));
  for (const line of text.split(/\r?\n/u)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)/u);
    if (!match) continue;
    const exe = norm(match[2]);
    const kind = /[\\/]runner\.listener(\.exe)?$/iu.test(exe) ? 'listener' : /[\\/]runner\.worker(\.exe)?$/iu.test(exe) ? 'worker' : null;
    const owner = kind && instances.find((item) => exe.startsWith(norm(item.root) + sep));
    if (!owner) continue;
    if (kind === 'listener') result[owner.name].listener ??= Number(match[1]);
    else result[owner.name].busy = true;
  }
  return result;
}

// Free + inactive + speculative pages: what macOS can hand to a new job without paging.
export function parseVmStat(text) {
  const page = Number(text.match(/page size of (\d+) bytes/u)?.[1]);
  const pages = (name) => Number(text.match(new RegExp(`Pages ${name}:\\s+(\\d+)`, 'u'))?.[1]);
  const total = page * (pages('free') + pages('inactive') + pages('speculative'));
  if (!Number.isFinite(total)) throw new Error('vm_stat output not understood');
  return total;
}

export function cpuTimes() {
  let idle = 0, total = 0;
  for (const { times } of os.cpus()) { idle += times.idle; total += times.user + times.nice + times.sys + times.idle + times.irq; }
  return { idle, total };
}

// Idle fraction between now and the newest sample at least CPU_WINDOW_MS old; null until the window is full.
export function idleFraction(samples, now) {
  const last = samples.at(-1);
  const base = samples.findLast((sample) => now - sample.at >= CPU_WINDOW_MS);
  if (!base || last.total === base.total) return null;
  return (last.idle - base.idle) / (last.total - base.total);
}

const run = promisify(execFile);
const encoded = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];

async function processTable() {
  if (!WIN) return (await run('ps', ['-A', '-o', 'pid=,args='], { maxBuffer: 16 * 1024 * 1024 })).stdout;
  const script = "Get-CimInstance Win32_Process -Filter \"Name='Runner.Listener.exe' OR Name='Runner.Worker.exe'\" | ForEach-Object { \"$($_.ProcessId) $($_.ExecutablePath)\" }";
  return (await run(PWSH, encoded(script), { windowsHide: true })).stdout;
}

async function availableBytes() {
  if (process.platform === 'darwin') return parseVmStat((await run('vm_stat')).stdout);
  return os.freemem(); // Linux: MemAvailable; Windows: available physical memory.
}

function lastRun(root) {
  try {
    const dir = path.join(root, '_diag');
    return Math.max(0, ...fs.readdirSync(dir).map((name) => fs.statSync(path.join(dir, name)).mtimeMs));
  } catch { return 0; }
}

function startListener(item, log) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PATH'));
  try { env.PATH = fs.readFileSync(path.join(item.root, '.path'), 'utf8').trim(); } catch { env.PATH = process.env.PATH; }
  // Unix: own process group, so the scaler's exit or signals never reach it. Windows: not detached, so it gets its
  // own hidden console (CREATE_NO_WINDOW) that the Ctrl+Break helper can attach to.
  const child = spawn(path.join(item.root, 'bin', WIN ? 'Runner.Listener.exe' : 'Runner.Listener'), ['run'], {
    cwd: item.root, env, stdio: 'ignore', detached: !WIN, windowsHide: true,
  });
  child.on('error', (error) => log({ action: 'error', name: item.name, error: error.message }));
  child.unref();
}

function stopListener(pid, log) {
  if (!WIN) { process.kill(pid, 'SIGINT'); return; }
  // The listener ignores Ctrl+C when its ancestors disabled it; Ctrl+Break reaches its CancelKeyPress handler
  // (graceful exit, session deleted). The helper is killed by the same event; that is expected.
  const script = `Add-Type -Namespace W -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool FreeConsole();[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);[DllImport("kernel32.dll")] public static extern bool GenerateConsoleCtrlEvent(uint e,uint g);'
[void][W.K]::FreeConsole(); if (![W.K]::AttachConsole(${pid})) { exit 2 }; [void][W.K]::GenerateConsoleCtrlEvent(1, 0); Start-Sleep -Milliseconds 500`;
  spawn(PWSH, encoded(script), { stdio: 'ignore', windowsHide: true }).on('error', (error) => log({ action: 'error', pid, error: error.message }));
}

export async function main(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (!Array.isArray(config.instances) || !config.instances.length) throw new Error('scaler config has no instances');
  const log = (entry) => {
    try { fs.appendFileSync(config.log, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } catch (error) { console.error(error.message); }
  };
  const idleSince = new Map();
  const stoppedAt = new Map(); // a signalled listener needs a few seconds to exit; ignore its root meanwhile
  const seenRunning = new Map(); // last run also counts ticks that saw the listener (a root may write no _diag)
  const samples = [];
  log({ action: 'scaler-start', label: config.label, pool: config.instances.length });
  for (;;) {
    try {
      const now = Date.now();
      samples.push({ at: now, ...cpuTimes() });
      while (samples.length > 2 && now - samples[1].at >= CPU_WINDOW_MS) samples.shift();
      const procs = rootProcesses(await processTable(), config.instances);
      const roots = config.instances.map((item) => {
        const { listener, busy } = procs[item.name];
        if (listener !== null) seenRunning.set(item.name, now);
        if (listener === null || busy) idleSince.delete(item.name);
        else if (!idleSince.has(item.name)) idleSince.set(item.name, now);
        const exiting = now - (stoppedAt.get(item.name) ?? 0) < CPU_WINDOW_MS;
        return { name: item.name, registered: !exiting && fs.existsSync(path.join(item.root, '.runner')), running: listener !== null, busy,
          idleSince: idleSince.get(item.name) ?? null, lastRun: Math.max(lastRun(item.root), seenRunning.get(item.name) ?? 0), listener };
      });
      const cpuIdle = idleFraction(samples, now);
      const availGiB = (await availableBytes()) / GIB;
      const decision = decide({ roots, cpuIdle, availGiB, jobGiB: config.jobGiB, reserveGiB: config.reserveGiB, now });
      if (decision.action) {
        const item = config.instances.find((entry) => entry.name === decision.name);
        if (decision.action === 'start') startListener(item, log);
        else { stopListener(roots.find((root) => root.name === decision.name).listener, log); idleSince.delete(decision.name); stoppedAt.set(decision.name, now); }
        log({ ...decision, cpuIdle: cpuIdle === null ? null : Number(cpuIdle.toFixed(3)), availGiB: Number(availGiB.toFixed(2)) });
      }
    } catch (error) { log({ action: 'error', error: error.message }); }
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2]).catch((error) => { console.error(error.message); process.exit(1); });
}
