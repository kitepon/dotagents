import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { run } from './command.mjs';
import { JEV_PRODUCTS, jevCheckout, jevSupported } from './jev-products.mjs';

async function agentDesktopFork(home) {
  const path = join(home, '.config', 'dotagents', 'agent-desktop-fork.json');
  let text;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let source;
  try { source = JSON.parse(text); }
  catch { throw new Error('JEV_FORK_CONFIG_INVALID'); }
  if (!source || typeof source !== 'object' || Array.isArray(source)
    || typeof source.repository !== 'string' || !/^https:\/\/github\.com\/[\w-]+\/[\w.-]+(?:\.git)?$/u.test(source.repository)
    || typeof source.revision !== 'string' || !/^[0-9a-f]{40}$/u.test(source.revision)) {
    throw new Error('JEV_FORK_CONFIG_INVALID');
  }
  return source;
}

// 既定は上流の公式導入。端末別fork指定時だけCargoで固定revisionを導入する。
export async function setupJevProduct(id, { execute = run, home = homedir(), platform = process.platform,
  output = process.stdout } = {}) {
  const product = JEV_PRODUCTS[id];
  if (!product) throw new Error('JEV_PRODUCT_UNKNOWN');
  if (!jevSupported(id, platform)) return { product: id, state: 'unsupported' };
  const fork = id === 'agent-desktop' ? await agentDesktopFork(home) : null;
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
  } else if (fork) {
    await command('npm', ['uninstall', '--global', 'agent-desktop']);
    await command('cargo', ['install', '--git', fork.repository, '--rev', fork.revision, '--locked', '--force', '--root', join(home, '.local'), 'agent-desktop']);
    await command('npx', ['--yes', 'skills', 'add', 'lahfir/agent-desktop', '--skill', 'agent-desktop', '--skill', 'jev-desktop', '--global', '--agent', 'codex', '--yes']);
  } else {
    await command('npm', ['install', '--global', '--allow-scripts=agent-desktop', 'agent-desktop@latest']);
    await command('npx', ['--yes', 'skills', 'add', 'lahfir/agent-desktop', '--skill', 'agent-desktop', '--skill', 'jev-desktop', '--global', '--agent', 'codex', '--yes']);
  }
  const revision = fork?.revision ?? await command('git', ['rev-parse', 'HEAD'], { cwd });
  output.write(`[Jev導入] ${id}: ${fork ? '指定fork' : '公式'}導入完了\n`);
  return { product: id, state: 'installed', revision };
}
