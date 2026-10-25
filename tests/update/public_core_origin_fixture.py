"""Synthetic source subjects and predecessors; real parent identity only."""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
ROOT=Path(__file__).resolve().parents[2]
def load(name,path):
 s=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
store=load('public_origin_store',ROOT/'bin/factory-update-context-observer.py')
fixture=load('public_origin_subject',ROOT/'tests/update/context_trust_adapter_test.py')
directory,factory_entry,product_entry,registration,preload=sys.argv[1:]
sender=store.process_identity(os.getppid());identity=store.token(Path('/proc/sys/kernel/random/boot_id').read_text().strip(),sender)
d=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
try:
 for name,value in [('launcher_input.json',dict(launcher_identity=identity,capture_expires_at_utc_ms=int(os.environ['DOTAGENTS_UPDATE_CONTEXT_EXPIRES_AT']),observed_at_utc_ms=time.time_ns()//1000000)),('root_result.json',dict(phase='root_result',launcher_identity=identity,process_identity=identity))]:store.publish_original(d,name,(json.dumps(value)+'\n').encode(),readback=True)
finally:os.close(d)
subjects={}
for name,entry in [('factory',factory_entry),('product',product_entry)]:
 value=fixture.subject(name,dict(path=entry,sha256=hashlib.sha256(Path(entry).read_bytes()).hexdigest()))
 bundle=json.loads(base64.b64decode(value['source_original']['bytes_base64']));manifest=json.loads(base64.b64decode(bundle['capture']['manifest_bytes_base64']))
 for row in manifest['files']:
  path=preload if name=='factory' and row['role']=='public_preload' else registration if name=='product' and row['role']=='core_registration' else None
  if path:row.update(path=path,sha256=hashlib.sha256(Path(path).read_bytes()).hexdigest())
 raw=json.dumps(manifest).encode();bundle['capture'].update(manifest_bytes_base64=base64.b64encode(raw).decode(),manifest_sha256=hashlib.sha256(raw).hexdigest());subjects[name]=bundle
print(json.dumps(subjects))
