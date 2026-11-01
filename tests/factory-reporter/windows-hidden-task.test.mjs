import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { windowsHiddenTask, writeWindowsTaskXml } from '../../lib/factory/windows-scheduler.mjs';

test('GUI taskは引数を保ち非表示で終了を待ち、子の失敗codeを返す', () => {
  const command = '"C:\\Program Files\\nodejs\\node.exe" "C:\\更新 処理\\runner.js" --config "C:\\設定 & state\\config.json"';
  const action = windowsHiddenTask('C:\\factory state\\hourly.js', command);
  let exit;
  runInNewContext(action.launcher.content, {
    WScript: { Quit(code) { exit = code; } },
    ActiveXObject: function (name) {
      assert.equal(name, 'WScript.Shell');
      return { Run(...args) { assert.deepEqual(args, [command, 0, true]); return 37; } };
    },
  });
  assert.equal(exit, 37);
  assert.match(action.command, /System32\\wscript\.exe$/u);
  assert.equal(action.arguments, '//B //Nologo //E:JScript "C:\\factory state\\hourly.js"');
  assert.throws(() => windowsHiddenTask('bad"path', command));
  assert.throws(() => windowsHiddenTask('safe.js', 'bad\ncommand'));
});

test('Windows nativeのWSHは空白と日本語の引数と終了codeを保持する', { skip: process.platform !== 'win32' }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'factory-hidden-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = join(root, 'child.js'), output = join(root, 'result.json');
  await writeFile(child, 'require("fs").writeFileSync(process.argv[2], JSON.stringify(process.argv[3])); process.exit(37);');
  const action = windowsHiddenTask(join(root, 'hidden.js'), `"${process.execPath}" "${child}" "${output}" "更新 & spaces"`);
  await writeWindowsTaskXml(join(root, 'task.xml'), '<Task/>', action.launcher);
  const run = spawnSync(action.command, ['//B', '//Nologo', '//E:JScript', action.launcher.file], { windowsHide: true, timeout: 10000 });
  assert.equal(run.status, 37);
  assert.equal(JSON.parse(await readFile(output, 'utf8')), '更新 & spaces');
});
