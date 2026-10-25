import { AssertionError } from 'node:assert';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run } from './command.mjs';
import { diagnosticDescriptor } from './caveat-product/diagnostic-descriptor.mjs';

const COLLECTOR = fileURLToPath(new URL('./caveat-product/read-host.cjs', import.meta.url));
const sha = (text) => createHash('sha256').update(text).digest('hex');
// プロパティ順や採取時刻はidentityではない。設定本文は製品collectorだけが読む。
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function identity(value) {
  return JSON.stringify(canonical({ command: value.command, args: value.args, installed_version: value.installed_version,
    entry: value.entry, deployment_revision: value.deployment_revision,
    registered_harnesses: [...value.registered_harnesses].sort((a, b) => a.name.localeCompare(b.name)) }));
}

// These are fixed labels emitted by the hash-pinned product selector, not
// messages supplied by configuration. Unknown exceptions never export text.
const SELECTOR_REJECTIONS = new Set(['four_clients_required', 'managed_metadata_refused',
  'selected_payload_conflict', 'pointer_changed', 'registration_missing',
  'registration_disabled', 'registration_unparsed', 'registration_arguments_conflict',
  'registration_changed', 'registered_payload_conflict', 'registered_entry_conflict',
  'registered_runtime_conflict', 'registered_command_not_node',
  'unverified_selected_payload', 'selected_version_mismatch']);
const COLLECTOR_REASONS = new Set(['spawn', 'exit', 'timeout', 'output_limit']);
const SPAWN_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC', 'EIO', 'EMFILE', 'ENFILE', 'ENOMEM', 'EAGAIN']);
function selectorRejection(error) {
  if (!(error instanceof AssertionError)) return 'selector_failed';
  const label = error.message.split('\n', 1)[0];
  return SELECTOR_REJECTIONS.has(label) ? label : 'selector_rejected';
}
function collectorReceipt(result) {
  const digest = (value) => typeof value === 'string'
    ? { bytes: Buffer.byteLength(value), sha256: sha(value) } : null;
  return { status: result?.ok === true ? 'success' : 'failed',
    exit_code: Number.isInteger(result?.code) && result.code >= 0 && result.code <= 255 ? result.code : null,
    reason: result?.ok === true ? null : COLLECTOR_REASONS.has(result?.reason) ? result.reason : 'collector_failed',
    spawn_code: SPAWN_CODES.has(result?.error?.code) ? result.error.code : null,
    stdout: digest(result?.stdout), stderr: digest(result?.stderr) };
}

export function createCaveatDiagnosticPort({ node = process.execPath, collectInventory } = {}) {
  let evidence = null;
  async function descriptor(runCommand, cwd) {
    const trace = { source: collectInventory ? 'injected_inventory' : 'product_collector',
      status: 'failed', phase: 'collector_execute', reason_code: null, collector: null };
    const failed = (phase, reason) => ({ descriptor: null, trace: { ...trace, phase, reason_code: reason } });
    let inventory;
    if (collectInventory) {
      try { inventory = await collectInventory(); }
      catch { return failed('inventory_source', 'inventory_source_failed'); }
    } else {
      let result;
      try { result = await runCommand(node, [COLLECTOR], { cwd, maxOutputBytes: 4 * 1024 * 1024 }); }
      catch { return failed('collector_execute', 'collector_invocation_failed'); }
      trace.collector = collectorReceipt(result);
      if (!result?.ok) return failed('collector_execute', 'collector_' + trace.collector.reason);
      try { inventory = JSON.parse(result.stdout); }
      catch { return failed('collector_json', 'collector_json_invalid'); }
    }
    let selected;
    // Product code owns selection; factory records only its fixed rejection label.
    try { selected = diagnosticDescriptor(inventory); }
    catch (error) { return failed('selector', selectorRejection(error)); }
    try { selected = structuredClone(selected); }
    catch { return failed('descriptor_clone', 'descriptor_clone_failed'); }
    return { descriptor: selected, trace: { ...trace, status: 'ready', phase: 'descriptor_ready', reason_code: null } };
  }
  const port = async ({ cwd, runCommand = run }) => {
    const beforeRead = await descriptor(runCommand, cwd);
    const before = beforeRead.descriptor;
    if (!before) {
      evidence = { schema: 'dotagents.caveat-diagnostic-binding.v1', status: 'unconfirmed',
        reason: 'registered_entry_unavailable', before: null, after: null, diagnostic_sha256: null,
        descriptor_reads: { before: beforeRead.trace, after: null } };
      return { result: null, binding: { status: 'unverified', reason_code: evidence.reason } };
    }
    // 引数は配列のまま通常spawnへ渡す。旧PATHのcaveatへfallbackしない。
    const result = await runCommand(before.command, [...before.args], { cwd });
    const afterRead = await descriptor(runCommand, cwd);
    const after = afterRead.descriptor;
    let outputVersion = null;
    try {
      const version = JSON.parse(result.stdout).version;
      if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) outputVersion = version;
    } catch {}
    const reason = !after ? 'registered_entry_unavailable'
      : identity(before) !== identity(after) ? 'registered_entry_changed'
        : outputVersion !== before.installed_version ? 'diagnostic_version_mismatch' : null;
    evidence = { schema: 'dotagents.caveat-diagnostic-binding.v1', status: reason ? 'unconfirmed' : 'bound',
      reason, before, after, diagnostic_sha256: sha(result.stdout ?? ''), output_version: outputVersion,
      descriptor_reads: { before: beforeRead.trace, after: afterRead.trace } };
    // binding不成立でも、実際に得たresultを置換・削除しない。
    return { result, binding: reason ? { status: 'unverified', reason_code: reason } : { status: 'pass' } };
  };
  port.evidence = () => structuredClone(evidence);
  return port;
}
