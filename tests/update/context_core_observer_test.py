import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = Path(os.environ.get('DOTAGENTS_CORE_FIXTURE_ROOT', str(ROOT / 'artifacts/2026-10-25-core-observer/fixtures')))
DRIVER = Path(__file__).with_name('core_observer_fixture.py')
NODE = shutil.which('node')
FRAME = b'{"schema":"gpt-connector.setup.v1","version":"0.16.4","overall":"partial"}\n'

FACTORY = r'''
import fs from 'node:fs';import cp from 'node:child_process';
const cfg=JSON.parse(process.argv[2]);
const self=()=>({pid:process.pid,ppid:process.ppid,uid:process.getuid(),gid:process.getgid(),cwd:process.cwd(),exec_path:process.execPath,process_version:process.version,entry_path:process.argv[1]});
const boot=cp.spawnSync(cfg.python,[cfg.driver,cfg.case,'fixture_bootstrap',cfg.directory,String(cfg.expiry),JSON.stringify({runtime_self:self()})],{stdio:['pipe','pipe','pipe','pipe'],timeout:2500});
if(boot.status!==0)throw Error('bootstrap failed '+boot.stderr);
if(cfg.case==='pending')fs.writeFileSync(cfg.directory+'/interrupted.pending','original-interrupted',{mode:0o600});
const child=cp.spawnSync(process.execPath,[cfg.core,JSON.stringify(cfg)],{stdio:['pipe','pipe','pipe'],timeout:12000});
fs.writeFileSync(cfg.directory+'/core.stdout',child.stdout??'');fs.writeFileSync(cfg.directory+'/core.stderr',child.stderr??'');
if(child.status!==0)throw Error('core fixture failed '+child.stderr);
console.log('factory-normal-result');
'''

CORE = r'''
import fs from 'node:fs';import cp from 'node:child_process';import crypto from 'node:crypto';
const cfg=JSON.parse(process.argv[2]);let self={pid:process.pid,ppid:process.ppid,uid:process.getuid(),gid:process.getgid(),cwd:process.cwd(),exec_path:process.execPath,process_version:process.version,entry_path:process.argv[1]};
if(cfg.case==='wrong_uid')self.uid++;
const base={mode:'setup',run_id:'fixture-core-run',runtime_self:self};
function invoke(phase,control,input=Buffer.alloc(0),entry=cfg.driver){
 const args=entry===cfg.driver?[cfg.driver,cfg.case,phase,cfg.directory,String(cfg.expiry),JSON.stringify(control)]:[entry,'--phase',phase,'--parent-pid',String(process.pid),'--entry',process.argv[1],'--output-dir',cfg.directory,'--expires-at',String(cfg.expiry),'--core-control-json',JSON.stringify(control)];
 const started=Date.now();
 const priorMask=cfg.case==='restrictive_umask'?process.umask(0o777):null;
 const p=cp.spawnSync(cfg.python,args,{input,stdio:['pipe','pipe','pipe','pipe'],timeout:2500,maxBuffer:65536});
 if(priorMask!==null)process.umask(priorMask);
 const reply=p.output?.[3]?.length?JSON.parse(p.output[3].toString()):null;
 fs.writeFileSync(cfg.directory+'/'+phase+'.stdout',p.stdout??'');fs.writeFileSync(cfg.directory+'/'+phase+'.stderr',p.stderr??'');
 return {reply,exit:p.status,error:p.error?.code??null,elapsed_ms:Date.now()-started,reply_bytes:p.output?.[3]?.length??0};
}
const startControl=cfg.case==='live_no_adapter'?{...base,expected_source_pins:{'/caller/fake':'0'.repeat(64)}}:base;
const start=invoke('core_begin',startControl,Buffer.alloc(0),cfg.case==='live_no_adapter'?cfg.entry:cfg.driver);
let result=null,second=null;
if(start.reply?.status==='recorded_raw'){
 const frame=fs.readFileSync(cfg.frame_file), digest=crypto.createHash('sha256').update(frame).digest('hex');
 const control={...base,core_started_original:{...start.reply.original},completion:{completed_at_utc_ms:Date.now(),exit_code:2,serialized_result_sha256:digest,serialized_result_bytes:frame.length,stdout_write:cfg.case==='write_failed'?'failed':'callback_completed',frame_admission:{schema:'gpt-connector.core-frame-admission.v1',policy:'setup_v1_private_metadata_v1',decision:['denied_frame','bad_metadata_digest'].includes(cfg.case)?'metadata_only':'full_frame',frame_sha256:digest,frame_bytes:frame.length,reason:['denied_frame','bad_metadata_digest'].includes(cfg.case)?'unsupported_fields':'accepted'}}};
 if(cfg.case==='bad_metadata_digest')control.completion.frame_admission.frame_sha256='0'.repeat(64);
 if(cfg.case==='wrong_admission')control.completion.frame_admission.frame_sha256='0'.repeat(64);
 if(cfg.case==='wrong_admission_length')control.completion.frame_admission.frame_bytes++;
 if(cfg.case==='wrong_policy')control.completion.frame_admission.policy='unadopted_policy';
 if(cfg.case==='wrong_run')control.run_id='different-run';
 if(cfg.case==='wrong_ref')control.core_started_original.ref='/outside/must-not-read';
 if(cfg.case==='wrong_digest')control.completion.serialized_result_sha256='0'.repeat(64);
 const permitted=control.completion.frame_admission.decision==='full_frame'&&control.completion.stdout_write==='callback_completed';
 result=invoke('core_result',control,permitted?frame:Buffer.alloc(0));
 if(cfg.case==='duplicate'||cfg.case==='crash_after_frame')second=invoke('core_result',control,frame);
}
fs.writeFileSync(cfg.directory+'/result.json',JSON.stringify({start,result,second}));
console.log('original-partial-code2');
'''


@unittest.skipUnless(sys.platform == 'linux' and NODE, 'dedicated Linux process fixture only')
class CoreTests(unittest.TestCase):
    def run_case(self, case='positive', frame=FRAME, root_mode=0o700):
        directory = FIXTURES / str(uuid.uuid4())
        directory.mkdir(parents=True, mode=0o700)
        factory, core = directory / 'factory.mjs', directory / 'core.mjs'
        factory.write_text(FACTORY); core.write_text(CORE)
        cfg = {'case': case, 'directory': str(directory), 'core': str(core), 'python': sys.executable,
               'driver': str(DRIVER), 'entry': str(ROOT / 'bin/factory-update-context-observer.py'),
               'expiry': time.time_ns() // 1000000 + 60000,
               'frame_file': str(directory / 'input-frame.bytes')}
        (directory / 'input-frame.bytes').write_bytes(frame)
        (directory / 'input-frame.bytes').chmod(0o600)
        if case == 'alias_root':
            alias = directory.parent / (directory.name + '-alias')
            alias.symlink_to(directory, target_is_directory=True)
            cfg['directory'] = str(alias)
        pins = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [factory, core, ROOT / 'bin/factory-update-context-observer.py', ROOT / 'lib/factory/update_context_core.py']}
        policy = {'kind': 'fixture', 'source_pins': pins, 'core_entry_sha256': pins[str(core)], 'factory_entry_sha256': pins[str(factory)]}
        (directory / 'fixture-policy.json').write_text(json.dumps(policy))
        (directory / 'fixture-policy.json').chmod(0o600)
        directory.chmod(root_mode)
        run = subprocess.run([NODE, str(factory), json.dumps(cfg)], cwd=directory, capture_output=True, text=True, timeout=15)
        (directory / 'factory.stdout').write_text(run.stdout); (directory / 'factory.stderr').write_text(run.stderr)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(run.stdout, 'factory-normal-result\n')
        self.assertEqual((directory / 'core.stdout').read_text(), 'original-partial-code2\n')
        result = json.loads((directory / 'result.json').read_text())
        for phase in ['core_begin', 'core_result']:
            path = directory / (phase + '.stdout')
            if path.exists(): self.assertEqual(path.read_bytes(), b'')
        return directory, result

    def test_exact_frame_readback_fd3_actual_parent_and_partial_code(self):
        directory, result = self.run_case()
        self.assertEqual(result['start']['reply']['kind'], 'fixture_core')
        reply = result['result']['reply']; self.assertEqual(reply['status'], 'recorded_raw')
        self.assertEqual((directory / 'core_result.frame').read_bytes(), FRAME)
        self.assertEqual(reply['result_original']['sha256'], hashlib.sha256(FRAME).hexdigest())
        self.assertEqual(reply['result_original']['bytes'], len(FRAME))
        packet = json.loads((directory / 'core_result.json').read_text())
        self.assertEqual(packet['completion']['exit_code'], 2)
        self.assertEqual(packet['kernel_identity']['effective_uid'], os.geteuid())
        self.assertEqual(packet['public_setup_before']['sha256'], hashlib.sha256((directory / 'public_setup_before.json').read_bytes()).hexdigest())
        self.assertFalse(packet['reporting_allowed']); self.assertFalse(packet['resource_read_authorized'])
        for name in ['core_begin.json', 'core_result.json', 'core_result.frame']:
            self.assertEqual((directory / name).stat().st_mode & 0o777, 0o600)

    def test_live_cli_has_no_trusted_adapter_and_cannot_adopt_caller_pins(self):
        directory, result = self.run_case('live_no_adapter')
        self.assertEqual(result['start']['reply']['reason'], 'expected_pins_provenance_missing')
        self.assertFalse((directory / 'core_begin.json').exists())

    def test_wrong_runtime_or_factory_ancestor_stops_before_core_original(self):
        for case, reason in [('wrong_uid', 'runtime_mismatch'), ('wrong_factory_parent', 'factory_parent_not_ancestor'), ('untrusted_pins', 'expected_pins_provenance_unconfirmed')]:
            directory, result = self.run_case(case)
            self.assertEqual(result['start']['reply']['reason'], reason)
            self.assertFalse((directory / 'core_begin.json').exists())

    def test_same_run_and_exact_begin_ref_required(self):
        for case, reason in [('wrong_run', 'core_run_mismatch'), ('wrong_ref', 'core_begin_ref_mismatch')]:
            directory, result = self.run_case(case)
            self.assertEqual(result['result']['reply']['reason'], reason)
            self.assertFalse((directory / 'core_result.frame').exists())

    def test_gate_denial_and_digest_or_output_failure_keep_metadata_only_null(self):
        for case, reason in [('denied_frame', 'product_admission_unknown'), ('wrong_digest', 'frame_digest_or_size_mismatch'), ('write_failed', 'output_unconfirmed')]:
            directory, result = self.run_case(case)
            reply = result['result']['reply']; self.assertEqual(reply['status'], 'unknown'); self.assertEqual(reply['reason'], reason)
            self.assertIsNone(reply['result_original']); self.assertFalse((directory / 'core_result.frame').exists())
            packet = json.loads((directory / 'core_result.json').read_text())
            self.assertEqual(packet['completion']['exit_code'], 2)

    def test_frame_limit_utf8_and_termination_reject_without_projection(self):
        for frame, reason in [(b'x' * 65537, 'frame_too_large'), (b'\xff\n', 'frame_utf8_invalid'), (FRAME[:-1], 'frame_termination_invalid')]:
            directory, result = self.run_case(frame=frame)
            self.assertEqual(result['result']['reply']['reason'], reason)
            self.assertFalse((directory / 'core_result.frame').exists())

    def test_duplicate_and_crash_orphan_never_replace_or_resurrect(self):
        for case in ['duplicate', 'crash_after_frame']:
            directory, result = self.run_case(case)
            self.assertEqual((directory / 'core_result.frame').read_bytes(), FRAME)
            self.assertEqual(result['second']['reply']['reason'], 'result_present_or_orphan_retained')
            if case == 'crash_after_frame':
                self.assertEqual(result['result']['exit'], 99)
                self.assertIsNone(result['result']['reply'])
                self.assertFalse((directory / 'core_result.json').exists())

    def test_admission_hash_and_length_must_match_same_completion_frame(self):
        for case in ['wrong_admission', 'wrong_admission_length']:
            directory, result = self.run_case(case)
            self.assertEqual(result['result']['reply']['reason'], 'admission_digest_or_size_mismatch')
            self.assertFalse((directory / 'core_result.frame').exists())
            self.assertIsNone(result['result']['reply']['result_original'])

    def test_pending_original_and_reply_size_limit_are_not_bypassed(self):
        directory, result = self.run_case('pending')
        self.assertEqual(result['start']['reply']['reason'], 'incomplete_original_retained')
        self.assertEqual((directory / 'interrupted.pending').read_text(), 'original-interrupted')
        directory, result = self.run_case('oversized_reply')
        self.assertEqual(result['start']['reply']['reason'], 'reply_too_large')
        self.assertLessEqual(result['start']['reply_bytes'], 16384)
        self.assertFalse((directory / 'core_begin.json').exists())

    def test_incomplete_frame_read_has_owned_child_deadline_and_no_result_ref(self):
        directory, result = self.run_case('stall_frame')
        self.assertEqual(result['result']['reply']['status'], 'unknown')
        self.assertLess(result['result']['elapsed_ms'], 2500)
        self.assertFalse((directory / 'core_result.frame').exists())
        self.assertIsNone(result['result']['reply']['result_original'])

    def test_exact_maximum_frame_transport_keeps_all_original_bytes(self):
        frame = FRAME[:-1] + b' ' * (65536 - len(FRAME)) + b'\n'
        directory, result = self.run_case(frame=frame)
        self.assertEqual(result['result']['reply']['status'], 'recorded_raw')
        self.assertEqual((directory / 'core_result.frame').read_bytes(), frame)
        self.assertEqual(result['result']['reply']['result_original']['bytes'], 65536)

    def test_alias_activation_and_restrictive_umask_are_not_repaired(self):
        directory, result = self.run_case('alias_root')
        self.assertEqual(result['start']['reply']['reason'], 'activation_alias_unaccepted')
        self.assertFalse((directory / 'core_begin.json').exists())
        directory, result = self.run_case('restrictive_umask')
        self.assertEqual(result['start']['reply']['status'], 'unknown')
        self.assertFalse((directory / 'core_begin.json').exists())
        self.assertEqual((directory / 'core_begin.pending').stat().st_mode & 0o777, 0)

    def test_unadopted_frame_policy_cannot_issue_original(self):
        directory, result = self.run_case('wrong_policy')
        self.assertEqual(result['result']['reply']['reason'], 'frame_admission_shape_invalid')
        self.assertFalse((directory / 'core_result.frame').exists())

    def test_private_root_mismatch_is_not_repaired_or_accepted(self):
        directory, result = self.run_case(root_mode=0o777)
        self.assertEqual(result['start']['reply']['reason'], 'activation_not_private')
        self.assertEqual(directory.stat().st_mode & 0o777, 0o777)
        self.assertFalse((directory / 'core_begin.json').exists())


if __name__ == '__main__':
    unittest.main()
