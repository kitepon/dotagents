// Factory-owned fixed launch port; source composition only, no CLI activation.
import { spawn } from 'node:child_process';
import { fstatSync, realpathSync } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
const HELPER = fileURLToPath(new URL('../../bin/factory-update-context-observer.py', import.meta.url));
const PYTHON = '/usr/bin/python3';

/** Original fd4 must be inherited from the factory; this port creates no authority. */
export function createFixedCoreHelperBootstrap({ activation, expiresAt }) {
  if (process.platform !== 'linux' || !isAbsolute(activation) || normalize(activation) !== activation
    || realpathSync(activation) !== activation || !Number.isSafeInteger(expiresAt)
    || expiresAt <= Date.now() || expiresAt > Date.now() + 48 * 3600000 || !fstatSync(4).isSocket())
    throw new Error('core_bootstrap_scope_unconfirmed');
  const entry = realpathSync(process.argv[1]);
  return Object.freeze({ start(invocation) {
    if (!invocation || !['core_begin', 'core_result'].includes(invocation.phase)
      || typeof invocation.controlJson !== 'string' || Buffer.byteLength(invocation.controlJson) > 16384
      || invocation.replyFd !== 3 || invocation.authorityFd !== 4 || invocation.timeoutMs !== 2500)
      throw new Error('core_bootstrap_invocation_invalid');
    // No parsing/reserializing control, selecting code, creating a private root,
    // reading credentials or accepting a caller-specified verifier.
    return spawn(PYTHON, ['-I', '-S', HELPER, '--phase', invocation.phase,
      '--parent-pid', String(process.pid), '--entry', entry, '--output-dir', activation,
      '--expires-at', String(expiresAt), '--core-control-json', invocation.controlJson, '--core-authority'],
    { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 4], cwd: process.cwd() });
  } });
}
