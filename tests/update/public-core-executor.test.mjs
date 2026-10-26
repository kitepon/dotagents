import assert from 'node:assert/strict';
import test from 'node:test';
import { createPublicCoreExecutor } from '../../lib/factory/update-context-public-executor.mjs';
const input = execute => ({ command: 'gpt-connector', args: ['setup'], options: { input: '' }, before: undefined, execute });
test('missing original ports preserves exact ordinary result once without source/OS work', async () => {
  const execute = createPublicCoreExecutor({}); const original = { ok: false, code: 2, stdout: 'ordinary', stderr: '' }; let calls=0;
  assert.equal(await execute(input(async (...args) => { calls++; assert.equal(args[0],'gpt-connector');assert.deepEqual(args[1],['setup']);return original; })),original);
  assert.equal(calls,1);await assert.rejects(execute(input(async()=>original)),/public_core_execution_unconfirmed/);
});
test('reservation precedes caller getter reentry and original exception is not retried', async () => {
  const execute = createPublicCoreExecutor({}); let calls=0, reentered;
  const supplied = { ...input(async () => { calls++;throw new Error('fixture-original'); }), get command() {
    reentered=execute(input(async()=>{}));reentered.catch(()=>{});return 'gpt-connector';
  } };
  await assert.rejects(execute(supplied),/fixture-original/);await assert.rejects(reentered,/public_core_execution_unconfirmed/);assert.equal(calls,1);
});
