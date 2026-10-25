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

// 表示だけを所有する。設定・実体の判定はCaveatの公開診断に任せる。
// 未知の理由も元のnot_readyを運び、説明の不足を登録拒否の条件にしない。
const REASON_DESCRIPTIONS = Object.freeze({
  missing: '診断対象が見つからない',
  schema_contract_mismatch: 'DB構造が製品の対応契約と一致しない',
  not_registered: '実行CLIに対応するMCP登録を確認できない',
  disabled: 'MCP登録が無効になっている',
  not_installed: '実行CLIに対応するhook定義を確認できない',
  feature_disabled: 'Codexのhook機能が有効になっていない',
  not_git_worktree: '知識repoをGit作業ツリーとして確認できない',
  origin_missing: '知識repoのoriginを確認できない',
  worktree_dirty: '知識repoに未コミットの変更がある',
  upstream_not_origin: '知識repoの追跡先がoriginではない',
  diverged: '知識repoの追跡先と端末の履歴が分岐している',
  behind: '知識repoの端末履歴が追跡先より遅れている',
  ahead: '知識repoの端末履歴が追跡先より進んでいる',
});
function reasonDescription(id, reason) {
  const allowed = id === 'database' ? ['missing', 'schema_contract_mismatch']
    : id === 'sync' ? ['not_git_worktree', 'origin_missing', 'worktree_dirty', 'upstream_not_origin', 'diverged', 'behind', 'ahead']
      : id.endsWith('_mcp') ? ['not_registered', ...(id === 'grok_mcp' ? ['disabled'] : [])]
        : id.includes('_hook_') ? ['not_installed', ...(id.startsWith('codex_') ? ['feature_disabled'] : [])] : [];
  return allowed.includes(reason) ? REASON_DESCRIPTIONS[reason] : '理由の具体的な意味は未確認';
}
function componentOperation(id) {
  if (id === 'database') return 'DB構造診断';
  if (id === 'sync') return '知識repo同期状態の診断';
  if (id.endsWith('_mcp')) return `${id.slice(0, -4)}のMCP登録診断`;
  const [host, event] = id.split('_hook_');
  return `${host}の${event} hook登録診断`;
}
function requiredState(id) {
  if (id === 'database') return '製品が対応するDB構造を読めること';
  if (id === 'sync') return '知識repoがorigin追跡先と同期済みで、未コミット変更がないこと';
  if (id.endsWith('_mcp')) return '診断CLIに対応する有効なCaveat MCP登録があること';
  if (id.includes('_hook_')) return `診断CLIに対応するhook定義があること${id.startsWith('codex_') ? 'と、Codexのhook機能が有効なこと' : ''}`;
  return '製品全体のreadiness診断がreadyであること';
}
export function caveatFailureMessage(id, reason) {
  if (id === 'sync' && reason === 'remote_mismatch') {
    return 'Caveat同期診断で共有先HEADと端末HEADの不一致を検出。同期操作の成否・原因・実害は未確認。必要状態=共有先HEADと端末HEADが一致すること。';
  }
  const operation = id === 'native_diagnostics' ? '製品全体のreadiness診断' : componentOperation(id);
  const detail = id === 'native_diagnostics' && reason === 'native_not_ready_unattributed' ? '製品全体の不足を部品へ特定できない'
    : reasonDescription(id, reason);
  return `caveat ${id} failed。処理=factory-diagnostics: ${operation}。観測=not_ready、理由=${reason}（${detail}）。必要状態=${requiredState(id)}。実利用の成否・原因・影響は未確認。`;
}

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
