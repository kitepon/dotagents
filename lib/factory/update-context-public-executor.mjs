// Explicit source-owned composition. No default issuer, runtime resolver or CLI ON.
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { withCoreAuthoritySources } from './core-authority-sources.mjs';
import { preparePublicCoreBootstrap } from './update-context-observer.mjs';
import { encodeCorePreloadRecord } from './update-context-preload-record.mjs';
import { createOriginalNodeAuthorityBroker } from './update-context-node-broker.mjs';
const PRELOAD = fileURLToPath(new URL('./update-context-product-preload.mjs', import.meta.url));
const hash = raw => createHash('sha256').update(raw).digest('hex');
const fail = () => { throw new Error('public_core_execution_unconfirmed'); };
function packet(bytes) { return { path: bytes.path, bytes: bytes.bytes, sha256: bytes.sha256 }; }
function manifest(subject) {
  const original = subject.source_original, raw = Buffer.from(original.bytes_base64, 'base64');
  if (raw.length !== original.bytes || hash(raw) !== original.sha256) fail();
  const bundle = JSON.parse(raw), bytes = Buffer.from(bundle.capture.manifest_bytes_base64, 'base64');
  if (hash(bytes) !== bundle.capture.manifest_sha256) fail();
  return JSON.parse(bytes).files;
}
function boundFile(rows, role, expectedPath) {
  const entries = rows.filter(row => row.role === role);
  if (entries.length !== 1 || entries[0].path !== expectedPath || realpathSync(expectedPath) !== expectedPath) fail();
  const raw = readFileSync(expectedPath); if (hash(raw) !== entries[0].sha256) fail();
  return { path: expectedPath, bytes: raw.length, sha256: entries[0].sha256 };
}
/** resolveInstalledLaunch is an adopted original runtime/entry selection port,
 * not a boolean verifier. It has no implementation/default here. The caller
 * must bind its actual node selection and all mutation resources/participants.
 * Missing real ports retain the original setup once, outside these SH leases.
 */
export function createPublicCoreExecutor({ definitions, resolveInstalledLaunch, evidenceKind = 'observed' }) {
  const resolveLaunch = typeof resolveInstalledLaunch === 'function' ? resolveInstalledLaunch.bind(null) : null;
  let used = false;
  return async function executePublicCore(supplied) {
    if (used) fail(); used = true; // Reserve before getters/external readers can reenter.
    const { command, before, execute } = supplied;
    const args = structuredClone(supplied.args), options = structuredClone(supplied.options);
    // Preserve the original invocation environment before any verifier/loader.
    if (!Object.hasOwn(options, 'env')) options.env = { ...process.env };
    let normal, brokerDone, childStarted = false, ownsChannel = false;
    const once = extra => {
      if (normal) fail();
      const reserved = Promise.withResolvers(); normal = reserved.promise;
      try { Promise.resolve(execute(command, args, { ...options, ...extra })).then(reserved.resolve, reserved.reject); }
      catch (error) { reserved.reject(error); }
      return normal;
    };
    try {
      if (process.platform !== 'linux' || command !== 'gpt-connector' || JSON.stringify(args) !== '["setup"]'
        || !resolveLaunch || before?.status !== 'recorded_raw' || !fstatSync(5).isSocket() || !fstatSync(6).isSocket()) fail();
      ownsChannel = true;
      await withCoreAuthoritySources(definitions, async verify => {
        const subjects = await verify();
        const launch = structuredClone(await resolveLaunch(structuredClone(subjects)));
        if (!launch || realpathSync(launch.nodeExecutable) !== launch.nodeExecutable) fail();
        const productRows = manifest(subjects.product), factoryRows = manifest(subjects.factory);
        const entry = boundFile(productRows, 'core', launch.productEntry);
        const registration = boundFile(productRows, 'core_registration', launch.registrationModule);
        const preload = boundFile(factoryRows, 'public_preload', PRELOAD);
        const prepared = preparePublicCoreBootstrap(before);
        if (prepared.status !== 'recorded_raw') fail();
        const record = encodeCorePreloadRecord({ schema: 'dotagents.core-preload.v1', activation: prepared.activation,
          expires_at: prepared.expiresAt, before_original: prepared.beforeOriginal,
          product_entry: packet(entry), registration: packet(registration), factory_preload: packet(preload) });
        const spawnChild = (_command, _args, original) => {
          if (childStarted) fail(); childStarted = true;
          const child = spawn(launch.nodeExecutable, ['--import', PRELOAD, entry.path, ...args], {
            ...original, stdio: [original.stdio[0], original.stdio[1], original.stdio[2], 'ignore', 6, 'ignore', 'ignore', 'pipe'],
          });
          // After spawn, private broker/pipe errors must not orphan/retry the
          // ordinary child or bypass its original executor settlement.
          try { closeSync(6); } catch {}
          try {
            const broker = createOriginalNodeAuthorityBroker({ productPid: child.pid, productEntry: entry.path,
              activation: prepared.activation, expiresAt: prepared.expiresAt, beforeRef: prepared.beforeOriginal,
              verifySubjects: verify, evidenceKind });
            brokerDone = (async () => {
              try { const first = await broker.serveOnce(); if (first === 'verified') await broker.serveOnce(); }
              catch { /* Private observation unknown; preserve the ordinary result. */ }
            })();
          } catch { brokerDone = Promise.resolve(); }
          try { child.stdio[7].on('error', () => {}); child.stdio[7].end(record); }
          catch { /* No second record, child, setup or fallback after spawn. */ }
          return child;
        };
        try { return await once({ spawnChild }); }
        finally { if (brokerDone) await brokerDone; }
      });
    } catch { /* Source/lease/loader failure never retries an already-started setup. */ }
    finally {
      if (ownsChannel) for (const fd of [5, 6]) { try { closeSync(fd); } catch {} }
    }
    // Awaited lease cleanup completed before any ordinary fallback can mutate.
    return normal ? await normal : await once({});
  };
}
