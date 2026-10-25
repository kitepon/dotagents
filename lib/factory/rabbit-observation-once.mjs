// Rabbit-only one-capture/one-send budget. No permission or host receipt default.
import { constants, openSync, closeSync, fstatSync, lstatSync, realpathSync, readFileSync, writeSync, fsyncSync, linkSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { DEFAULT_GPT_OBSERVATION_ENTRY, createGptObservationEntry } from './gpt-observation-entry.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value)}\n`);
const fail = () => { throw new Error('rabbit_observation_gate_unconfirmed'); };
const group = report => [...(report?.products?.['gpt-connector']?.checks ?? []), ...(report?.products?.['gpt-connector']?.runtime_errors ?? [])]
  .some(item => Object.keys(item.safe_context ?? {}).length > 0);
const fixedScope = JSON.parse(readFileSync(new URL('./rabbit-observation-scope.json', import.meta.url)));

/** An approved local original is an operator-supplied fact, not an independent
 * proof of Owner approval. It is published only after the scope is approved,
 * actual principal/source/path readback matches and product supply completes.
 */
export function createRabbitObservationOnce(supplied, { clock = Date.now, uid = () => process.getuid?.(), platform = () => process.platform } = {}) {
  const scope = structuredClone(supplied), scopeSha = hash(json(scope)), root = scope.state_directory;
  const active = () => clock() >= Date.parse(scope.window.start) && clock() <= Date.parse(scope.window.end);
  const own = () => platform() === 'linux' && uid() === scope.principal.uid;
  const controlled = report => report?.host_id === scope.host_id && report?.report_id === scope.report_id;
  function parent() {
    try {
      const info = lstatSync(root);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== scope.principal.uid || (info.mode & 0o777) !== 0o700 || realpathSync(root) !== root) fail();
    } catch { fail(); }
  }
  function read(name, maximum = 65536) {
    let fd;
    try {
      parent();
      fd = openSync(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== scope.principal.uid || (info.mode & 0o777) !== 0o600 || info.size > maximum) fail();
      const raw = readFileSync(fd); if (raw.length > maximum) fail(); return raw;
    } catch { fail(); }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  function once(name, raw) {
    parent();
    let fd;
    try { fd = openSync(join(root, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') return false; fail(); }
    try {
      let cursor = 0; while (cursor < raw.length) { const count = writeSync(fd, raw, cursor, raw.length - cursor); if (count <= 0) fail(); cursor += count; }
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    if (!read(name, Math.max(65536, scope.max_report_bytes)).equals(raw)) fail();
    return true;
  }
  function permit() {
    if (!own()) return null;
    try {
      const p = JSON.parse(read('approved-permit.json'));
      if (p.schema !== 'dotagents.rabbit-observation-permit.v1' || p.status !== 'approved' || p.scope_sha256 !== scopeSha
        || !/^K-[A-Z0-9]{6,12}$/u.test(p.owner_decision_ref ?? '') || !/^[a-f0-9]{40}$/u.test(p.factory_revision ?? '')
        || p.host_readback?.host_id !== scope.host_id || p.host_readback?.product_id !== scope.product_id
        || p.host_readback?.principal_user !== scope.principal.user || p.host_readback?.principal_uid !== scope.principal.uid
        || p.host_readback?.factory_checkout !== scope.factory_checkout.path || p.host_readback?.factory_revision !== p.factory_revision
        || p.host_readback?.state_directory !== root || p.host_readback?.image_kind !== 'native_no_container'
        || !p.host_readback?.receipt_ref || !/^[a-f0-9]{64}$/u.test(p.host_readback?.receipt_sha256 ?? '')
        || p.product_supply?.host_id !== scope.host_id || p.product_supply?.status !== 'supplied'
        || p.product_supply?.version !== scope.package.version || p.product_supply?.tarball_sha256 !== scope.package.tarball_sha256
        || !/^[a-f0-9]{64}$/u.test(p.product_supply?.receipt_sha256 ?? '') || !p.product_supply?.receipt_ref
        || !Number.isFinite(Date.parse(p.product_supply.completed_at)) || !Number.isFinite(Date.parse(p.product_supply.confirmed_at))
        || Date.parse(p.product_supply.completed_at) > Date.parse(scope.package_window.install_complete_by)
        || Date.parse(p.product_supply.completed_at) < Date.parse(scope.package_window.start)
        || Date.parse(p.product_supply.confirmed_at) < Date.parse(p.product_supply.completed_at)
        || Date.parse(p.product_supply.confirmed_at) >= Date.parse(scope.package_window.receipt_confirmed_before)
        || p.max_opt_in_calls !== 1 || p.max_send_attempts !== 1) return null;
      const entry = createGptObservationEntry(p.readiness);
      return entry.enabled && p.readiness.central_release.ref.includes(scope.central_revision)
        && p.readiness.product_cli_adoption.ref === p.product_supply.receipt_ref
        && p.readiness.factory_entry_adoption.ref.includes(p.factory_revision) ? { ...p, entry } : null;
    } catch { return null; }
  }
  function validateControlled(report, p) {
    if (!p || !controlled(report) || report.host_profile !== 'linux'
      || Date.parse(report.observed_at) < Date.parse(scope.window.start) || Date.parse(report.observed_at) > Date.parse(scope.window.end)
      || report.products?.['gpt-connector']?.installed_version !== scope.package.version
      || typeof report.reporter?.dotagents_revision !== 'string' || report.reporter.dotagents_revision.length < 7
      || !p.factory_revision.startsWith(report.reporter.dotagents_revision)) fail();
    const claim = JSON.parse(read('capture.claim.json'));
    if (claim.scope_sha256 !== scopeSha || claim.report_id !== scope.report_id) fail();
    p.entry.validateReport(report);
  }
  function validate(report, bytes) {
    if (!controlled(report)) return DEFAULT_GPT_OBSERVATION_ENTRY.validateReport(report);
    const p = permit();
    if (!p) fail();
    validateControlled(report, p);
    const original = read('captured-report.json', scope.max_report_bytes);
    if (bytes && !original.equals(bytes)) fail();
    if (!bytes && JSON.stringify(JSON.parse(original)) !== JSON.stringify(report)) fail();
    return report;
  }
  return Object.freeze({ scope: structuredClone(scope), scopeSha, isControlled: controlled,
    begin(hostId) {
      if (hostId !== scope.host_id || !own() || !active()) return null;
      const p = permit(); if (!p) return null;
      if (!once('capture.claim.json', json({ schema: 'dotagents.rabbit-capture-claim.v1', scope_sha256: scopeSha,
        report_id: scope.report_id, host_id: scope.host_id, claimed_at: new Date(clock()).toISOString(), owner_decision_ref: p.owner_decision_ref }))) return null;
      return Object.freeze({ reportId: scope.report_id, entry: p.entry });
    },
    finish(report, bytes) {
      const p = permit(); validateControlled(report, p);
      if (bytes.length > scope.max_report_bytes || !bytes.equals(json(report))) fail();
      if (!once('captured-report.json', bytes)) fail();
      return { report_id: scope.report_id, body_sha256: hash(bytes), bytes: bytes.length, group_present: group(report) };
    },
    validateReport: validate,
    async readReport(file) {
      const bytes = readFileSync(file); let report;
      try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('report JSONが不正です'); }
      validate(report, bytes); return { bytes, report };
    },
    claimSend(report, bytes) {
      if (!controlled(report)) return true;
      validate(report, bytes);
      if (!active()) return false;
      return once('send.claim.json', json({ schema: 'dotagents.rabbit-send-claim.v1', scope_sha256: scopeSha,
        report_id: scope.report_id, body_sha256: hash(bytes), reserved_at: new Date(clock()).toISOString(), max_send_attempts: 1 }));
    },
    recordSend(report, bytes, { httpStatus = null, accepted = false } = {}) {
      if (!controlled(report)) return;
      validate(report, bytes);
      once('send.result.json', json({ schema: 'dotagents.rabbit-send-result.v1', report_id: scope.report_id,
        body_sha256: hash(bytes), http_status: httpStatus, accepted: accepted === true, observed_at: new Date(clock()).toISOString() }));
    },
    holdOutbox(report, file) {
      if (!controlled(report) || basename(file) !== `${scope.report_id}.json` || dirname(file) !== join(dirname(root), 'outbox')) fail();
      parent(); const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.uid !== scope.principal.uid || (info.mode & 0o777) !== 0o600) fail();
      const target = join(root, 'held-outbox.json'), original = readFileSync(file);
      try { linkSync(file, target); } catch (error) { if (error.code !== 'EEXIST') fail(); }
      if (!read('held-outbox.json', scope.max_report_bytes * 2).equals(original)) fail();
      const held = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(held); } finally { closeSync(held); }
      const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      unlinkSync(file);
      const queue = openSync(dirname(file), constants.O_RDONLY | constants.O_DIRECTORY);
      try { fsyncSync(queue); } finally { closeSync(queue); }
    },
  });
}
export const RABBIT_OBSERVATION_ONCE = createRabbitObservationOnce(fixedScope);
