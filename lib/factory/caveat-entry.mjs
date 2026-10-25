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

export function createCaveatDiagnosticPort({ node = process.execPath, collectInventory } = {}) {
  let evidence = null;
  async function descriptor(runCommand, cwd) {
    try {
      let inventory;
      if (collectInventory) inventory = await collectInventory();
      else {
        const result = await runCommand(node, [COLLECTOR], { cwd, maxOutputBytes: 4 * 1024 * 1024 });
        if (!result.ok) return null;
        inventory = JSON.parse(result.stdout);
      }
      // 製品正本のselectorをそのまま使う。MCP設定parserを工場へ複製しない。
      return structuredClone(diagnosticDescriptor(inventory));
    } catch { return null; }
  }
  const port = async ({ cwd, runCommand = run }) => {
    const before = await descriptor(runCommand, cwd);
    if (!before) {
      evidence = { schema: 'dotagents.caveat-diagnostic-binding.v1', status: 'unconfirmed',
        reason: 'registered_entry_unavailable', before: null, after: null, diagnostic_sha256: null };
      return { result: null, binding: { status: 'unverified', reason_code: evidence.reason } };
    }
    // 引数は配列のまま通常spawnへ渡す。旧PATHのcaveatへfallbackしない。
    const result = await runCommand(before.command, [...before.args], { cwd });
    const after = await descriptor(runCommand, cwd);
    let outputVersion = null;
    try {
      const version = JSON.parse(result.stdout).version;
      if (typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) outputVersion = version;
    } catch {}
    const reason = !after ? 'registered_entry_unavailable'
      : identity(before) !== identity(after) ? 'registered_entry_changed'
        : outputVersion !== before.installed_version ? 'diagnostic_version_mismatch' : null;
    evidence = { schema: 'dotagents.caveat-diagnostic-binding.v1', status: reason ? 'unconfirmed' : 'bound',
      reason, before, after, diagnostic_sha256: sha(result.stdout ?? ''), output_version: outputVersion };
    // binding不成立でも、実際に得たresultを置換・削除しない。
    return { result, binding: reason ? { status: 'unverified', reason_code: reason } : { status: 'pass' } };
  };
  port.evidence = () => structuredClone(evidence);
  return port;
}
