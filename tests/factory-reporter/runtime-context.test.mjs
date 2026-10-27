import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runtimeContext, logRuntimeContext } from '../../lib/factory/runtime-context.mjs';

const source = new URL(import.meta.url);
const id = '00000000-0000-4000-8000-000000000001';
const fake = (platform = 'linux') => ({ pid: 42, execPath: platform === 'win32' ? 'C:\\node\\node.exe' : '/chosen/node',
  version: 'v24.22.1', platform, execArgv: [], env: {}, config: { variables: { node_use_openssl_ca: false } } });

test('the actual consumer configuration joins its report and source, independently of host platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const runtime = fake(platform);
    const record = runtimeContext({ consumer: 'reporter', reportId: id, endpoint: 'https://user:secret@example.test/path?secret', source }, runtime);
    assert.equal(record.report_id, id); assert.equal(record.node_version, runtime.version);
    assert.equal(record.exec_path, runtime.execPath); assert.equal(record.platform, platform);
    assert.equal(record.initial_transport, 'https'); assert.equal(record.source_on_disk_sha256, createHash('sha256').update(readFileSync(source)).digest('hex'));
    assert.equal(record.evidence_scope, 'current_process_configuration_only');
    assert.equal(record.ca_selection.environment_present.NODE_OPTIONS, false);
    assert.equal(record.ca_selection.other_exec_arguments_present, false);
    assert.equal(record.ca_selection.build_uses_openssl_ca, false);
    assert.ok(!JSON.stringify(record).includes('secret'));
  }
});

test('CA overrides, preloads and unknown arguments are classified without exporting their values', () => {
  const runtime = fake(); runtime.env = { NODE_OPTIONS: '--require secret-token', NODE_EXTRA_CA_CERTS: '/secret-token.pem',
    SSL_CERT_FILE: 'secret-token', NODE_USE_SYSTEM_CA: 'secret-token', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    AGENTS_UPDATE_BATCH_TOKEN: 'secret-token', OPENAI_API_KEY: 'secret-token' };
  runtime.execArgv = ['--use-system-ca', '--require', 'secret-token'];
  const record = runtimeContext({ consumer: 'updater-node-helper', reportId: 'secret-token', source }, runtime);
  assert.equal(record.report_id, null); assert.equal(record.batch_token, null);
  assert.equal(record.ca_selection.environment_present.NODE_EXTRA_CA_CERTS, true);
  assert.equal(record.ca_selection.environment_present.NODE_OPTIONS, true);
  assert.equal(record.ca_selection.tls_validation, 'disabled');
  assert.equal(record.ca_selection.other_exec_arguments_present, true);
  assert.deepEqual(record.ca_selection.exec_ca_flags, ['--use-system-ca']);
  assert.ok(!JSON.stringify(record).includes('secret-token'));
});

test('recording failure does not fail the operation or invent a successful evidence record', () => {
  const context = { consumer: 'reporter-fragments', reportId: id, endpoint: 'http://example.test', source };
  let output = '';
  assert.equal(logRuntimeContext(context, { runtime: fake(), output: { write: line => { output += line; } } }), true);
  assert.equal(JSON.parse(output.slice(output.indexOf('{'))).initial_transport, 'http');
  assert.equal(logRuntimeContext(context, { output: { write() { throw new Error('closed'); } } }), false);
  assert.equal(runtimeContext({ ...context, source: new URL('./absent', source) }, fake()).source_on_disk_sha256, null);
  assert.throws(() => runtimeContext({ consumer: 'unknown' }, fake()));
});

test('the existing updater lookup preserves stdout and records only its own actual Node process', () => {
  const command = fileURLToPath(new URL('../../bin/factory-deployment-contract.mjs', import.meta.url));
  const home = mkdtempSync(join(tmpdir(), 'runtime-context-'));
  try {
    const result = spawnSync(process.execPath, [command, 'caveat-update-owner'], {
      encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    assert.equal(result.status, 0); assert.equal(result.stdout, 'factory\n');
    const record = JSON.parse(result.stderr.slice(result.stderr.indexOf('{')));
    assert.equal(record.consumer, 'updater-node-helper'); assert.equal(record.exec_path, process.execPath);
    assert.equal(record.node_version, process.version); assert.equal(record.initial_transport, null);
    assert.equal(record.evidence_scope, 'current_process_configuration_only');
  } finally { rmSync(home, { recursive: true, force: true }); }
});


test('a private Windows scheduler log preserves runtime output when Task discards stderr', () => {
  const directory = mkdtempSync(join(tmpdir(), 'runtime-log-')), path = join(directory, 'scheduler.log');
  try {
    writeFileSync(path, 'older\n'); let secured = 0;
    const record = { consumer: 'reporter', reportId: id, source };
    const options = { runtime: fake('win32'), output: { write() {} }, logFile: path,
      secureFile: name => { assert.equal(name, path); assert.equal(readFileSync(path, 'utf8'), 'older\n'); secured++; } };
    assert.equal(logRuntimeContext(record, options), true); assert.equal(secured, 1);
    const lines = readFileSync(path, 'utf8').trim().split('\n'); assert.equal(lines[0], 'older');
    assert.equal(JSON.parse(lines[1].slice(lines[1].indexOf('{'))).report_id, id);
    const before = readFileSync(path, 'utf8');
    assert.equal(logRuntimeContext(record, { ...options, secureFile() { throw new Error('ACL denied'); } }), false);
    assert.equal(readFileSync(path, 'utf8'), before);
    if (process.platform !== 'win32') {
      const outside = join(directory, 'outside'); writeFileSync(outside, 'untouched');
      rmSync(path); symlinkSync(outside, path);
      assert.equal(logRuntimeContext(record, options), false); assert.equal(readFileSync(outside, 'utf8'), 'untouched');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
