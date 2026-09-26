import { run } from './command.mjs';
import { parseNpmLatestJson } from './toolchain-contract.mjs';

const TRACKED = Object.freeze({
  'agent-desktop': { upstream: 'lahfir/agent-desktop', fork: 'https://github.com/quolu/agent-desktop', pull: 231, registry: 'npm' },
  'browser-harness': { upstream: 'browser-use/browser-harness', fork: 'https://github.com/quolu/browser-harness', pull: 747, registry: 'pypi',
    prerequisite: { upstream: 'ironerumi/browser-harness', pull: 1 } },
});

// PRの受理、公式releaseへの包含、registryへの配布を別々に確認する。
export async function officialForkRelease(id, { execute = run, fetchJson = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`JEV_RELEASE_LOOKUP_FAILED: HTTP ${response.status}`);
  return response.json();
} } = {}) {
  const target = TRACKED[id];
  if (!target) throw new Error(`JEV_FORK_TRACKING_UNKNOWN: ${id}`);
  const command = async (bin, args) => {
    const result = await execute(bin, args, { timeoutMs: 30000, maxOutputBytes: 1024 * 1024, input: '' });
    if (!result.ok) throw new Error(`JEV_RELEASE_LOOKUP_FAILED: ${id} ${bin} ${result.reason ?? 'exit'} code=${result.code ?? 'なし'}`);
    return result.stdout.trim();
  };
  const github = async (path) => {
    const raw = await command('gh', ['api', `repos/${path}`, '--jq', '{merged_at,merge_commit_sha,tag_name,status}']);
    try { return JSON.parse(raw); }
    catch { throw new Error(`JEV_RELEASE_RESPONSE_INVALID: ${id}`); }
  };
  const pull = await github(`${target.upstream}/pulls/${target.pull}`);
  if (!pull.merged_at) return null;
  if (!Number.isFinite(Date.parse(pull.merged_at))) throw new Error(`JEV_RELEASE_RESPONSE_INVALID: ${id}`);
  if (!/^[0-9a-f]{40}$/u.test(pull.merge_commit_sha ?? '')) throw new Error(`JEV_RELEASE_RESPONSE_INVALID: ${id}`);
  if (target.prerequisite) {
    const prerequisite = await github(`${target.prerequisite.upstream}/pulls/${target.prerequisite.pull}`);
    if (!prerequisite.merged_at) return null;
    if (!Number.isFinite(Date.parse(prerequisite.merged_at))) throw new Error(`JEV_RELEASE_RESPONSE_INVALID: ${id}`);
    if (Date.parse(prerequisite.merged_at) > Date.parse(pull.merged_at)) return null;
  }
  const release = await github(`${target.upstream}/releases/latest`);
  if (!/^v\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/u.test(release.tag_name ?? '')) throw new Error(`JEV_RELEASE_RESPONSE_INVALID: ${id}`);
  const version = release.tag_name.slice(1);
  let distributed;
  if (target.registry === 'npm') {
    distributed = parseNpmLatestJson(await command('npm', ['view', 'agent-desktop@latest', 'version', '--json']));
  } else {
    const pypi = await fetchJson('https://pypi.org/pypi/browser-harness/json');
    distributed = pypi?.info?.version;
  }
  if (distributed !== version) return null;
  const compare = await github(`${target.upstream}/compare/${pull.merge_commit_sha}...${release.tag_name}`);
  if (!['ahead', 'identical'].includes(compare.status)) return null;
  return { version, tag: release.tag_name };
}

export function isTrackedJevFork(id, repository) {
  const target = TRACKED[id];
  return target && repository.replace(/\.git$/u, '') === target.fork;
}
