"""New real helper/fd4 wire with fixture subjects. No actual issuer/artifact."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import signal
import socket
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


store = load('broker_fixture_store', 'bin/factory-update-context-observer.py')
broker_source = load('new_core_broker', 'lib/factory/update_context_broker.py')
fixtures = load('broker_subject_fixtures', 'tests/update/context_trust_adapter_test.py')


@unittest.skipUnless(sys.platform == 'linux' and shutil.which('node'), 'Linux node/helper kernel wire only')
class BootstrapBrokerTests(unittest.TestCase):
    def run_wire(self, missing=False, wrong_product=False, verifier_error=False):
        fixture_entry = ROOT / 'tests/update/core_bootstrap_product_fixture.mjs'
        shared = SimpleNamespace(process_identity=store.process_identity, token=store.token)
        with tempfile.TemporaryDirectory(prefix='core-wire-') as directory:
            now = time.time_ns() // 1000000; expires = now + 60000
            sender = store.process_identity(os.getpid())
            boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip(); identity = store.token(boot, sender)
            before = dict(phase='public_setup_before', process_identity=identity, launcher_identity=identity,
                          capture_expires_at_utc_ms=expires, observed_at_utc_ms=now,
                          entry_realpath=str(Path(__file__).resolve()), entry_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
            values = {'launcher_input.json': dict(launcher_identity=identity, capture_expires_at_utc_ms=expires, observed_at_utc_ms=now),
                      'public_setup_before.json': before,
                      'core_authority_bootstrap.json': dict(schema='dotagents.core-authority-bootstrap.v1', activation=directory,
                          expires_at=expires, factory_identity=identity, sender=sender)}
            for name, value in values.items():
                path = Path(directory) / name; path.write_text(json.dumps(value)); path.chmod(0o600)
            before_bytes = (Path(directory) / 'public_setup_before.json').read_bytes()
            before_ref = {'ref': 'public_setup_before.json', 'sha256': hashlib.sha256(before_bytes).hexdigest(), 'bytes': len(before_bytes)}
            server, client = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            server.setsockopt(socket.SOL_SOCKET, socket.SO_PASSCRED, 1)
            read_out, write_out = os.pipe()
            pid = os.fork()
            if pid == 0:
                try:
                    server.close(); os.close(read_out)
                    if client.fileno() != 4: os.dup2(client.fileno(), 4)
                    os.set_inheritable(4, True); os.dup2(write_out, 1)
                    if write_out not in {1, 4}: os.close(write_out)
                    command = [shutil.which('node'), str(fixture_entry), directory, str(expires)]
                    if os.environ.get('CORE_PRODUCT_BRIDGE_SOURCE'): command.append(os.environ['CORE_PRODUCT_BRIDGE_SOURCE'])
                    os.execv(command[0], command)
                except BaseException:
                    os._exit(99)
            client.close(); os.close(write_out)
            calls = []
            def verify_subjects(request):
                calls.append(request)
                if verifier_error: raise RuntimeError('private-verifier-sentinel')
                return {'factory': fixtures.subject('factory', {'path': before['entry_realpath'], 'sha256': before['entry_sha256']}),
                        'product': fixtures.subject('product', request['entry'])}
            broker = broker_source.CoreAuthorityBroker(server, product_pid=pid if not wrong_product else os.getpid(),
                product_entry=str(fixture_entry), activation=directory, expires_at=expires, before_ref=before_ref,
                shared=shared, verify_subjects=None if missing else verify_subjects, evidence_kind='fixture')
            try:
                statuses = [broker.serve_once()]
                if statuses[0] == 'verified': statuses.append(broker.serve_once())
                if not select.select([read_out], [], [], 5)[0]: raise AssertionError('fixture product output timeout')
                raw = os.read(read_out, 65536)
                waited, status = os.waitpid(pid, 0); pid = None
                self.assertEqual(os.waitstatus_to_exitcode(status), 0, raw)
                result = json.loads(raw)
                saved = {path.name: path.read_bytes() for path in Path(directory).iterdir() if path.is_file()}
                return result, saved, calls, statuses
            finally:
                server.close(); os.close(read_out)
                if pid is not None:
                    try: os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError: pass
                    os.waitpid(pid, 0)

    def test_actual_helper_fd4_pair_and_exact_frame_remain_fixture(self):
        result, saved, calls, statuses = self.run_wire()
        self.assertEqual(statuses, ['verified', 'verified'])
        self.assertEqual([result[key]['status'] for key in ['begin', 'result']], ['recorded_raw', 'recorded_raw'])
        self.assertEqual(result['result']['kind'], 'fixture_core')
        self.assertEqual(saved['core_result.frame'], b'{"fixture":"kernel transport only"}\n')
        begin, end = [json.loads(saved[key]) for key in ['core_begin.json', 'core_result.json']]
        self.assertEqual(begin['activation_provenance_ref'], end['activation_provenance_ref'])
        self.assertNotEqual(begin['authority_original'], end['authority_original'])
        self.assertEqual(end['completion']['exit_code'], 2); self.assertEqual(end['completion']['stdout_write'], 'callback_completed')
        self.assertEqual(len(calls), 2); self.assertFalse(end['reporting_allowed']); self.assertFalse(end['resource_read_authorized'])

    def test_absent_verifier_cannot_save_full_frame(self):
        result, saved, calls, statuses = self.run_wire(missing=True)
        self.assertEqual(statuses, ['unknown']); self.assertEqual(result['begin']['status'], 'unknown')
        self.assertEqual(calls, []); self.assertNotIn('core_result.frame', saved)

    def test_verifier_failure_returns_unknown_without_private_exception(self):
        result, saved, calls, statuses = self.run_wire(verifier_error=True)
        self.assertEqual(statuses, ['unknown']); self.assertEqual(result['begin']['status'], 'unknown')
        self.assertEqual(len(calls), 1); self.assertNotIn('core_result.frame', saved)
        self.assertNotIn('private-verifier-sentinel', json.dumps(result))

    def test_foreign_product_pid_rejected_before_verifier(self):
        result, saved, calls, statuses = self.run_wire(wrong_product=True)
        self.assertEqual(statuses, ['unknown']); self.assertEqual(result['begin']['status'], 'unknown')
        self.assertEqual(calls, []); self.assertNotIn('core_result.frame', saved)


if __name__ == '__main__': unittest.main()
