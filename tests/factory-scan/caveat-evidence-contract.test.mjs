import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createPrivateValidator } from '../../lib/factory/evidence/private-contract.mjs';
import { parseStrictJson } from '../../lib/factory/evidence/strict-json.mjs';
import { sha256 } from '../../lib/factory/evidence/report-binding.mjs';

const fixtureUrl = new URL('../fixtures/caveat-private-evidence/', import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, fixtureUrl), 'utf8'));
const fixture = read('contract.v1.json');
const schemas = { capability: read('capability.v1.schema.json'), frame: read('private-frame.v1.schema.json'), windowsChannel: read('windows-channel.v1.schema.json') };
const validator = createPrivateValidator(schemas);
const encoded = (value) => Buffer.from(JSON.stringify(value));
const transcript = (hello, result) => Buffer.from(`${JSON.stringify(hello)}\n${JSON.stringify(result)}\n`);
function context() {
  const hello = structuredClone(fixture.hello), result = structuredClone(fixture.result);
  const process = hello.process;
  const peer = { verified: true, pid: process.pid, parentPid: process.parent_pid, startIdentity: process.start_identity,
    identity: process.identity, execPath: process.exec_path, entryRealpath: process.entry_realpath };
  const request = validator.validateRequest(fixture.request_env);
  const selected = validator.selectCapability(encoded(fixture.synthetic_capability), {
    platform: 'linux', launchPath: 'direct_node_entry', packageVersion: '0.20.3', adapterSupported: true });
  return { hello, result, input: { chunks: [transcript(hello, result)], eof: true, request, selected, peer,
    publicBytes: Buffer.from(fixture.public_bytes_utf8), publicComplete: true } };
}
function changed(mutate) { const c = context(); mutate(c); c.input.chunks = [transcript(c.hello, c.result)]; return c.input; }

test('official Caveat schema and synthetic fixture validate in the collector without changing bytes', () => {
  const c = context(); const before = structuredClone(fixture);
  assert.equal(c.input.request.ok, true); assert.equal(c.input.selected.ok, true);
  assert.equal(validator.validateTranscript(c.input).ok, true);
  assert.deepEqual(fixture, before);
  assert.equal(sha256(c.input.publicBytes), fixture.result.public_output.sha256);
});

test('strict private JSON rejects duplicate/escaped duplicate keys, comments, trailing commas, UTF-8 and budget errors', () => {
  for (const text of ['{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{/*comment*/"a":1}', '{"a":1,}', '', '{} {}', '\ufeff{}']) {
    assert.throws(() => parseStrictJson(Buffer.from(text)), text);
  }
  assert.throws(() => parseStrictJson(Buffer.from([0xc3, 0x28])));
  assert.throws(() => parseStrictJson(Buffer.alloc(16385, 32)));
  assert.deepEqual(parseStrictJson(Buffer.from('{"nested":{"a":1},"a":2}')), { nested: { a: 1 }, a: 2 });
  assert.deepEqual(parseStrictJson(Buffer.from('{"__proto__":{"safe":true}}')), JSON.parse('{"__proto__":{"safe":true}}'));
});

test('OFF request is lazy; incomplete request and remote Windows descriptors are refused', () => {
  const env = { CAVEAT_FACTORY_PRIVATE_EVIDENCE: undefined };
  Object.defineProperty(env, 'CAVEAT_FACTORY_PRIVATE_NONCE', { get() { throw new Error('OFF read'); } });
  assert.equal(validator.validateRequest(env).status, 'off');
  for (const mutate of [
    (x) => { delete x.CAVEAT_FACTORY_PRIVATE_NONCE; },
    (x) => { x.CAVEAT_FACTORY_PRIVATE_NONCE = 'A'.repeat(64); },
    (x) => { x.CAVEAT_FACTORY_PRIVATE_COLLECTION_ID = 'not-a-uuid'; },
    (x) => { x.CAVEAT_FACTORY_PRIVATE_CHANNEL = 'fd:1'; },
    (x) => { x.CAVEAT_FACTORY_PRIVATE_CHANNEL = JSON.stringify({ ...fixture.windows_descriptor, path: '\\\\remote\\pipe\\private' }); },
  ]) { const x = { ...fixture.request_env }; mutate(x); assert.equal(validator.validateRequest(x).ok, false); }
});

test('empty packaged capability, old package, unknown wrapper and unavailable adapter never enable a transport', () => {
  const base = { platform: 'linux', launchPath: 'direct_node_entry', packageVersion: '0.20.3', adapterSupported: true };
  assert.equal(validator.selectCapability(null, base).status, 'not_supported');
  assert.equal(validator.selectCapability(encoded({ ...fixture.synthetic_capability, transports: [] }), base).status, 'not_supported');
  for (const extra of [{ packageVersion: '0.20.4' }, { launchPath: 'unknown_wrapper' }, { platform: 'win32' }, { adapterSupported: false }, { adapterSupported: 'yes' }]) {
    assert.equal(validator.selectCapability(encoded(fixture.synthetic_capability), { ...base, ...extra }).ok, false);
  }
  assert.equal(validator.selectCapability(encoded({ ...fixture.synthetic_capability, secret: 'canary' }), base).ok, false);
});

test('nonce/execution/transport/version/missing reason and peer identity must agree', () => {
  for (const mutate of [
    (c) => { c.result.nonce = 'a'.repeat(64); },
    (c) => { c.hello.nonce = c.result.nonce = 'a'.repeat(64); },
    (c) => { c.result.execution_id = '00000000-0000-4000-8000-000000000099'; },
    (c) => { c.hello.transport = 'windows-named-pipe-v1'; },
    (c) => { c.hello.product_version = '0.20.4'; },
    (c) => { c.hello.process.build_id = null; },
    (c) => { c.input.peer = { ...c.input.peer, verified: false }; },
    (c) => { c.input.peer = { ...c.input.peer, pid: 999 }; },
    (c) => { c.input.peer = { ...c.input.peer, startIdentity: { source: 'os_process_start', value: 'reused-pid' } }; },
    (c) => { c.input.request = { ...c.input.request, transport: 'windows-named-pipe-v1' }; },
  ]) assert.equal(validator.validateTranscript(changed(mutate)).ok, false);
});

test('EOF/order/NDJSON termination and channel byte limit remain independent checks', () => {
  const { hello, result, input } = context();
  for (const extra of [
    ...[false, 1, 'true', 'false', {}, null, undefined].map((eof) => ({ eof })),
    { chunks: [input.chunks[0].subarray(0, -1)] },
    { chunks: [transcript(result, hello)] },
    { chunks: [Buffer.concat([input.chunks[0], encoded(hello), Buffer.from('\n')])] },
    { chunks: [Buffer.alloc(16385, 32)] }, { chunks: [Buffer.from([0xc3, 0x28, 10])] }, { chunks: null },
  ]) assert.equal(validator.validateTranscript({ ...input, ...extra }).ok, false);
  assert.equal(validator.validateTranscript({ ...input, eof: false }).status, 'partial');
});

test('public hash/framing/result and reason/HEAD/algorithm are checked without repairing the public result', () => {
  for (const mutate of [
    (c) => { c.result.public_output.sha256 = 'a'.repeat(64); },
    (c) => { c.result.public_result.planned_exit_code = 0; },
    (c) => { c.result.sync_observation.comparison = 'equal'; },
    (c) => { c.result.sync_observation.repo_identity.algorithm = 'origin-host-path-sha256-v1'; },
    (c) => { c.result.sync_observation.repo_identity.reason_code = 'origin_descriptor_observed'; },
    (c) => { c.result.sync_observation.local_head.value = null; },
    (c) => { c.result.operation_receipt = { status: 'available', receipt: {} }; },
  ]) assert.equal(validator.validateTranscript(changed(mutate)).ok, false);
  const c = context();
  for (const publicComplete of [false, 1, 'true', 'false', {}, null, undefined])
    assert.equal(validator.validateTranscript({ ...c.input, publicComplete }).status, 'partial');
  assert.equal(validator.validateTranscript({ ...c.input, publicBytes: Buffer.from('changed\n') }).ok, false);
  const pub = JSON.parse(fixture.public_bytes_utf8); pub.product = 'other';
  const raw = Buffer.from(JSON.stringify(pub) + '\n');
  c.result.public_output = { bytes: raw.length, sha256: sha256(raw) };
  assert.equal(validator.validateTranscript({ ...c.input, chunks: [transcript(c.hello, c.result)], publicBytes: raw }).ok, false);
});

test('UTF-8 split chunks and verified Windows synthetic peer work without opening a pipe', () => {
  const c = context(); c.hello.process.exec_path = '/fixture/ノード';
  c.input.peer = { ...c.input.peer, execPath: c.hello.process.exec_path };
  const raw = transcript(c.hello, c.result), split = raw.indexOf(Buffer.from('ノ')) + 1;
  assert.equal(validator.validateTranscript({ ...c.input, chunks: [raw.subarray(0, split), raw.subarray(split)] }).ok, true);
  const cap = structuredClone(fixture.synthetic_capability);
  cap.transports = [{ id: 'windows-named-pipe-v1', platforms: ['win32'], launch_paths: ['powershell_standard_shim'] }];
  const hello = structuredClone(fixture.hello); hello.transport = 'windows-named-pipe-v1';
  hello.process.start_identity = { source: 'windows_process_creation', value: 'fixture-start' };
  hello.process.identity = { kind: 'windows_sid', uid: null, gid: null, sid: fixture.windows_descriptor.owner_sid };
  const request = validator.validateRequest({ ...fixture.request_env, CAVEAT_FACTORY_PRIVATE_CHANNEL: JSON.stringify(fixture.windows_descriptor) });
  const selected = validator.selectCapability(encoded(cap), { platform: 'win32', launchPath: 'powershell_standard_shim', packageVersion: '0.20.3', adapterSupported: true });
  const peer = { verified: true, pid: hello.process.pid, parentPid: hello.process.parent_pid,
    startIdentity: hello.process.start_identity, identity: hello.process.identity, execPath: hello.process.exec_path, entryRealpath: hello.process.entry_realpath };
  assert.equal(validator.validateTranscript({ ...c.input, chunks: [transcript(hello, fixture.result)], request, selected, peer }).ok, true);
  const server = { pid: 1200, startIdentity: 'fixture-server-start', sid: fixture.windows_descriptor.owner_sid };
  assert.equal(validator.checkWindowsDescriptor(encoded(fixture.windows_descriptor), server).ok, true);
  assert.equal(validator.checkWindowsDescriptor(encoded(fixture.windows_descriptor), { ...server, startIdentity: 'pid-reused' }).ok, false);
});
