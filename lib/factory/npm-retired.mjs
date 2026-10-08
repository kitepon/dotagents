import * as nodeFs from 'node:fs/promises';
import { join, relative } from 'node:path';

// npmは入替の前に、古いpackageを隣の `.<名前>-<hash>` へ退避し、成功した後で消す。
// Windowsでは稼働中のexeを消せず、退避フォルダが残る。次の入替はそこへ上書きできずEBUSYで落ち、
// 巻き戻しで退避側の古いexeが元の場所へ戻る（2026-10-07 claude-code、2026-10-08 codex-cli）。
// ここでは残った退避フォルダを片付け、消せないファイルだけを工場の置き場へ移す。稼働中のプロセスは止めない。

const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

// 退避先の名前はnpmの `retire-path.js` が決める（pathのsha1をbase64にし、英数字だけ残した先頭8文字）。
export function retiredNamePattern(base) {
  return new RegExp(`^\\.${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[A-Za-z0-9]{1,8}$`);
}

// 消せる物を全部消し、消せなかったpathを返す。
async function removeTree(fs, path) {
  let stat;
  try { stat = await fs.lstat(path); } catch (error) { return error.code === 'ENOENT' ? [] : [path]; }
  if (stat.isDirectory()) {
    let names;
    try { names = await fs.readdir(path); } catch { return [path]; }
    const stuck = (await Promise.all(names.map((name) => removeTree(fs, join(path, name))))).flat();
    if (stuck.length > 0) return stuck;
    try { await fs.rmdir(path); } catch (error) { return error.code === 'ENOENT' ? [] : [path]; }
    return [];
  }
  try { await fs.unlink(path); } catch (error) { return error.code === 'ENOENT' ? [] : [path]; }
  return [];
}

export async function clearRetiredPackage({ root, packageName, parkDir, stamp = stampOf(new Date()), fs = nodeFs }) {
  if (!root || !parkDir || !PACKAGE_NAME.test(packageName ?? '')) throw new Error('usage');
  const parts = packageName.split('/');
  const base = parts.pop();
  const parent = join(root, ...parts);
  const pattern = retiredNamePattern(base);

  // 以前に移したexeは、掴んでいたプロセスが終われば消せる。まだ消せない物は残す。
  await removeTree(fs, parkDir);

  let names;
  try { names = await fs.readdir(parent); } catch (error) {
    if (error.code === 'ENOENT') return { retired: [], parked: [], remaining: [] };
    throw error;
  }
  const retired = names.filter((name) => pattern.test(name)).sort();
  const parked = [];
  const remaining = [];
  for (const name of retired) {
    const folder = join(parent, name);
    for (const from of await removeTree(fs, folder)) {
      // 同じvolumeのrenameなら、稼働中のexeも動かせる。copyへは逃げない（消せない物が二重に残る）。
      const to = join(parkDir, `${stamp}-${name}`, relative(folder, from));
      try {
        await fs.mkdir(join(to, '..'), { recursive: true });
        await fs.rename(from, to);
        parked.push({ from, to });
      } catch { /* 下の再走査が残りとして数える */ }
    }
    remaining.push(...await removeTree(fs, folder));
  }
  return { retired, parked, remaining };
}

function stampOf(date) {
  return date.toISOString().replace(/[^0-9]/g, '');
}
