// Source-only optional observation contract. No CLI flag, probe, transport or default wire activation.
import { validateReportV9 } from './contract.mjs';

const SHAPES = Object.freeze({
  gpt_obs_schema: ['v1'],
  gpt_auth_session_http: ['2xx', '401', '403', 'other_4xx', '5xx', 'other_http', 'unobserved'],
  gpt_auth_session_user: ['present', 'absent', 'uninspected'],
  gpt_bridge_present: ['true', 'false', 'uninspected'],
  gpt_bridge_version: ['true', 'false', 'uninspected'],
  gpt_bridge_build: ['true', 'false', 'uninspected'],
  gpt_bridge_summary: ['true', 'false', 'uninspected'],
});
const KEYS = Object.freeze(Object.keys(SHAPES));
const invalid = () => { throw new Error('gpt_observation_context_invalid'); };
export function readGptObservationContext(value) {
  try {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const keys = Reflect.ownKeys(value);
    if (!keys.length) return undefined;
    if (keys.length !== KEYS.length || keys.some(key => !KEYS.includes(key))) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = {};
    for (const key of KEYS) {
      if (!descriptors[key] || !Object.hasOwn(descriptors[key], 'value') || !SHAPES[key].includes(descriptors[key].value)) return invalid();
      result[key] = descriptors[key].value;
    }
    if (result.gpt_auth_session_http !== '2xx' && result.gpt_auth_session_user !== 'uninspected') return invalid();
    if (result.gpt_bridge_present !== 'true' && ['gpt_bridge_version', 'gpt_bridge_build', 'gpt_bridge_summary'].some(key => result[key] !== 'uninspected')) return invalid();
    return Object.freeze(result);
  } catch { return invalid(); }
}

export function preserveGptObservationChecks(nativeChecks, projectedChecks, enabled = false) {
  return projectedChecks.map((item, index) => {
    const context = readGptObservationContext(nativeChecks[index].safe_context);
    if (!context) return item;
    if (enabled !== true) throw new Error('gpt_observation_context_not_enabled');
    return { ...item, safe_context: context };
  });
}

/** Explicit future contract candidate; the current reporter still uses validateReportV9. */
export function validateGptObservationReportV9(report) {
  // Validate each complete group, then reuse every existing v9/status/privacy
  // rule on a copy with just this already-validated extension removed.
  const prior = structuredClone(report);
  for (const list of ['checks', 'runtime_errors']) {
    const original = report.products?.['gpt-connector']?.[list];
    const copied = prior.products?.['gpt-connector']?.[list];
    if (!Array.isArray(original) || !Array.isArray(copied)) return validateReportV9(prior);
    original.forEach((item, i) => {
      if (!Object.hasOwn(item, 'safe_context')) return;
      readGptObservationContext(item.safe_context);
      delete copied[i].safe_context;
    });
  }
  validateReportV9(prior);
  return report;
}

/** One report only. Runtime-history groups are not mixed into current checks. */
export function projectSameReportGptObservation(report) {
  validateGptObservationReportV9(report);
  const product = report.products['gpt-connector'];
  const groups = product.checks.map(item => readGptObservationContext(item.safe_context)).filter(Boolean);
  if (!groups.length || groups.some(group => KEYS.some(key => group[key] !== groups[0][key]))) return null;
  return { report_id: report.report_id, host_id: report.host_id, observed_at: report.observed_at,
    ...(product.installed_version ? { installed_version: product.installed_version } : {}),
    safe_context: { ...groups[0] } };
}
