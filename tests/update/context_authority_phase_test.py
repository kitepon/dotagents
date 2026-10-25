"""Only new begin/result composition; authority/kernel are synthetic fixtures."""
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


core = load('phase_core', 'lib/factory/update_context_core.py')
store = load('phase_store', 'bin/factory-update-context-observer.py')
trust = load('phase_trust', 'lib/factory/update_context_trust.py')
fixtures = load('phase_subject_fixtures', 'tests/update/context_trust_adapter_test.py')


class PhaseCompositionTests(unittest.TestCase):
    def run_pair(self, change=None):
        frame = b'{"fixture":"phase composition only"}\n'
        admission = dict(schema='gpt-connector.core-frame-admission.v1', policy='setup_v1_private_metadata_v1',
                         decision='full_frame', reason='accepted', frame_sha256=trust.digest(frame), frame_bytes=len(frame))
        runtime = dict(pid=222, ppid=111, uid=os.geteuid(), gid=os.getegid(), cwd='/fixture',
                       exec_path='/fixture/node', process_version='v24.22.1', entry_path='/fixture/core')
        observed = dict(process_identity='fixture:product', process=dict(ppid=111,
                        uid_fields=[os.geteuid()] * 4, gid_fields=[os.getegid()] * 4),
                        kernel_identity=dict(pid=222, effective_uid=os.geteuid(), effective_gid=os.getegid(),
                                             cwd='/fixture', executable_realpath='/fixture/node'),
                        parent_chain=[dict(identity='fixture:factory'), dict(identity='fixture:launcher')],
                        entry_realpath='/fixture/core', entry_sha256='a' * 64)
        shared = SimpleNamespace(read_original=store.read_private_original, publish=store.publish_original, error=store.ObservationError)
        def response(request):
            subjects = dict(factory=fixtures.subject('factory', dict(path='/fixture/bridge', sha256='b' * 64)),
                            product=fixtures.subject('product', dict(path='/fixture/core', sha256='a' * 64)))
            for subject in subjects.values():
                _raw, checks = trust.original(subject['verification_original'])
                # A current-verification record can differ each phase while
                # the accepted source/receipt and trust remain the same.
                checks['verified_phase'] = request['phase']
                if change == 'receipt' and request['phase'] == 'core_result':
                    _raw, receipt = trust.original(subject['receipt_original'])
                    receipt['fixture_generation'] = 'changed'
                    subject['receipt_original'] = fixtures.packet(receipt)
                    checks['receipt_original_sha256'] = subject['receipt_original']['sha256']
                    checks['current_receipt_sha256'] = subject['receipt_original']['sha256']
                subject['verification_original'] = fixtures.packet(checks)
            return dict(status='verified', kind='fixture', binding=request, subjects=subjects)
        class Channel:
            def exchange(self, request): return response(request)
        old_snapshot = core.snapshot
        core.snapshot = lambda _args, _shared: copy.deepcopy(observed)
        try:
            with tempfile.TemporaryDirectory(prefix='authority-phase-') as directory:
                now = time.time_ns() // 1000000; expires = now + 60000
                for name, value in {
                    'launcher_input.json': dict(launcher_identity='fixture:launcher', capture_expires_at_utc_ms=expires, observed_at_utc_ms=now),
                    'public_setup_before.json': dict(phase='public_setup_before', process_identity='fixture:factory',
                        launcher_identity='fixture:launcher', capture_expires_at_utc_ms=expires, observed_at_utc_ms=now,
                        entry_realpath='/fixture/bridge', entry_sha256='b' * 64),
                }.items():
                    path = Path(directory) / name; path.write_text(json.dumps(value)); path.chmod(0o600)
                outputs, saved = {}, {}
                control = dict(mode='setup', run_id='fixture-same-run', runtime_self=runtime)
                for phase in ['core_begin', 'core_result']:
                    if phase == 'core_result':
                        control['core_started_original'] = outputs['core_begin']['original']
                        control['completion'] = dict(completed_at_utc_ms=time.time_ns() // 1000000, exit_code=2,
                            serialized_result_sha256=trust.digest(frame), serialized_result_bytes=len(frame),
                            stdout_write='callback_completed', frame_admission=admission)
                        if change == 'run': control['run_id'] = 'fixture-another-run'
                    args = SimpleNamespace(phase=phase, output_dir=directory, expires_at=expires,
                                           entry='/fixture/core', core_control_json=json.dumps(control))
                    activate, verify, _originals = trust.create_core_ports(Channel(), sender_identity='fixture:factory',
                        retain_original=lambda args, body: trust.retain_authority(args, shared, body))
                    outputs[phase] = core.handle_core(args, shared, verify_activation=activate,
                                                     verify_frame=verify, frame_input=io.BytesIO(frame))
                for path in Path(directory).iterdir():
                    raw = path.read_bytes()
                    saved[path.name] = {'raw': raw, 'json': json.loads(raw) if path.suffix == '.json' else None}
                return outputs, saved, frame
        finally:
            core.snapshot = old_snapshot

    def test_new_phase_pair_keeps_stable_subject_and_distinct_exact_originals(self):
        outputs, saved, frame = self.run_pair()
        self.assertEqual([outputs[phase]['status'] for phase in ['core_begin', 'core_result']], ['recorded_raw', 'recorded_raw'])
        begin, result = saved['core_begin.json']['json'], saved['core_result.json']['json']
        self.assertEqual(begin['activation_provenance_ref'], result['activation_provenance_ref'])
        self.assertNotEqual(begin['authority_original'], result['authority_original'])
        self.assertEqual(result['completion']['exit_code'], 2)
        self.assertEqual(result['completion']['stdout_write'], 'callback_completed')
        self.assertEqual(saved['core_result.frame']['raw'], frame)
        self.assertFalse(result['reporting_allowed']); self.assertFalse(result['resource_read_authorized'])
        authority = {}
        for phase, metadata in [('core_begin', begin), ('core_result', result)]:
            ref = metadata['authority_original']; raw = saved[ref['ref']]['raw']
            self.assertEqual((ref['sha256'], ref['bytes']), (trust.digest(raw), len(raw)))
            authority[phase] = json.loads(raw)
            self.assertEqual(authority[phase]['binding']['phase'], phase)
        self.assertEqual(authority['core_begin']['activation_subject'], authority['core_result']['activation_subject'])
        self.assertNotEqual(authority['core_begin']['binding']['control_sha256'], authority['core_result']['binding']['control_sha256'])
        self.assertNotEqual(authority['core_begin']['product']['verification_original'], authority['core_result']['product']['verification_original'])

    def test_changed_receipt_remains_rejected_without_frame_save(self):
        outputs, saved, _frame = self.run_pair('receipt')
        self.assertEqual(outputs['core_begin']['status'], 'recorded_raw')
        self.assertEqual(outputs['core_result']['reason'], 'core_run_mismatch')
        self.assertNotIn('core_result.frame', saved)
        self.assertIn('core_result.authority.json', saved)

    def test_changed_run_remains_rejected_without_frame_save(self):
        outputs, saved, _frame = self.run_pair('run')
        self.assertEqual(outputs['core_begin']['status'], 'recorded_raw')
        self.assertEqual(outputs['core_result']['reason'], 'core_run_mismatch')
        self.assertNotIn('core_result.frame', saved)


if __name__ == '__main__':
    unittest.main()
