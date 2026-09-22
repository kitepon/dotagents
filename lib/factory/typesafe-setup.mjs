import { run } from './command.mjs';
import { loadTypeSafeKey } from './typesafe-credentials.mjs';

// 外部skillは公式installerへ、工場の秘密配布は共通credential処理へ渡す。
// 子のモデル選定を全hostの親がJevへ渡せるよう、4hostへ導入する。
const AGENT_IDS = ['codex', 'claude-code', 'cursor', 'grok'];
const AGENT_NAMES = ['Codex', 'Claude Code', 'Cursor', 'Grok Build'];
export async function setupTypeSafe({ execute = run, request = fetch, env = process.env,
  loadKey = loadTypeSafeKey, output = process.stdout } = {}) {
  const key = await loadKey({ env, execute });
  const options = { input: '', timeoutMs: 300000, maxOutputBytes: 1024 * 1024 };
  output.write('[TypeSafe] 公式skillの導入・更新\n');
  const install = await execute('npx', ['--yes', 'skills', 'add', 'typesafe-ai/skills',
    '--skill', 'typesafe-ai', '--global', '--agent', ...AGENT_IDS, '--yes'], options);
  if (!install.ok) throw new Error(`TYPESAFE_INSTALL_FAILED: ${install.reason ?? 'exit'} code=${install.code ?? 'なし'}`);

  const listed = await execute('npx', ['--yes', 'skills', 'list', '--global', '--json'], options);
  if (!listed.ok) throw new Error('TYPESAFE_LIST_FAILED');
  let skills;
  try { skills = JSON.parse(listed.stdout); } catch { throw new Error('TYPESAFE_LIST_INVALID'); }
  const skill = Array.isArray(skills) ? skills.find((entry) => entry.name === 'typesafe-ai'
    && entry.scope === 'global' && entry.source === 'typesafe-ai/skills') : undefined;
  const missing = AGENT_NAMES.filter((name) => !skill?.agents?.includes(name));
  if (missing.length > 0) throw new Error(`TYPESAFE_SKILL_NOT_INSTALLED: ${missing.join(', ')}`);

  const receipt = { schema: 'dotagents.typesafe-setup.v1', installed: true };
  let response;
  try {
    response = await request('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'jev-latest', state: 'ゲーム機を買うべきか相談したい。',
        questions: { intent: { type: 'choice', instructions: '入力の目的を分類してください。',
          criteria: { purchase_advice: '購入するかどうかの相談', bug_report: '不具合の報告', other: 'それ以外' } } } }),
      signal: AbortSignal.timeout(30000),
    });
  } catch { throw new Error('TYPESAFE_API_UNREACHABLE'); }
  if (!response.ok) throw new Error(`TYPESAFE_API_HTTP_${response.status}`);
  let result;
  try { result = await response.json(); } catch { throw new Error('TYPESAFE_API_INVALID_JSON'); }
  if (result.answers?.intent?.type !== 'choice' || result.answers.intent.choice !== 'purchase_advice') {
    throw new Error('TYPESAFE_API_SMOKE_FAILED');
  }
  output.write('[TypeSafe] 公式skill導入済み・実API分類確認済み\n');
  return { ...receipt, state: 'ready' };
}
