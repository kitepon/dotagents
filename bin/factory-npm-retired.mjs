#!/usr/bin/env node

import { clearRetiredPackage } from '../lib/factory/npm-retired.mjs';

// 使い方: factory-npm-retired.mjs clear --root <npm root -g> --package <名前> --park <置き場>
// 退避フォルダが片付けば0、残れば20、片付けを試せなければ2。退避フォルダがあった時だけ、結果を1行のJSONで返す。
// 20はNode自身の異常終了（1など）と重ならない値。呼び出し側は20の時だけ入替を見送る。
try {
  const [operation, ...args] = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    if (!['--root', '--package', '--park'].includes(args[index]) || args[index + 1] === undefined) throw new Error('usage');
    options[args[index].slice(2)] = args[index + 1];
  }
  if (operation !== 'clear') throw new Error('usage');
  const result = await clearRetiredPackage({ root: options.root, packageName: options.package, parkDir: options.park });
  const ok = result.remaining.length === 0;
  // 退避フォルダが無い回は何も出さない（更新logを毎回の空の結果で埋めない）。
  if (result.retired.length > 0) process.stdout.write(`${JSON.stringify({ ok, package: options.package, ...result })}\n`);
  if (!ok) process.exitCode = 20;
} catch (error) {
  process.stderr.write(`[factory-npm-retired] ${error?.message === 'usage' ? 'usage' : 'failed'}\n`);
  process.exitCode = 2;
}
