"""Fixture origins only; the parent is the original Node factory process."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


store = load('node_fixture_store', 'bin/factory-update-context-observer.py')
fixtures = load('node_fixture_subjects', 'tests/update/context_trust_adapter_test.py')
directory, expires, factory_entry, product_entry = sys.argv[1:]
sender = store.process_identity(os.getppid()); boot = Path('/proc/sys/kernel/random/boot_id').read_text().strip()
identity = store.token(boot, sender); now = time.time_ns() // 1000000
before = dict(phase='public_setup_before', process_identity=identity, launcher_identity=identity,
              capture_expires_at_utc_ms=int(expires), observed_at_utc_ms=now,
              entry_realpath=factory_entry, entry_sha256=hashlib.sha256(Path(factory_entry).read_bytes()).hexdigest())
values = {'launcher_input.json': dict(launcher_identity=identity, capture_expires_at_utc_ms=int(expires), observed_at_utc_ms=now),
          'public_setup_before.json': before,
          'core_authority_bootstrap.json': dict(schema='dotagents.core-authority-bootstrap.v1', activation=directory,
              expires_at=int(expires), factory_identity=identity, sender=sender)}
fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
try:
    refs = {}
    for name, value in values.items(): refs[name] = store.publish_original(fd, name, (json.dumps(value) + '\n').encode(), readback=True)
finally: os.close(fd)
subjects = {'factory': fixtures.subject('factory', {'path': factory_entry, 'sha256': before['entry_sha256']}),
            'product': fixtures.subject('product', {'path': product_entry, 'sha256': hashlib.sha256(Path(product_entry).read_bytes()).hexdigest()})}
print(json.dumps({'before_ref': refs['public_setup_before.json'], 'subjects': subjects, 'factory_pid': sender['pid']}))
