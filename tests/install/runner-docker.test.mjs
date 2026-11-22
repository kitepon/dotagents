import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  DOCKER_HOST, DOCKER_SERVICE, DOCKER_SOCKET, ROOTLESS_SCRIPTS, hasDockerHost, hasSubidRange, nextSubidStart, renderDockerdUnit, setDockerHost,
} from '../../lib/factory/runner-docker.mjs';

// docs/feature-map/runner-capacity.md "Rootless Docker": the .env writer, the check's reader, the unit and the id allocation.
const helper = (args, input = '') => spawnSync(process.execPath, ['bin/factory-runner-docker.mjs', ...args], { input, encoding: 'utf8' });

test('set-env adds one DOCKER_HOST line, replaces any other, keeps the rest, and is idempotent', () => {
  const once = setDockerHost('LANG=C.UTF-8\nHOME=/home/factory-runner');
  assert.equal(once, `LANG=C.UTF-8\nHOME=/home/factory-runner\nDOCKER_HOST=${DOCKER_HOST}\n`);
  assert.equal(setDockerHost(once), once);
  assert.equal(setDockerHost(''), `DOCKER_HOST=${DOCKER_HOST}\n`);
  const replaced = setDockerHost('DOCKER_HOST=unix:///var/run/docker.sock\nA=1\nDOCKER_HOST=tcp://x:1\n');
  assert.equal(replaced, `A=1\nDOCKER_HOST=${DOCKER_HOST}\n`);
});

test('has-env accepts exactly one expected line (the check refuses a missing, wrong or duplicated one)', () => {
  assert.equal(hasDockerHost(setDockerHost('A=1')), true);
  assert.equal(hasDockerHost('A=1\n'), false);
  assert.equal(hasDockerHost('DOCKER_HOST=unix:///var/run/docker.sock\n'), false);
  assert.equal(hasDockerHost(`DOCKER_HOST=${DOCKER_HOST}\nDOCKER_HOST=${DOCKER_HOST}\n`), false);
  assert.equal(hasDockerHost(`# DOCKER_HOST=${DOCKER_HOST}\n`), false);
  assert.equal(helper(['has-env'], setDockerHost('A=1')).status, 0);
  assert.equal(helper(['has-env'], 'A=1\n').status, 1);
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
