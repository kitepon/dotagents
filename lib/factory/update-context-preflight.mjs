import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const SOURCES = [
  { path: 'bin/setup-linux-common.sh', sha256: 'fba70e9611b47596e311e8550cbe9ea00f1b287ab975015330b9084e31383cfe', first: 542, last: 547, stage: 'wrapper_restore' },
  { path: 'bin/agents-update.sh', sha256: '9d203174500c24f2e2ecee92c28aa64039825217a8ce727a24221b13e8d4266c', first: 18, last: 29, stage: 'writer_restore' },
];

// Both consumers refer to the ordinary writer source. This loader executes none
// of it. A changed source requires a new review, rather than a guessed slice.
export async function readRestorationSource(root) {
  const fragments = [];
  for (const pin of SOURCES) {
    const bytes = await readFile(join(root, pin.path));
    if (sha(bytes) !== pin.sha256) throw new Error(`context_source_changed:${pin.path}`);
    const content = bytes.toString('utf8').split(/(?<=\n)/u).slice(pin.first - 1, pin.last).join('');
    fragments.push({ ...pin, content, fragment_sha256: sha(content) });
  }
  const writer = await readFile(join(root, 'bin/agents-update.sh'), 'utf8');
  const addGlobalBin = writer.split('\n').filter((line) => line.trim() === 'PATH="$npm_global_bin:$PATH"');
  if (addGlobalBin.length !== 1) throw new Error('context_global_bin_source_changed');
  return { kind: 'pinned_source_only', fragments, global_bin_path_assignment: addGlobalBin[0] };
}

const STAGES = ['job_input', 'prefix_before', 'global_bin', 'global_after', 'public_core'];
const absolute = (value) => typeof value === 'string' && value.startsWith('/') && !/[\0\r\n]/u.test(value);
const timed = (record) => Number.isSafeInteger(record?.observed_at_utc_ms) && record.observed_at_utc_ms > 0;
const reference = (record) => typeof record?.evidence_ref === 'string' && record.evidence_ref.length > 0;
const command = (value) => absolute(value?.path) && absolute(value.realpath) && /^[a-f0-9]{64}$/u.test(value.sha256 ?? '') &&
  typeof value.version === 'string' && /^v?\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/u.test(value.version);
const commands = (record) => command(record?.node) && command(record?.npm);
const sameCommand = (left, right) => ['path', 'realpath', 'version', 'sha256'].every((key) => left[key] === right[key]);

// Pure evidence evaluation: no spawning, environment reconstruction, prefix
// query, mkdir, configuration reads, state, lease or reporting activation.
export function contextPreflightView({ registration, records = {}, evidenceKind = 'observed' } = {}) {
  const result = {
    schema: 'dotagents.update-context-preflight.v1',
    configured: registration ?? null,
    expected: STAGES.map((stage) => ({ stage, state: 'required_separate_original' })),
    observed: [],
    status: 'unknown',
    resource_coverage: 'unknown',
    reporting_allowed: false,
    real_host_execution_authorized: false,
  };
  let previous;
  const stop = (stage, reason) => ({ ...result, stopped_at: stage, reason });
  for (const stage of STAGES) {
    const record = records[stage];
    if (!record || record.kind !== evidenceKind || !timed(record) || !reference(record)) return stop(stage, 'stage_original_missing');
    if (stage === 'job_input') {
      if (record.provenance !== 'job_process' || !Number.isInteger(record.pid) || record.pid <= 0 ||
          record.uid !== registration?.uid || record.gid !== registration?.primary_gid ||
          record.entry_realpath !== registration?.entry_realpath || !absolute(record.cwd) ||
          typeof record.restore_input_sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.restore_input_sha256)) {
        return stop(stage, 'actual_job_context_not_bound');
      }
    } else {
      if (record.input_evidence_ref !== previous.evidence_ref || record.uid !== previous.uid || record.gid !== previous.gid) {
        return stop(stage, 'stage_input_not_bound');
      }
      if (stage === 'prefix_before' || stage === 'global_after' || stage === 'public_core') {
        if (!commands(record)) return stop(stage, 'stage_node_npm_not_observed');
        if (!absolute(record.cwd) || typeof record.path_value !== 'string') return stop(stage, 'stage_environment_not_observed');
      }
      if (stage === 'prefix_before') {
        if (!SOURCES.every((source) => record.restoration_source_sha256?.[source.stage] === source.sha256) ||
            !record.nvm_effect_review_ref) return stop(stage, 'restoration_source_or_effect_review_missing');
      }
      if (stage === 'global_bin') {
        if (!absolute(record.prefix) || record.bin_path !== `${record.prefix.replace(/\/$/u, '')}/bin` || record.exists !== true) {
          return stop(stage, 'global_bin_missing_or_unknown');
        }
        if (record.prefix_exit_code !== 0 || !record.prefix_source_evidence_ref) return stop(stage, 'npm_prefix_original_missing');
      }
      if (stage === 'global_after' && (!absolute(record.root) || record.root_exit_code !== 0 || !record.root_source_evidence_ref)) {
        return stop(stage, 'npm_root_not_observed');
      }
      if (stage === 'global_after' && record.path_value !== `${previous.bin_path}:${records.prefix_before.path_value}`) {
        return stop(stage, 'global_bin_path_transition_mismatch');
      }
      if (stage === 'public_core') {
        if (record.root !== previous.root || !sameCommand(record.node, previous.node) || !sameCommand(record.npm, previous.npm) ||
            record.cwd !== previous.cwd || record.path_value !== previous.path_value) {
          return stop(stage, 'public_core_context_mismatch');
        }
      }
    }
    result.observed.push(structuredClone(record));
    previous = record;
  }
  result.status = evidenceKind === 'fixture' ? 'fixture_context_stages_only' : 'observed_context_stages_only';
  return result;
}
