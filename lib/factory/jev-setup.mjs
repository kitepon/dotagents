import { mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';
import { run } from './command.mjs';
import { JEV_PRODUCTS, jevCheckout, jevSupported } from './jev-products.mjs';

// 上流READMEのGit・uv・npm・Skill導入だけを呼ぶ。GUI操作や製品設定の補修は行わない。
export async function setupJevProduct(id, { execute = run, home = homedir(), platform = process.platform,
  output = process.stdout } = {}) {
  const product = JEV_PRODUCTS[id];
  if (!product) throw new Error('JEV_PRODUCT_UNKNOWN');
  if (!jevSupported(id, platform)) return { product: id, state: 'unsupported' };
  const cwd = jevCheckout(id, home);
  const command = async (bin, args, options = {}) => {
    const result = await execute(bin, args, { timeoutMs: 300000, maxOutputBytes: 1024 * 1024, input: '', ...options });
    if (!result.ok) throw new Error(`JEV_INSTALL_FAILED: ${id} ${bin} ${result.reason ?? 'exit'} code=${result.code ?? 'なし'}`);
    return result.stdout?.trim() ?? '';
  };
  output.write(`[Jev導入] ${id}: 上流最新版を取得\n`);
  let exists;
  try { exists = (await stat(cwd)).isDirectory(); }
  catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  if (exists) {
    const remote = await command('git', ['remote', 'get-url', 'origin'], { cwd });
    if (remote.replace(/\.git$/u, '') !== product.repository.replace(/\.git$/u, '')) throw new Error(`JEV_CHECKOUT_ORIGIN_MISMATCH: ${id}`);
    if (await command('git', ['status', '--porcelain'], { cwd })) throw new Error(`JEV_CHECKOUT_DIRTY: ${id}`);
    await command('git', ['pull', '--ff-only', 'origin', 'main'], { cwd });
  } else {
    await mkdir(dirname(cwd), { recursive: true });
    await command('git', ['clone', product.repository, cwd]);
  }
  if (id === 'jev-ultrafast') {
    await command('uv', ['sync', '--locked'], { cwd });
  } else {
    await command('npm', ['install', '--global', '--allow-scripts=agent-desktop', 'agent-desktop@latest']);
    await command('npx', ['--yes', 'skills', 'add', 'lahfir/agent-desktop', '--skill', 'agent-desktop', '--skill', 'jev-desktop', '--global', '--agent', 'codex', '--yes']);
  }
  const revision = await command('git', ['rev-parse', 'HEAD'], { cwd });
  output.write(`[Jev導入] ${id}: 公式導入完了\n`);
  return { product: id, state: 'installed', revision };
}
