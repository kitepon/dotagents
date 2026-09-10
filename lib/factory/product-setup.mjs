import { run } from './command.mjs';

// 工場は製品の公開入口と公開結果だけを扱う。
export const PRODUCT_SETUP_COMMANDS = {
  aiterm: ['aiterm-setup', '--json'],
  caveat: ['caveat', 'init', '--sync', '--yes'],
  'gpt-connector': ['gpt-connector', 'setup'],
  'codex-sidecar': ['codex-sidecar', 'setup'],
  aishell: ['aishell-setup'],
  lattice: ['lattice', 'setup', '--host', 'all', '--json'],
  peertable: ['peertable', 'install'],
};

export function setupOutcome(product, result, platform = process.platform) {
  if (result.ok) return 'ready';
  // 非ゼロ終了のうち、公開契約にある機能別未対応だけを記録して継続する。
  let value;
  try { value = JSON.parse(result.stdout); } catch { return 'failed'; }
  if (product === 'gpt-connector' && platform !== 'darwin' && result.code === 2
    && value?.schema === 'gpt-connector.setup.v1' && value.overall === 'partial'
    && value.live?.supported === false) return 'partial';
  if (product === 'lattice' && result.code === 1
    && value?.schema === 'lattice.setup_result.v1' && value.state === 'partial'
    && value.platform === platform && Array.isArray(value.hosts) && value.hosts.length === 4
    && new Set(value.hosts.map((host) => host.host)).size === 4
    && value.hosts.every((host) => ['claude', 'codex', 'grok', 'cursor'].includes(host.host)
      && host.mcp?.state === 'verified'
      && (host.hooks?.state === 'verified'
        || (host.hooks?.state === 'unsupported'
          && ((platform === 'win32' && host.hooks.code === 'HOST_PLATFORM_UNSUPPORTED')
            || (host.host === 'grok' && host.hooks.code === 'HOST_FEATURE_UNSUPPORTED')))))) return 'partial';
  return 'failed';
}

export async function runProductSetup(product, { execute = run, output = process.stdout } = {}) {
  const command = PRODUCT_SETUP_COMMANDS[product];
  if (!command) throw new Error(`製品の公開導入入口が未定義です: ${product}`);
  const started = Date.now();
  const progress = () => output.write(`[製品導入] ${product}: 公開入口の完了待ち (${Math.floor((Date.now() - started) / 1000)}秒)\n`);
  progress();
  const timer = setInterval(progress, 15000);
  let result;
  try {
    result = await execute(command[0], command.slice(1), {
      input: '', timeoutMs: 900000, maxOutputBytes: 1024 * 1024,
    });
  } finally { clearInterval(timer); }
  output.write(result.stdout ?? '');
  output.write(result.stderr ?? '');
  const state = setupOutcome(product, result);
  output.write(`[製品導入] ${product}: ${state} (${Math.floor((Date.now() - started) / 1000)}秒)${state === 'failed' ? ` 終了理由=${result.reason ?? 'exit'} code=${result.code ?? 'なし'}` : ''}\n`);
  return state;
}
