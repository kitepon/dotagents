const STATUSES = ['ready', 'not_ready', 'unverified'];

export function parseCaveatDiagnostic(value) {
  if (!STATUSES.includes(value?.overall?.status)
    || typeof value.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value.version)
    || !(Number.isSafeInteger(value.database?.schema_version) || value.database?.schema_version === null)
    || !['current', 'failed', 'unverified'].includes(value.database.migration_status)) {
    throw new Error('native_diagnostics_schema');
  }
  // 合否・集約・migrationの成立判定はCaveatが所有する。
  return {
    overall: value.overall.status,
    version: value.version,
    state: value.database.schema_version === null ? null : String(value.database.schema_version),
    migration: value.database.migration_status,
  };
}
