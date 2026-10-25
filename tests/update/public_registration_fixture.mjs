// Dedicated before/record fixture. No actual setup, issuer or host root.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { observePublicSetup, preparePublicCoreBootstrap } from '../../lib/factory/update-context-observer.mjs';
const helper = new URL('../../bin/factory-update-context-observer.py', import.meta.url).pathname;
const code = `import importlib.util,os,json,sys\ns=importlib.util.spec_from_file_location('fixture_store',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\np=m.process_identity(os.getppid());boot=open('/proc/sys/kernel/random/boot_id').read().strip();i=m.token(boot,p)\nd=os.open(sys.argv[2],os.O_RDONLY|os.O_DIRECTORY)\nfor n,v in [('launcher_input.json',dict(launcher_identity=i)),('root_result.json',dict(phase='root_result',launcher_identity=i,process_identity=i))]:m.publish_original(d,n,(json.dumps(v)+'\\n').encode(),readback=True)\nos.close(d)`;
const bootstrap = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', code, helper, process.env.DOTAGENTS_UPDATE_CONTEXT_DIR], { encoding: 'utf8' });
assert.equal(bootstrap.status, 0, bootstrap.stderr);
const before = observePublicSetup('public_setup_before'); assert.equal(before?.status, 'recorded_raw');
assert.equal(preparePublicCoreBootstrap(structuredClone(before)).status, 'unknown');
const prepared = preparePublicCoreBootstrap(before); assert.equal(prepared.status, 'recorded_raw');
const raw = readFileSync(`${prepared.activation}/core_authority_bootstrap.json`), value = JSON.parse(raw);
assert.deepEqual(value.before_original, before.original); assert.equal(value.sender.pid, process.pid);
assert.equal(preparePublicCoreBootstrap(before).status, 'unknown');
process.stdout.write(JSON.stringify({ before, prepared, same_factory_pid: value.sender.pid === process.pid, second_preparation: 'unknown', forged_receipt: 'unknown', reporting_allowed: false, resource_read_authorized: false }) + '\n');
