import test from 'node:test';
import assert from 'node:assert/strict';
import { contextPreflightView } from '../../lib/factory/update-context-preflight.mjs';

// Inputs from the independent reader's GPT-CONTEXT-INPUT-1 counterexamples.
const registration={uid:1000,primary_gid:1000,entry_realpath:'/new-pure/setup-linux-factory.sh'};
const command=path=>({path,realpath:path,version:'24.0.0',sha256:'a'.repeat(64)});
function originals(kind='observed'){
 const names=['job_input','prefix_before','global_bin','global_after','public_core'];
 const records=Object.fromEntries(names.map((stage,i)=>[stage,{kind,evidence_ref:`new-pure:${stage}`,observed_at_utc_ms:2000+i,uid:1000,gid:1000,...(i?{input_evidence_ref:`new-pure:${names[i-1]}`}:{})}]));
 Object.assign(records.job_input,{provenance:'job_process',pid:55,entry_realpath:registration.entry_realpath,cwd:'/new-pure/cwd',restore_input_sha256:'a'.repeat(64)});
 Object.assign(records.prefix_before,{cwd:'/new-pure/cwd',path_value:'/new-pure/bin:/usr/bin',node:command('/new-pure/bin/node'),npm:command('/new-pure/bin/npm'),restoration_source_sha256:{wrapper_restore:'fba70e9611b47596e311e8550cbe9ea00f1b287ab975015330b9084e31383cfe',writer_restore:'9d203174500c24f2e2ecee92c28aa64039825217a8ce727a24221b13e8d4266c'},nvm_effect_review_ref:'new-pure:nvm-review'});
 Object.assign(records.global_bin,{prefix:'/new-pure/prefix',bin_path:'/new-pure/prefix/bin',exists:true,prefix_exit_code:0,prefix_source_evidence_ref:'new-pure:prefix-original'});
 Object.assign(records.global_after,{cwd:'/new-pure/cwd',path_value:'/new-pure/prefix/bin:/new-pure/bin:/usr/bin',node:command('/new-pure/bin/node'),npm:command('/new-pure/bin/npm'),root:'/new-pure/separate-root',root_exit_code:0,root_source_evidence_ref:'new-pure:root-original'});
 Object.assign(records.public_core,{cwd:records.global_after.cwd,path_value:records.global_after.path_value,node:structuredClone(records.global_after.node),npm:structuredClone(records.global_after.npm),root:records.global_after.root});
 return records;
}

for (const evidenceKind of ['configured', 'expected']) {
  test(`${evidenceKind} input never becomes observed`, () => {
    const view = contextPreflightView({ registration, records: originals(evidenceKind), evidenceKind });
    assert.equal(view.status, 'unknown');
    assert.equal(view.reason, 'evidence_kind_not_allowed');
    assert.deepEqual(view.observed, []);
  });
}

test('missing-missing principal/entry equality and invalid IDs do not admit a job', () => {
  const missing = originals();
  for (const value of Object.values(missing)) { delete value.uid; delete value.gid; }
  delete missing.job_input.entry_realpath;
  const invalid = contextPreflightView({ registration: {}, records: missing });
  assert.equal(invalid.status, 'unknown');
  assert.equal(invalid.reason, 'registration_identity_invalid');
  assert.deepEqual(invalid.observed, []);
  for (const bad of [undefined, null, -1, 1.5]) {
    for (const key of ['uid', 'primary_gid']) {
      const view = contextPreflightView({ registration: { ...registration, [key]: bad }, records: originals() });
      assert.equal(view.status, 'unknown');
      assert.deepEqual(view.observed, []);
    }
    for (const key of ['uid', 'gid']) {
      const records = originals(); records.job_input[key] = bad;
      assert.equal(contextPreflightView({ registration, records }).reason, 'actual_job_context_not_bound');
    }
  }
  for (const value of [undefined, '', 'relative/setup']) {
    const records = originals(); records.job_input.entry_realpath = value;
    assert.equal(contextPreflightView({ registration, records }).status, 'unknown');
    assert.equal(contextPreflightView({ registration: { ...registration, entry_realpath: value }, records: originals() }).status, 'unknown');
  }
});

test('three auxiliary originals require nonempty strings rather than booleans/objects/arrays', () => {
  const cases = [
    ['prefix_before', 'nvm_effect_review_ref', true, 'restoration_source_or_effect_review_missing'],
    ['global_bin', 'prefix_source_evidence_ref', { not: 'a ref' }, 'npm_prefix_original_missing'],
    ['global_after', 'root_source_evidence_ref', [], 'npm_root_not_observed'],
  ];
  for (const [stage, field, bad, reason] of cases) {
    for (const value of [bad, '', '   ']) {
      const records = originals(); records[stage][field] = value;
      const view = contextPreflightView({ registration, records });
      assert.equal(view.status, 'unknown');
      assert.equal(view.reason, reason);
      assert.equal(view.reporting_allowed, false);
      assert.equal(view.real_host_execution_authorized, false);
    }
  }
});

test('normal observed structures keep all originals and remain nonauthorizing', () => {
  const records = originals(); const view = contextPreflightView({ registration, records });
  assert.equal(view.status, 'observed_context_stages_only');
  assert.equal(view.observed.length, 5);
  assert.deepEqual(view.observed, Object.values(records));
  assert.equal(view.reporting_allowed, false);
  assert.equal(view.real_host_execution_authorized, false);
  assert.equal(view.resource_coverage, 'unknown');
  const rootRegistration = { ...registration, uid: 0, primary_gid: 0 };
  for (const value of Object.values(records)) { value.uid = 0; value.gid = 0; }
  assert.equal(contextPreflightView({ registration: rootRegistration, records }).status, 'observed_context_stages_only');
});

test('fixture structures retain fixture-only status and cannot pass observed mode', () => {
  const records = originals('fixture');
  const view = contextPreflightView({ registration, records, evidenceKind: 'fixture' });
  assert.equal(view.status, 'fixture_context_stages_only');
  assert.equal(view.reporting_allowed, false);
  assert.equal(view.real_host_execution_authorized, false);
  assert.equal(contextPreflightView({ registration, records }).status, 'unknown');
});
