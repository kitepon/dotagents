// Dedicated fixture, no normal product setup/probe/output is run.
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createFixedCoreHelperBootstrap } from '../../lib/factory/update-context-core-bootstrap.mjs';
const [activation, expires, bridgeSource] = process.argv.slice(2);
const bootstrap = createFixedCoreHelperBootstrap({ activation, expiresAt: Number(expires) });
let bridge;
if (bridgeSource) {
  // Optional accepted product source in a dedicated integration run only.
  const { createCoreProcessBridge } = await import(pathToFileURL(bridgeSource));
  bridge = createCoreProcessBridge(bootstrap);
} else {
  bridge = { exchange(phase, control, frame) { return new Promise((resolve, reject) => {
    const child = bootstrap.start(Object.freeze({ phase, controlJson: JSON.stringify(control), replyFd: 3, authorityFd: 4, timeoutMs: 2500 }));
    const chunks = []; child.stdio[3].on('data', value => chunks.push(value));
    child.stdout.resume(); child.stderr.resume(); child.on('error', reject);
    child.on('close', code => { try { if (code !== 0) throw new Error('fixture helper failed'); resolve(JSON.parse(Buffer.concat(chunks))); } catch (error) { reject(error); } });
    child.stdin.end(frame);
  }); } };
}
const runtime = { pid: process.pid, ppid: process.ppid, uid: process.getuid(), gid: process.getgid(), cwd: process.cwd(),
  exec_path: process.execPath, process_version: process.version, entry_path: process.argv[1] };
const control = { mode: 'setup', run_id: 'fixture-real-kernel-run', runtime_self: runtime };
const begin = await bridge.exchange('core_begin', control, null);
const frame = Buffer.from('{"fixture":"kernel transport only"}\n');
let result = null;
if (begin.status === 'recorded_raw') {
  const digest = createHash('sha256').update(frame).digest('hex');
  result = await bridge.exchange('core_result', { ...control, core_started_original: begin.original,
    completion: { completed_at_utc_ms: Date.now(), exit_code: 2, serialized_result_sha256: digest,
      serialized_result_bytes: frame.length, stdout_write: 'callback_completed', frame_admission: {
        schema: 'gpt-connector.core-frame-admission.v1', policy: 'setup_v1_private_metadata_v1', decision: 'full_frame', reason: 'accepted',
        frame_sha256: digest, frame_bytes: frame.length } } }, frame);
}
process.stdout.write(JSON.stringify({ begin, result }) + '\n');
