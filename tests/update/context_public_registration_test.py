"""New dedicated process conditions only; no normal setup/issuer/host actions."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
PRELOAD = ROOT / 'lib/factory/update-context-product-preload.mjs'
ARTIFACTS = os.environ.get('DOTAGENTS_TEST_ARTIFACT_DIR')

def retain(name, source, stdout, stderr):
    if not ARTIFACTS: return
    target = Path(ARTIFACTS) / name;target.mkdir(parents=True, mode=0o700)
    for path in Path(source).iterdir():
        if path.is_file(): shutil.copy2(path, target / path.name)
    for label, raw in [('stdout.raw',stdout),('stderr.raw',stderr)]:
        path=target / label;path.write_bytes(raw);path.chmod(0o600)


@unittest.skipUnless(sys.platform == 'linux', 'Linux private descriptor source only')
class PublicRegistrationTests(unittest.TestCase):
    def test_real_before_receipt_returns_to_same_factory_and_prepares_nonreplacement_record(self):
        with tempfile.TemporaryDirectory() as directory:
            env = dict(os.environ, DOTAGENTS_UPDATE_CONTEXT_OBSERVER='1', DOTAGENTS_UPDATE_CONTEXT_DIR=directory,
                       DOTAGENTS_UPDATE_CONTEXT_EXPIRES_AT=str(int(time.time() * 1000) + 60000))
            result = subprocess.run([shutil.which('node'), str(ROOT / 'tests/update/public_registration_fixture.mjs')], env=env, capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr.decode())
            retain('before-bootstrap', directory, result.stdout, result.stderr)
            value = json.loads(result.stdout)
            self.assertTrue(value['same_factory_pid'])
            self.assertEqual(value['forged_receipt'], 'unknown')
            self.assertEqual(value['second_preparation'], 'unknown')
            self.assertFalse(value['reporting_allowed'])
            self.assertFalse(value['resource_read_authorized'])

    def preload(self, invalid=False, fault=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); activation = root / 'private'; activation.mkdir(mode=0o700)
            (root / 'package.json').write_text('{"type":"module"}')
            registration = root / 'update-ledger-core-registration.js'
            registration.write_text('export let calls=0; export function registerCoreHelperBootstrap(b){ if(calls||typeof b.start!=="function")throw Error();calls++; }\n')
            entry = root / 'cli.js'
            entry.write_text('import {calls} from "./update-ledger-core-registration.js"; process.stdout.write(JSON.stringify({registered:calls,entry:process.argv[1]})+"\\n");process.exitCode=2;\n')
            def packet(path):
                raw = path.read_bytes();return dict(path=str(path), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
            record = dict(schema='dotagents.core-preload.v1', activation=str(activation), expires_at=int(time.time() * 1000) + 60000,
                          before_original=dict(ref='public_setup_before.json',sha256='a'*64,bytes=1),
                          product_entry=packet(entry), registration=packet(registration), factory_preload=packet(PRELOAD))
            if invalid: record['registration']['sha256'] = 'b' * 64
            reader, writer = os.pipe(); left, right = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
            code = '''import fcntl,os,sys
s=fcntl.fcntl(int(sys.argv[1]),fcntl.F_DUPFD_CLOEXEC,10)
r=fcntl.fcntl(int(sys.argv[2]),fcntl.F_DUPFD_CLOEXEC,10)
os.dup2(s,4,inheritable=True);os.dup2(r,7,inheritable=True)
os.close(s);os.close(r)
for f in [int(sys.argv[1]),int(sys.argv[2])]:
 if f not in [4,7]:os.close(f)
os.execve(sys.argv[3],[sys.argv[3],'--import',sys.argv[4],sys.argv[5]],dict(os.environ))'''
            try:
                child = subprocess.Popen(['/usr/bin/python3','-I','-S','-c',code,str(right.fileno()),str(reader),shutil.which('node'),str(PRELOAD),str(entry)], pass_fds=(right.fileno(),reader),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
                os.close(reader);reader=-1
                wire=(json.dumps(record)+'\n').encode()
                if fault=='utf8':wire=b'\xff'
                if fault=='partial':wire=wire[:-3]
                os.write(writer,wire)
                if fault!='no_eof':os.close(writer);writer=-1
                out, err = child.communicate(timeout=6)
                self.assertEqual(child.returncode,2,err.decode());self.assertEqual(err,b'')
                retain('preload-'+fault if fault else 'preload-reject' if invalid else 'preload-register', root, out, err)
                if ARTIFACTS:
                    path=Path(ARTIFACTS)/('preload-'+fault if fault else 'preload-reject' if invalid else 'preload-register')/'record.original.json';path.write_text(json.dumps(record)+'\n');path.chmod(0o600)
                result=json.loads(out);self.assertEqual(result['entry'],str(entry));return result
            finally:
                if reader>=0:os.close(reader)
                if writer>=0:os.close(writer)
                left.close();right.close()
                if 'child' in locals() and child.poll() is None:
                    try:child.wait(timeout=2)
                    except subprocess.TimeoutExpired:child.kill();child.wait(timeout=2)

    def test_fixed_preload_shares_exact_cli_registration_identity_and_preserves_argv_and_exit(self):
        self.assertEqual(self.preload()['registered'],1)

    def test_changed_module_bytes_never_register_and_do_not_replace_ordinary_exit(self):
        self.assertEqual(self.preload(invalid=True)['registered'],0)

    def test_invalid_utf8_partial_json_or_absent_eof_never_registers(self):
        for fault in ['utf8','partial','no_eof']:
            self.assertEqual(self.preload(fault=fault)['registered'],0)


if __name__ == '__main__': unittest.main()
