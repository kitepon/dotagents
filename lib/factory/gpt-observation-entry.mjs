// Factory-owned source composition. No environment/config/CLI switch enables this path.
import { readFile } from 'node:fs/promises';
import { readAndValidateReportV9, validateReportV9 } from './contract.mjs';
import { validateGptObservationReportV9 } from './gpt-observation-context.mjs';
const KEYS = ['central_release', 'validator_adoption', 'product_cli_adoption', 'factory_entry_adoption'];
const reference = value => typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);

/** Inputs are adopted factory source facts, never fields from a report or user config.
 * This selector does not verify release receipts or claim an unknown release.
 * The ordinary entry below has no readiness facts and remains closed.
 */
export function createGptObservationEntry(readiness) {
  const complete = readiness?.schema === 'dotagents.gpt-observation-path.v1'
    && KEYS.every(key => readiness[key]?.status === (key === 'central_release' ? 'released' : 'adopted') && reference(readiness[key]?.ref));
  const enabled = complete === true;
  const nativeArgs = Object.freeze(['factory-diagnostics', '--json', ...(enabled ? ['--include-observation-context'] : [])]);
  const projectorOptions = Object.freeze({ includeObservationContext: enabled });
  const validateReport = enabled ? validateGptObservationReportV9 : validateReportV9;
  const readReport = enabled ? async file => {
    const bytes = await readFile(file);
    let report;
    try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('report JSONが不正です'); }
    validateReport(report); return { bytes, report };
  } : readAndValidateReportV9;
  return Object.freeze({ enabled, nativeArgs, projectorOptions, validateReport, readReport });
}

// Opening this constant requires concrete adopted release/entry facts in a
// reviewed source change. No runtime option or environment can fill them in.
export const LEGACY_GPT_OBSERVATION_ENTRY = createGptObservationEntry();
export const DEFAULT_GPT_OBSERVATION_ENTRY = createGptObservationEntry({
  schema: 'dotagents.gpt-observation-path.v1',
  central_release: { status: 'released', ref: 'ServerManager:4035eadf61779308b9d3c50d952b06a5d5e74353:PR39:deploy1:ready200:factory-safe-context-v1.2' },
  validator_adoption: { status: 'adopted', ref: 'dotagents:48991d36a97dd68ada57d0aaf220d3b1dbc9ceb7:Fr-source-acceptance' },
  factory_entry_adoption: { status: 'adopted', ref: 'dotagents:48991d36a97dd68ada57d0aaf220d3b1dbc9ceb7:Fr-entry-send-gate-acceptance' },
  // Published CLI/artifact availability must be supplied by the product owner.
  product_cli_adoption: null,
});
