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

// 部品の細目。Caveat v1が部品ごとに返すstatusとreason_codeを、判定を足さずに写す。
// 部品の一覧は工場が固定する。v1に無い部品（Grok専用のhook、CodexのMCP診断）は作らない。
const REASON = /^[a-z][a-z0-9_]{0,63}$/u;
const FORBIDDEN = /(?:Bearer\s+\S+|(?:^|[\s"'])\/(?:home|Users)\/|[A-Za-z]:\\Users\\|-----BEGIN|\b(?:sk|ghp)_[A-Za-z0-9_-]+)/i;
const hooks = (host, names) => names.map((name) => [`${host}_hook_${name}`, (value) => value?.connectors?.[host]?.hooks?.[name]]);
export const CAVEAT_COMPONENTS = Object.freeze([
  ['database', (value) => value?.database],
  ['sync', (value) => value?.sync],
  ['claude_mcp', (value) => value?.connectors?.claude?.mcp],
  ...hooks('claude', ['user_prompt_submit', 'post_tool_use', 'post_tool_use_failure', 'stop']),
  ...hooks('codex', ['user_prompt_submit', 'post_tool_use', 'stop']),
  ...hooks('cursor', ['before_submit_prompt', 'post_tool_use', 'post_tool_use_failure', 'stop']),
  ['grok_mcp', (value) => value?.connectors?.grok?.mcp],
]);

export function parseCaveatComponents(value) {
  const components = [];
  for (const [id, read] of CAVEAT_COMPONENTS) {
    const part = read(value);
    // 出力に無い部品は作らない（古い版の出力を不足に変換しない）。
    if (part === undefined) continue;
    const valid = part !== null && typeof part === 'object' && !Array.isArray(part) && STATUSES.includes(part.status)
      && typeof part.reason_code === 'string' && REASON.test(part.reason_code) && !FORBIDDEN.test(part.reason_code);
    // 形式から外れた値は運ばない。その部品だけを未確認にし、ほかの部品と製品のoverallは残す。
    components.push(valid ? { id, status: part.status, reason: part.reason_code } : { id, status: 'unverified', reason: 'detail_schema_invalid' });
  }
  return components;
}
