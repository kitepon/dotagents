// launchd / cron は最小 PATH で runner を起動する。製品 CLI（npm global・uv tool・grok）が
// 解決できないと scan が全製品を missing と誤観測して BugHub の current matrix を汚すため、
// 既存 PATH の優先順位を変えずに「存在しない entry だけ」を末尾へ補完する。
// 明示 PATH（対話 shell・テストの fake bin）は先勝ちで、新しい shadow を作らない。例外は下の node の置き場だけ。
// Windows は Task Scheduler が user PATH を継承し、npm shim 解決は lib/factory/command.mjs の
// 検証済み契約が所有するため対象外とする。
import { accessSync, constants, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

function firstNodeOnPath(entries) {
  for (const entry of entries) {
    const candidate = join(entry, 'node');
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch { /* このentryにnodeは無い */ }
  }
  return null;
}

export function extendedSchedulerPath({ platform, path, execPath, home, resolveNode = firstNodeOnPath }) {
  if (platform === 'win32') return path;
  if (typeof execPath !== 'string' || !execPath || typeof home !== 'string' || !home) throw new Error('scheduler PATH補完にはexecPathとhomeが必要です');
  const current = (typeof path === 'string' ? path : '').split(':').filter(Boolean);
  const seen = new Set(current);
  const absent = (entry) => !seen.has(entry) && (seen.add(entry), true);
  // 製品 CLI は `#!/usr/bin/env node` で起動する。PATH で先に当たる node が runner の node と違う host
  //（system の node と NVM が並ぶ server）では、末尾補完だと製品が別の node で診断される。
  // その時だけ、runner の node の置き場を先頭へ足す。
  const shadowing = resolveNode(current);
  const runtime = shadowing !== null && shadowing !== execPath ? [dirname(execPath)].filter(absent) : [];
  const additions = [
    dirname(execPath),
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.grok', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ].filter(absent);
  return [...runtime, ...current, ...additions].join(':');
}
