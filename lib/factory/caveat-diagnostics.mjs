const STATUSES = ['ready', 'not_ready', 'unverified'];

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length
    || Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error('native_diagnostics_schema');
  }
}

function status(value) {
  if (!STATUSES.includes(value)) throw new Error('native_diagnostics_schema');
}

function statusReason(value) {
  exact(value, ['status', 'reason_code']);
  status(value.status);
  if (typeof value.reason_code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/u.test(value.reason_code)) {
    throw new Error('native_diagnostics_schema');
  }
}

function hooks(value, names) {
  exact(value, names);
  Object.values(value).forEach(statusReason);
}

export function parseCaveatDiagnostic(value) {
  exact(value, ['schema', 'product', 'version', 'overall', 'database', 'sync', 'connectors']);
  exact(value.overall, ['status']);
  status(value.overall.status);
  exact(value.database, ['status', 'reason_code', 'schema_version', 'supported_schema_version', 'migration_status']);
  statusReason({ status: value.database.status, reason_code: value.database.reason_code });
  statusReason(value.sync);
  const hasCursor = Object.hasOwn(value.connectors ?? {}, 'cursor');
  exact(value.connectors, hasCursor ? ['claude', 'codex', 'cursor'] : ['claude', 'codex']);
  exact(value.connectors.claude, ['status', 'mcp', 'hooks']);
  status(value.connectors.claude.status);
  statusReason(value.connectors.claude.mcp);
  hooks(value.connectors.claude.hooks, ['user_prompt_submit', 'post_tool_use', 'post_tool_use_failure', 'stop']);
  exact(value.connectors.codex, ['status', 'hooks']);
  status(value.connectors.codex.status);
  hooks(value.connectors.codex.hooks, ['user_prompt_submit', 'post_tool_use', 'stop']);
  if (hasCursor) {
    exact(value.connectors.cursor, ['compatibility_status', 'hooks']);
    status(value.connectors.cursor.compatibility_status);
    hooks(value.connectors.cursor.hooks, ['before_submit_prompt', 'post_tool_use', 'post_tool_use_failure', 'stop']);
  }
  if (value.schema !== 'caveat.native_factory_diagnostics.v1' || value.product !== 'caveat'
    || typeof value.version !== 'string'
    || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value.version)
    || !(Number.isSafeInteger(value.database.schema_version) || value.database.schema_version === null)
    || !Number.isSafeInteger(value.database.supported_schema_version)
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
