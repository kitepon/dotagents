import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';

// Fixture起動の失敗も呼出元へ返す。HTTP serverなどのfinally cleanupを未到達にしない。
export function runFixtureChild(script, args, box, extraEnv = {}, { executable = process.execPath } = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const env = { ...process.env, HOME: box.root, USERPROFILE: box.root,
      LOCALAPPDATA: join(box.root, 'local-app-data'), XDG_CONFIG_HOME: join(box.root, 'config-home'),
      XDG_STATE_HOME: join(box.root, 'state-home'), ...extraEnv };
    if (process.platform === 'win32' && extraEnv.PATH) env.PATH = `${extraEnv.PATH}${delimiter}${process.env.PATH}`;
    const child = spawn(executable, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.once('error', rejectRun);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('close', (code) => {
      let json = null;
      for (const line of stdout.trim().split(/\r?\n/u).reverse()) { try { json = JSON.parse(line); break; } catch {} }
      resolveRun({ code, stderr, json });
    });
  });
}
