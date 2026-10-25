import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('../../bin/factory-update-context-observer.py', import.meta.url));
const INPUTS = ['HOME', 'PATH', 'PWD', 'SHELL', 'NVM_DIR', 'AGENTS_UPDATE_PATH_PREFIX',
  'XDG_STATE_HOME', 'XDG_CONFIG_HOME', 'BASH_ENV', 'ENV', 'NVM_SYMLINK_CURRENT', 'NVM_CD_FLAGS', 'MANPATH'];

// Observes this existing factory bridge process. The product core must provide
// its own same-run original; this process is never substituted for that core.
export function observePublicSetup(phase, { result, startedAt, endedAt } = {}) {
  if (process.env.DOTAGENTS_UPDATE_CONTEXT_OBSERVER !== '1') return;
  try {
    const args = [HELPER, '--phase', phase, '--parent-pid', String(process.pid), '--entry', process.argv[1] || '',
      '--output-dir', process.env.DOTAGENTS_UPDATE_CONTEXT_DIR || '',
      '--expires-at', process.env.DOTAGENTS_UPDATE_CONTEXT_EXPIRES_AT || '0',
      '--runtime-exec-path', process.execPath, '--runtime-version', process.version,
      '--resolution', 'node', 'missing', 'v:', '--resolution', 'npm', 'missing', 'v:'];
    for (const key of INPUTS) {
      const present = Object.hasOwn(process.env, key);
      args.push('--input', key, present ? 'yes' : 'no', present ? 'yes' : 'no', `v:${present ? process.env[key] : ''}`);
    }
    if (result) {
      if (Number.isInteger(result.code) && result.code >= 0 && result.code <= 255) args.push('--operation-exit', String(result.code));
      args.push('--result-sha256', createHash('sha256').update(result.stdout ?? '').digest('hex'));
    }
    if (Number.isSafeInteger(startedAt) && Number.isSafeInteger(endedAt)) {
      args.push('--operation-start', `${Math.floor(startedAt / 1000)}.${String(startedAt % 1000).padStart(3, '0')}000`,
        '--operation-end', `${Math.floor(endedAt / 1000)}.${String(endedAt % 1000).padStart(3, '0')}000`);
    }
    const child = spawnSync('/usr/bin/python3', args, { encoding: 'utf8', timeout: 2500, maxBuffer: 16384 });
    if (child.stderr) process.stderr.write(child.stderr);
    if (child.error || child.status !== 0) process.stderr.write(`WARN: update-context-observer phase=${phase} capture unavailable; ordinary setup result retained\n`);
  } catch {
    process.stderr.write(`WARN: update-context-observer phase=${phase} capture failed; ordinary setup result retained\n`);
  }
}
