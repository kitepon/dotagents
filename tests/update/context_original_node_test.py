"""New original Node sender + actual kernel/helper + original reader source only."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(sys.platform == 'linux' and shutil.which('node'), 'Linux original-Node authority only')
class OriginalNodeTests(unittest.TestCase):
    def run_node(self, mode):
        with tempfile.TemporaryDirectory(prefix='original-node-') as directory:
            expires = str(time.time_ns() // 1000000 + 60000)
            # The pre-exec port is called by adopted dispatcher source; this
            # local launcher is a fixture and provides no production trust.
            code = '''import importlib.util,os,sys
spec=importlib.util.spec_from_file_location('fixed_pair',sys.argv[1]); value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value)
value.exec_original_factory(sys.argv[2],sys.argv[3],sys.argv[4:],dict(os.environ))'''
            command = [sys.executable, '-I', '-S', '-c', code, str(ROOT / 'lib/factory/update_context_socketpair.py'),
                       os.path.realpath(shutil.which('node')), str(ROOT / 'tests/update/original_node_factory_fixture.mjs'), directory, expires, mode]
            if os.environ.get('CORE_PRODUCT_BRIDGE_SOURCE'): command.append(os.environ['CORE_PRODUCT_BRIDGE_SOURCE'])
            child = subprocess.run(command, capture_output=True, text=True, timeout=8)
            self.assertEqual(child.returncode, 0, child.stderr)
            result = json.loads(child.stdout)
            files = {p.name: p.read_bytes() for p in Path(directory).iterdir() if p.is_file()}
            if os.environ.get('CORE_NODE_EVIDENCE_DIR'):
                output = Path(os.environ['CORE_NODE_EVIDENCE_DIR']) / mode
                output.mkdir(parents=True, exist_ok=False)
                (output / 'product-factory-result.json').write_text(json.dumps(result, indent=2) + '\n')
                for name, raw in files.items():
                    target = output / name
                    target.write_bytes(raw); target.chmod(0o600)
            return result, files

    def test_original_node_credentials_and_held_lease_subjects(self):
        result, files = self.run_node('full')
        self.assertEqual(result['outcome']['status'], 'completed')
        normal = result['outcome']['normal_result']; self.assertEqual(normal['statuses'], ['verified', 'verified'])
        self.assertEqual(normal['result']['result']['kind'], 'fixture_core')
        self.assertEqual(files['core_result.frame'], b'{"fixture":"kernel transport only"}\n')
        phase = json.loads(files['core_result.json'])
        self.assertEqual(phase['completion']['exit_code'], 2); self.assertFalse(phase['reporting_allowed'])
        authority = json.loads(files['core_result.authority.json'])
        self.assertEqual(authority['binding']['factory_identity'].split(':')[1], str(normal['factory_pid']))
        self.assertEqual(result['counts']['subject'], 2)
        self.assertTrue(result['leases_released'] and result['escaped_verifier_rejected'])

    def test_missing_real_issuer_resolver_stays_unknown(self):
        result, files = self.run_node('missing')
        self.assertEqual(result['outcome']['normal_result']['statuses'], ['unknown'])
        self.assertEqual(result['outcome']['normal_result']['result']['begin']['status'], 'unknown')
        self.assertNotIn('core_result.frame', files)

    def test_missing_kernel_reader_whole_source_role_cannot_record_core(self):
        result, files = self.run_node('incomplete')
        self.assertEqual(result['outcome']['normal_result']['result']['begin']['status'], 'unknown')
        self.assertNotIn('core_result.frame', files)

    def test_foreign_product_rejected_before_subjects(self):
        result, files = self.run_node('wrong')
        self.assertEqual(result['outcome']['normal_result']['statuses'], ['kernel_unconfirmed'])
        self.assertEqual(result['counts']['subject'], 0); self.assertNotIn('core_result.frame', files)


if __name__ == '__main__': unittest.main()
