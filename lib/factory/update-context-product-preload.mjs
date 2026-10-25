// Explicit fixed factory --import only. The normal product CLI never loads it.
import { createReadStream, fstatSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decodeCorePreloadRecord } from './update-context-preload-record.mjs';
import { createFixedCoreHelperBootstrap } from './update-context-core-bootstrap.mjs';
function readRecord() {
  return new Promise((resolve, reject) => {
    let stream, count = 0, done = false; const chunks = [];
    const finish = (error, bytes) => { if (done) return; done = true; clearTimeout(timer); stream?.destroy(); error ? reject(error) : resolve(bytes); };
    const timer = setTimeout(() => finish(new Error('core_preload_unconfirmed')), 1500);
    try {
      const info = fstatSync(7); if (!info.isSocket() && !info.isFIFO()) throw new Error();
      stream = createReadStream(null, { fd: 7, autoClose: true });
      stream.on('data', chunk => { count += chunk.length; if (count > 16384) finish(new Error('core_preload_unconfirmed')); else chunks.push(Buffer.from(chunk)); });
      stream.on('error', () => finish(new Error('core_preload_unconfirmed')));
      stream.on('end', () => finish(null, Buffer.concat(chunks)));
    } catch { finish(new Error('core_preload_unconfirmed')); }
  });
}
try {
  const record = decodeCorePreloadRecord(await readRecord());
  // Exact file URL identity also used by cli's relative registration import.
  const registration = await import(pathToFileURL(record.registration.path).href);
  if (typeof registration.registerCoreHelperBootstrap !== 'function') throw new Error();
  registration.registerCoreHelperBootstrap(createFixedCoreHelperBootstrap({ activation: record.activation, expiresAt: record.expires_at }));
} catch {
  // No authority/default registration and no replacement of ordinary body/exit.
}
