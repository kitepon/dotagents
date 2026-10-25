// Original factory Node owns socket response credentials. Source composition only.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fstatSync, readFileSync, writeSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const READER = fileURLToPath(new URL('../../bin/factory-core-authority-receiver.py', import.meta.url));
const MAX = 131072;
const digest = value => createHash('sha256').update(value).digest('hex');
function identity(pid) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/u);
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const ids = name => status.split('\n').find(line => line.startsWith(`${name}:`)).split(/\s+/u).slice(1).filter(Boolean).map(Number);
  return { pid, ppid: Number(fields[1]), start_ticks: Number(fields[19]), uid_fields: ids('Uid'), gid_fields: ids('Gid') };
}
function unchanged(expected) {
  const measured = identity(expected.pid);
  return Object.keys(measured).every(key => JSON.stringify(measured[key]) === JSON.stringify(expected[key]));
}
function receive(scope) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-I', '-S', READER, JSON.stringify(scope)], { stdio: ['ignore', 'pipe', 'pipe', 'ignore', 5] });
    const chunks = []; let count = 0, done = false;
    const fail = () => { if (done) return; done = true; child.kill('SIGKILL'); reject(new Error('core_kernel_reader_unconfirmed')); };
    const timer = setTimeout(fail, 2200);
    child.on('error', fail); child.stdout.on('error', fail); child.stderr.on('error', fail);
    child.stderr.resume();
    child.stdout.on('data', chunk => { count += chunk.length; if (count > MAX) fail(); else chunks.push(Buffer.from(chunk)); });
    child.on('close', (code, signal) => {
      clearTimeout(timer); if (done) return; done = true;
      try {
        if (code !== 0 || signal !== null) throw new Error();
        const raw = Buffer.concat(chunks);
        if (!raw.length || raw.at(-1) !== 10) throw new Error();
        const receipt = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
        if (receipt.schema !== 'dotagents.core-kernel-receipt.v1' || receipt.status !== 'kernel_bound'
          || !/^[0-9a-f]{64}$/u.test(receipt.request_sha256) || !/^[0-9a-f]{64}$/u.test(receipt.challenge)) throw new Error();
        resolve(receipt);
      } catch { reject(new Error('core_kernel_reader_unconfirmed')); }
    });
  });
}

/** Fixed fd5 is the factory endpoint from exec_original_factory. The product
 * receives only fd6 -> its fd4. Actual issuer/verifier ports have no default.
 */
export function createOriginalNodeAuthorityBroker({ productPid, productEntry, activation, expiresAt, beforeRef,
  verifySubjects, evidenceKind = 'observed' }) {
  if (process.platform !== 'linux' || !fstatSync(5).isSocket() || !['fixture', 'observed'].includes(evidenceKind))
    throw new Error('core_node_broker_scope_unconfirmed');
  const own = identity(process.pid);
  const fixed = structuredClone({ product_pid: productPid, product_entry: productEntry,
    activation, expires_at: expiresAt, before_ref: beforeRef });
  let next = 'core_begin', run = null, busy = false;
  const challenges = new Set();
  return Object.freeze({ async serveOnce() {
    if (busy || next === null) throw new Error('core_node_broker_order_invalid');
    busy = true;
    let receipt;
    try {
      receipt = await receive({ ...fixed, phase: next, run });
      const binding = receipt.binding;
      if (challenges.has(receipt.challenge) || receipt.sender?.pid !== process.pid || !unchanged(receipt.sender)
        || !unchanged(receipt.helper) || !unchanged(receipt.product) || !unchanged(own)
        || binding.phase !== next || binding.factory_identity?.split(':')[1] !== String(process.pid))
        throw new Error('core_node_kernel_binding_unconfirmed');
      challenges.add(receipt.challenge);
      if (run && (run[0] !== binding.run_id || run[1] !== binding.mode)) throw new Error('core_node_run_mismatch');
      run = [binding.run_id, binding.mode]; next = next === 'core_begin' ? 'core_result' : null;
      let response;
      try {
        if (typeof verifySubjects !== 'function') throw new Error();
        const subjects = structuredClone(await verifySubjects(structuredClone(binding)));
        if (!subjects || Object.keys(subjects).sort().join(',') !== 'factory,product'
          || !unchanged(receipt.helper) || !unchanged(receipt.product) || !unchanged(own)
          || digest(readFileSync(productEntry)) !== binding.entry.sha256) throw new Error();
        response = { status: 'verified', kind: evidenceKind, binding, subjects };
      } catch { response = { status: 'unknown', reason: 'node_verifier_unconfirmed' }; }
      response = { schema: 'dotagents.core-authority-response.v1', request_sha256: receipt.request_sha256, ...response };
      let bytes = Buffer.from(JSON.stringify(response));
      if (bytes.length > MAX) {
        response = { schema: response.schema, request_sha256: receipt.request_sha256, status: 'unknown', reason: 'node_authority_response_too_large' };
        bytes = Buffer.from(JSON.stringify(response));
      }
      // This write occurs in the original Node process. The receiver never
      // writes a socket response; SCM_CREDENTIALS therefore remains own.pid.
      if (writeSync(5, bytes) !== bytes.length) throw new Error('core_node_response_short_write');
      return response.status;
    } finally { busy = false; }
  } });
}
