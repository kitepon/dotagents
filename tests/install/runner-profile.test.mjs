import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseDedicatedRunnerProfile, readRunnerProfile } from '../../lib/factory/runner-profile.mjs';

const value = {
  schema: 'dotagents.runner-profile.v1', mode: 'dedicated', state: 'active',
  name: 'factory-linux-rabbit-u', user: 'factory-runner',
  service: 'actions.runner.kitepon.factory-linux-rabbit-u.service',
  root: '/home/factory-runner/actions-runner', label: 'linux-workstation',
};
const trusted = { isFile: true, uid: 0, mode: 0o100644 };

test('root-owned active dedicated profile preserves the approved identity', () => {
  assert.deepEqual(parseDedicatedRunnerProfile(JSON.stringify(value), trusted), value);
});

test('untrusted file ownership, writable permissions and symlinks fail closed', () => {
  for (const metadata of [{ ...trusted, uid: 1000 }, { ...trusted, mode: 0o100664 }, { ...trusted, mode: 0o100646 }, { ...trusted, isFile: false }]) {
    assert.throws(() => parseDedicatedRunnerProfile(JSON.stringify(value), metadata), /root-owned/);
  }
});

test('trial state and foreign service/account/path are rejected', () => {
  for (const [key, replacement] of Object.entries({ state: 'trial', service: 'ssh.service', user: 'root', root: '/home/kite', name: 'factory-linux-rabbit', label: 'linux-server' })) {
    assert.throws(() => parseDedicatedRunnerProfile(JSON.stringify({ ...value, [key]: replacement }), trusted));
  }
});

test('missing profile preserves legacy behavior, malformed present profile is not ignored', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotagents-runner-profile-'));
  try {
    const file = path.join(directory, 'profile.json');
    assert.deepEqual(readRunnerProfile(file), { mode: 'legacy' });
    fs.writeFileSync(file, 'invalid json');
    assert.throws(() => readRunnerProfile(file));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('a symlink to an absent profile does not enable legacy provisioning', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dotagents-runner-link-'));
  try {
    const link = path.join(directory, 'profile.json');
    fs.symlinkSync(path.join(directory, 'absent.json'), link);
    assert.throws(() => readRunnerProfile(link));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
