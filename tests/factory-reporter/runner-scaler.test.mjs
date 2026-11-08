import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FACTORY_RUNNERS } from '../../lib/factory/deployment-contract.mjs';
import { IDLE_STOP_MS, REFRESH_MS, decide, idleFraction, memorystatusBytes, rootProcesses } from '../../lib/factory/runner-scaler.mjs';

// docs/feature-map/runner-capacity.md: state diagram and decide() rules.
const NOW = 10 * REFRESH_MS;
const root = (name, extra = {}) => ({ name, registered: true, running: false, busy: false, idleSince: null, lastRun: NOW - 1000, ...extra });
const idle = (name, since = NOW - IDLE_STOP_MS) => root(name, { running: true, idleSince: since });
const busy = (name) => root(name, { running: true, busy: true });
const free = { cpuIdle: 0.8, availGiB: 20, jobGiB: 4, reserveGiB: 4, now: NOW };
const tight = { ...free, cpuIdle: 0.1 };

test('all running listeners busy with headroom: start the least recently run stopped root', () => {
  const result = decide({ ...free, roots: [busy('a'), root('b', { lastRun: NOW - 50 }), root('c', { lastRun: NOW - 500 })] });
  assert.deepEqual([result.action, result.name, result.desired], ['start', 'c', 2]);
});

test('no CPU or memory headroom, or an incomplete CPU window: no scale-up', () => {
  for (const load of [tight, { ...free, availGiB: 7.9 }, { ...free, cpuIdle: null }]) {
    assert.equal(decide({ ...load, roots: [busy('a'), root('b')] }).action, null);
  }
});

test('load gate: a seat limit blocks scale-up above the 1-minute load per CPU and names the failed gate', () => {
  const roots = [busy('a'), root('b')];
  const mac = { ...free, maxLoadPerCpu: 1 };
  assert.deepEqual((({ action, gate }) => [action, gate])(decide({ ...mac, loadPerCpu: 1, roots })), ['start', null]);
  assert.deepEqual((({ action, gate, desired }) => [action, gate, desired])(decide({ ...mac, loadPerCpu: 5.2, roots })), [null, 'load', 1]);
  assert.equal(decide({ ...mac, loadPerCpu: null, roots }).gate, 'load');
  assert.equal(decide({ ...free, loadPerCpu: 52, roots }).action, 'start'); // no seat limit: load ignored (Linux/Windows)
  assert.deepEqual([tight, { ...free, availGiB: 7.9 }, { ...free, cpuIdle: null }].map((load) => decide({ ...load, roots }).gate), ['cpu-idle', 'memory', 'cpu-window']);
  assert.equal(decide({ ...mac, loadPerCpu: 5.2, roots: [busy('a'), idle('b')] }).action, 'stop');
});

test('minimum one listener even without headroom; never above the registered pool', () => {
  assert.deepEqual(Object.values((({ action, name }) => ({ action, name }))(decide({ ...tight, roots: [root('a'), root('b')] }))), ['start', 'a']);
  const full = decide({ ...free, roots: [busy('a'), busy('b'), root('c', { registered: false })] });
  assert.equal(full.desired, 2);
  assert.equal(full.action, null);
});

test('scale-down stops only a listener idle for 120 s, longest idle first, never busy, never the last', () => {
  assert.equal(decide({ ...tight, roots: [busy('a'), idle('b', NOW - IDLE_STOP_MS + 1)] }).action, null);
  assert.deepEqual(['stop', 'c'], (({ action, name }) => [action, name])(decide({ ...tight, roots: [busy('a'), idle('b'), idle('c', NOW - IDLE_STOP_MS - 5)] })));
  assert.equal(decide({ ...tight, roots: [busy('a'), busy('b')] }).action, null);
  assert.equal(decide({ ...tight, roots: [idle('a', 0)] }).action, null);
});

test('stale stopped root is refreshed only with headroom; idle extra listeners are then trimmed', () => {
  const roots = [idle('a', NOW), root('b', { lastRun: 0 })];
  assert.deepEqual((({ action, name, reason }) => [action, name, reason])(decide({ ...free, roots })), ['start', 'b', 'refresh']);
  assert.equal(decide({ ...tight, roots }).action, null);
});

test('process table maps listeners and workers to roots by path prefix', () => {
  const unix = [{ name: 'u', root: '/home/r/actions-runner' }, { name: 'u2', root: '/home/r/actions-runner-2' }];
  const ps = ' 10 /home/r/actions-runner/bin/Runner.Listener run\n 11 /home/r/actions-runner-2/bin/Runner.Listener run\n 12 /home/r/actions-runner-2/bin/Runner.Worker spawnclient 1 2\n 13 /usr/bin/node x\n';
  assert.deepEqual(rootProcesses(ps, unix, false), { u: { listener: 10, busy: false }, u2: { listener: 11, busy: true } });
  const win = [{ name: 'u', root: 'C:\\actions-runner-dotagents-u' }, { name: 'u2', root: 'C:\\actions-runner-dotagents-u2' }];
  const cim = '20 C:\\actions-runner-dotagents-u\\bin.2.329.0\\Runner.Listener.exe\r\n21 c:\\actions-runner-dotagents-u2\\bin\\Runner.Worker.exe\r\n22 \r\n';
  assert.deepEqual(rootProcesses(cim, win, true), { u: { listener: 20, busy: false }, u2: { listener: null, busy: true } });
});

test('macOS available memory and CPU idle window', () => {
  assert.equal(memorystatusBytes('42\n', 100), 42);
  for (const bad of ['', 'x', '101', '-1']) assert.throws(() => memorystatusBytes(bad, 100));
  assert.equal(idleFraction([{ at: 0, idle: 0, total: 0 }, { at: 30_000, idle: 5, total: 10 }], 30_000), null);
  assert.equal(idleFraction([{ at: 0, idle: 0, total: 0 }, { at: 30_000, idle: 5, total: 10 }, { at: 60_000, idle: 30, total: 100 }], 60_000), 0.3);
});

test('config generator emits each seat pool from the contract', () => {
  for (const seat of FACTORY_RUNNERS) {
    const result = spawnSync(process.execPath, ['bin/factory-runner-scaler-config.mjs', seat.label, '/tmp/x.log'], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const expected = { label: seat.label, jobGiB: seat.jobGiB, reserveGiB: seat.reserveGiB, maxLoadPerCpu: seat.maxLoadPerCpu, log: '/tmp/x.log', instances: seat.instances.map((item) => ({ ...item })) };
    assert.deepEqual(JSON.parse(result.stdout), JSON.parse(JSON.stringify(expected)));
  }
  assert.notEqual(spawnSync(process.execPath, ['bin/factory-runner-scaler-config.mjs', 'nope', '/tmp/x.log']).status, 0);
});

test('scaler starts one registered listener and logs it (fake runner root)', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-scaler-'));
  try {
    const rootDir = path.join(dir, 'actions-runner');
    fs.mkdirSync(path.join(rootDir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(rootDir, '.runner'), '{}');
    fs.writeFileSync(path.join(rootDir, 'bin', 'Runner.Listener'), `#!/bin/sh\necho "$PATH" > "${dir}/started"\ntrap 'exit 0' INT\nwhile :; do sleep 1; done\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(rootDir, '.path'), '/usr/bin:/bin\n');
    const config = path.join(dir, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ label: 't', jobGiB: 1, reserveGiB: 0, log: path.join(dir, 'log'), instances: [{ name: 't1', root: rootDir }, { name: 't2', root: path.join(dir, 'unregistered') }] }));
    const scaler = spawn(process.execPath, ['lib/factory/runner-scaler.mjs', config], { stdio: 'ignore' });
    try {
      for (let i = 0; i < 50 && !fs.existsSync(path.join(dir, 'started')); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(fs.readFileSync(path.join(dir, 'started'), 'utf8').trim(), '/usr/bin:/bin');
      const lines = fs.readFileSync(path.join(dir, 'log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      assert.deepEqual(lines.map(({ action, name, reason }) => [action, name, reason]), [['scaler-start', undefined, undefined], ['start', 't1', 'scale-up']]);
    } finally {
      scaler.kill();
      spawnSync('pkill', ['-INT', '-f', path.join(rootDir, 'bin', 'Runner.Listener')]);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
