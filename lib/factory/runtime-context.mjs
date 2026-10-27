import process from 'node:process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const CA_FLAGS = ['--use-bundled-ca', '--use-openssl-ca', '--use-system-ca', '--no-use-system-ca'];
const CA_ENV = ['NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'OPENSSL_CONF', 'NODE_PATH', 'NODE_USE_ENV_PROXY', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'];
const CONSUMERS = new Set(['reporter', 'reporter-fragments', 'updater-node-helper', 'updater-release-lookup']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function runtimeContext({ consumer, reportId = null, endpoint = null, source }, runtime = process) {
  if (!CONSUMERS.has(consumer)) throw new Error('unknown runtime context consumer');
  let transport = null;
  try { const protocol = new URL(endpoint).protocol; if (['http:', 'https:'].includes(protocol)) transport = protocol.slice(0, -1); } catch {}
  let sourceHash = null;
  try { sourceHash = createHash('sha256').update(readFileSync(source)).digest('hex'); } catch {}
  const present = name => typeof runtime.env[name] === 'string' && runtime.env[name].length > 0;
  return {
    schema: 'dotagents.runtime-context.v1', observed_at: new Date().toISOString(), consumer,
    report_id: UUID.test(reportId ?? '') ? reportId : null,
    batch_token: UUID.test(runtime.env.AGENTS_UPDATE_BATCH_TOKEN ?? '') ? runtime.env.AGENTS_UPDATE_BATCH_TOKEN : null,
    pid: runtime.pid, exec_path: runtime.execPath, node_version: runtime.version, platform: runtime.platform,
    initial_transport: transport, source_on_disk_sha256: sourceHash,
    ca_selection: {
      environment_present: Object.fromEntries(CA_ENV.map(name => [name, present(name)])),
      exec_ca_flags: CA_FLAGS.filter(flag => runtime.execArgv.includes(flag)),
      other_exec_arguments_present: runtime.execArgv.some(flag => !CA_FLAGS.includes(flag)),
      build_uses_openssl_ca: typeof runtime.config?.variables?.node_use_openssl_ca === 'boolean'
        ? runtime.config.variables.node_use_openssl_ca : null,
      tls_validation: runtime.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ? 'disabled'
        : present('NODE_TLS_REJECT_UNAUTHORIZED') ? 'configured' : 'default',
    },
    evidence_scope: 'current_process_configuration_only',
  };
}

// The current process records its own selection; no certificate store, child process, or TLS probe is inspected.
export function logRuntimeContext(context, { runtime = process, output = process.stderr, logFile = null, secureFile = null } = {}) {
  try {
    const line = `[dotagents-runtime-context] ${JSON.stringify(runtimeContext(context, runtime))}\n`;
    output.write(line);
    if (logFile) {
      const parent = lstatSync(dirname(logFile));
      if (parent.isSymbolicLink() || !parent.isDirectory()) throw new Error('unsafe log directory');
      try { const prior = lstatSync(logFile); if (prior.isSymbolicLink() || !prior.isFile() || prior.nlink !== 1) throw new Error('unsafe log file'); }
      catch (error) { if (error?.code !== 'ENOENT') throw error; }
      const fd = openSync(logFile, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try {
        const held = fstatSync(fd), named = lstatSync(logFile);
        if (!held.isFile() || held.nlink !== 1 || named.isSymbolicLink() || held.dev !== named.dev || held.ino !== named.ino) throw new Error('log file changed');
        secureFile?.(logFile);
        writeFileSync(fd, line);
      } finally { closeSync(fd); }
    }
    return true;
  } catch { return false; }
}
