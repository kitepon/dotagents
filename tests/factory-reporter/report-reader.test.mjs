import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import * as contract from '../../lib/factory/contract.mjs';
import { V2_PRODUCT_IDS } from '../../lib/factory/v2.mjs';
import { V4_PRODUCT_IDS } from '../../lib/factory/v4.mjs';
import { V5_PRODUCT_IDS } from '../../lib/factory/v5.mjs';
import { V6_PRODUCT_IDS } from '../../lib/factory/v6.mjs';
import { V7_PRODUCT_IDS } from '../../lib/factory/v7.mjs';
import { V8_PRODUCT_IDS } from '../../lib/factory/v8.mjs';
import { V9_PRODUCT_IDS } from '../../lib/factory/v9.mjs';

const legacy = ['caveat', 'throughline', 'spotter', 'codegraph', 'markitdown', 'oracle', 'aiterm-mcp', 'codex-sidecar', 'servermanager'];
for (const [major, ids] of [[1, legacy], [2, V2_PRODUCT_IDS], [4, V4_PRODUCT_IDS], [5, V5_PRODUCT_IDS], [6, V6_PRODUCT_IDS], [7, V7_PRODUCT_IDS], [8, V8_PRODUCT_IDS], [9, V9_PRODUCT_IDS]]) {
  test(`report reader v${major} preserves bytes and file/decode/validator errors`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'report-reader-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, 'report.json');
    const suffix = major === 1 ? '' : `V${major}`;
    const read = contract[`readAndValidateReport${suffix}`];
    const validate = contract[`validateReport${suffix}`];
    const report = {
      schema_version: `${major}.0`, report_id: '018f0000-0000-8000-8000-000000000001', host_id: 'test-host', host_profile: 'mac',
      platform: { os: 'darwin', arch: 'arm64' }, report_mode: 'full', observed_at: '2026-07-13T00:00:00Z', created_at: '2026-07-13T00:00:01Z',
      reporter: { version: `${major}.0.0`, dotagents_revision: '1234567' },
      products: Object.fromEntries(ids.map(id => [id, { presence_status: 'missing', contract_version: `${major}.0`, checks: [], runtime_errors: [], resolutions: [] }])),
    };
    const bytes = Buffer.from(`\n${JSON.stringify(report, null, 2)}  \n`);
    await writeFile(file, bytes);
    const result = await read(file);
    assert.ok(Buffer.isBuffer(result.bytes));
    assert.deepEqual(result.bytes, bytes);
    assert.deepEqual(result.report, report);
    await assert.rejects(read(join(root, 'missing')), { code: 'ENOENT' });
    for (const invalid of [Buffer.from([0xff]), Buffer.from('{')]) {
      await writeFile(file, invalid);
      await assert.rejects(read(file), { message: 'report JSONが不正です' });
    }
    for (const mutate of [r => { r.schema_version = '3.0'; }, r => { delete r.products[ids[0]]; }, r => { r.products[ids[0]].checks = [{ check_id: 'native', status: 'pass', safe_context: { detail: 'private' } }]; }]) {
      const invalid = structuredClone(report); mutate(invalid);
      let expected;
      assert.throws(() => validate(invalid), error => { expected = error.message; return true; });
      await writeFile(file, JSON.stringify(invalid));
      await assert.rejects(read(file), { message: expected });
    }
  });
}
