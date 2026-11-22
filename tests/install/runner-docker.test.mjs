import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  DOCKER_HOST, DOCKER_SERVICE, DOCKER_SOCKET, ROOTLESS_SCRIPTS, hasRootEnv, hasSubidRange, nextSubidStart, renderDockerdUnit, rootHome, setRootEnv,
} from '../../lib/factory/runner-docker.mjs';

// docs/feature-map/runner-capacity.md "Rootless Docker": the .env writer, the check's reader, the unit and the id allocation.
const helper = (args, input = '') => spawnSync(process.execPath, ['bin/factory-runner-docker.mjs', ...args], { input, encoding: 'utf8' });

const ROOT_A = '/home/factory-runner/actions-runner';
const ROOT_B = '/home/factory-runner/actions-runner-2';

test('set-env writes one DOCKER_HOST and one per-root HOME, replaces any other, keeps the rest, and is idempotent', () => {
  const once = setRootEnv('LANG=C.UTF-8', ROOT_A);
  assert.equal(once, `LANG=C.UTF-8\nDOCKER_HOST=${DOCKER_HOST}\nHOME=${ROOT_A}/home\n`);
  assert.equal(setRootEnv(once, ROOT_A), once);
  assert.equal(setRootEnv('', ROOT_A), `DOCKER_HOST=${DOCKER_HOST}\nHOME=${ROOT_A}/home\n`);
  assert.equal(setRootEnv('HOME=/home/factory-runner\nDOCKER_HOST=unix:///var/run/docker.sock\nA=1\nDOCKER_HOST=tcp://x:1\nHOME=/x\n', ROOT_B),
    `A=1\nDOCKER_HOST=${DOCKER_HOST}\nHOME=${ROOT_B}/home\n`);
  // moving a root's file to another root (the pool copies the first root's .env) is repaired by the next write
  assert.equal(setRootEnv(setRootEnv('A=1', ROOT_A), ROOT_B), `A=1\nDOCKER_HOST=${DOCKER_HOST}\nHOME=${ROOT_B}/home\n`);
});

test('has-env accepts exactly one expected DOCKER_HOST and one expected HOME for that root (missing, wrong, shared or duplicated: refused)', () => {
  const ok = setRootEnv('A=1', ROOT_A);
  assert.equal(hasRootEnv(ok, ROOT_A), true);
  assert.equal(hasRootEnv(ok, ROOT_B), false, 'another root\'s HOME is not this root\'s');
  assert.equal(hasRootEnv('A=1\n', ROOT_A), false);
  assert.equal(hasRootEnv(`DOCKER_HOST=${DOCKER_HOST}\n`, ROOT_A), false, 'HOME missing');
  assert.equal(hasRootEnv(`HOME=${ROOT_A}/home\n`, ROOT_A), false, 'DOCKER_HOST missing');
  assert.equal(hasRootEnv(`DOCKER_HOST=unix:///var/run/docker.sock\nHOME=${ROOT_A}/home\n`, ROOT_A), false);
  assert.equal(hasRootEnv('DOCKER_HOST=' + DOCKER_HOST + '\nHOME=/home/factory-runner\n', ROOT_A), false, 'the shared HOME is refused');
  assert.equal(hasRootEnv(`${ok}HOME=${ROOT_A}/home\n`, ROOT_A), false, 'duplicate HOME');
  assert.equal(hasRootEnv(`${ok}DOCKER_HOST=${DOCKER_HOST}\n`, ROOT_A), false, 'duplicate DOCKER_HOST');
  assert.equal(hasRootEnv(`# HOME=${ROOT_A}/home\nDOCKER_HOST=${DOCKER_HOST}\n`, ROOT_A), false);
  assert.equal(helper(['has-env', ROOT_A], setRootEnv('A=1', ROOT_A)).status, 0);
  assert.equal(helper(['has-env', ROOT_B], setRootEnv('A=1', ROOT_A)).status, 1);
  assert.equal(helper(['set-env', ROOT_B], 'A=1\n').stdout, setRootEnv('A=1', ROOT_B));
});

test('every pool root of the contract gets a distinct HOME inside the root, and bad roots are refused', async () => {
  const { POOL_INSTANCES } = await import('../../lib/factory/runner-profile.mjs');
  const homes = POOL_INSTANCES.map((item) => rootHome(item.root));
  assert.equal(new Set(homes).size, POOL_INSTANCES.length);
  for (const [index, home] of homes.entries()) assert.equal(home, `${POOL_INSTANCES[index].root}/home`);
  for (const bad of ['', 'relative/root', '/a/../b', '/a//b', '/a/', '/a b', '/a\nHOME=/x']) assert.throws(() => rootHome(bad), /invalid pool root/);
  assert.equal(helper(['set-env'], 'A=1\n').status, 2);
  assert.equal(helper(['set-env', '/a/../b'], 'A=1\n').status, 2);
  assert.equal(helper(['has-env', 'x'], '').status, 2);
});

test('the socket is a fixed runtime path outside /var/run/docker.sock, and the unit creates exactly that directory', () => {
  assert.equal(DOCKER_SOCKET, '/run/factory-runner-docker/docker.sock');
  assert.notEqual(DOCKER_SOCKET, '/var/run/docker.sock');
  assert.equal(DOCKER_HOST, `unix://${DOCKER_SOCKET}`);
  assert.deepEqual(helper(['config']).stdout.trimEnd().split('\t'), [DOCKER_SERVICE, DOCKER_SOCKET, DOCKER_HOST]);
});

test('daemon unit: runs as factory-runner with its own runtime dir; no NoNewPrivileges (setuid newuidmap) and no docker group', () => {
  const unit = renderDockerdUnit();
  assert.equal(helper(['unit']).stdout, unit);
  for (const line of ['User=factory-runner', 'Group=factory-runner', 'RuntimeDirectory=factory-runner-docker', 'RuntimeDirectoryMode=0700',
    'Environment=XDG_RUNTIME_DIR=/run/factory-runner-docker', `ExecStart=/usr/bin/dockerd-rootless.sh --host ${DOCKER_HOST} --exec-opt native.cgroupdriver=cgroupfs`, 'Nice=10', 'CPUWeight=20']) {
    assert.ok(unit.split('\n').includes(line), line);
  }
  assert.doesNotMatch(unit.replace(/^#.*$/gm, ''), /NoNewPrivileges|CapabilityBoundingSet/);
  assert.doesNotMatch(unit, /SupplementaryGroups=|Group=docker/);
});

test('the launcher is the Engine\'s own: docker-ce default, Ubuntu docker.io contrib path, nothing else', () => {
  assert.equal(ROOTLESS_SCRIPTS['docker-ce'], '/usr/bin/dockerd-rootless.sh');
  assert.equal(ROOTLESS_SCRIPTS['docker.io'], '/usr/share/docker.io/contrib/dockerd-rootless.sh');
  assert.ok(renderDockerdUnit().includes(`ExecStart=${ROOTLESS_SCRIPTS['docker-ce']} --host ${DOCKER_HOST} --exec-opt native.cgroupdriver=cgroupfs`));
  const io = renderDockerdUnit(ROOTLESS_SCRIPTS['docker.io']);
  assert.ok(io.includes(`ExecStart=${ROOTLESS_SCRIPTS['docker.io']} --host ${DOCKER_HOST} --exec-opt native.cgroupdriver=cgroupfs`));
  assert.equal(helper(['unit', ROOTLESS_SCRIPTS['docker.io']]).stdout, io);
  assert.throws(() => renderDockerdUnit('/bin/sh'), /unknown rootless launcher/);
  assert.equal(helper(['unit', '/bin/sh']).status, 2);
  assert.deepEqual(helper(['scripts']).stdout.trimEnd().split('\n').map((line) => line.split('\t')), Object.entries(ROOTLESS_SCRIPTS));
});

test('every launcher starts the daemon with the cgroupfs driver (no user session, so the systemd driver cannot work)', () => {
  for (const script of Object.values(ROOTLESS_SCRIPTS)) {
    const exec = renderDockerdUnit(script).split('\n').filter((line) => line.startsWith('ExecStart='));
    assert.equal(exec.length, 1);
    assert.match(exec[0], /--exec-opt native\.cgroupdriver=cgroupfs$/);
  }
});

test('subuid/subgid: allocate after every existing range; leave a runner that already has 65536 ids alone', () => {
  assert.equal(nextSubidStart(''), 100000);
  assert.equal(nextSubidStart('kite:100000:65536\nother:165536:65536\n'), 231072);
  assert.equal(nextSubidStart('bad line\nx:y:z\n'), 100000);
  assert.equal(nextSubidStart('low:1000:10\n'), 100000);
  assert.equal(hasSubidRange('kite:100000:65536\nfactory-runner:165536:65536\n'), true);
  assert.equal(hasSubidRange('factory-runner:165536:1000\n'), false);
  assert.equal(hasSubidRange('kite:100000:65536\n'), false);
  assert.equal(helper(['subid-start'], 'kite:100000:65536\n').stdout.trim(), '165536');
  assert.equal(helper(['subid-start'], 'factory-runner:165536:65536\n').status, 3);
});

test('unknown command and extra arguments are refused', () => {
  assert.equal(helper(['nope']).status, 2);
  assert.equal(helper(['config', 'x']).status, 2);
  assert.equal(helper([]).status, 2);
});
