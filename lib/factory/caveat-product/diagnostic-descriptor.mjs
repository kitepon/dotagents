// Product-owned selection, not a second MCP configuration parser.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
export function diagnosticDescriptor(inv){
 const required=['claude','codex','grok','cursor'];
 assert.equal(inv.healthy,null);assert.equal(inv.harnesses.length,4,'four_clients_required');
 assert.deepEqual([...inv.harnesses.map(x=>x.name)].sort(),required.sort(),'four_clients_required');
 assert.equal(inv.managed_deployment_errors?.length??0,0,'managed_metadata_refused');
 const entries=inv.managed_deployments;assert.equal(entries.length,1,'selected_payload_conflict');const entry=entries[0];assert.equal(entry.consistent,true,'pointer_changed');
 for(const h of inv.harnesses){
  assert.equal(h.caveat_registration_present,true,'registration_missing');assert.equal(h.enabled,true,'registration_disabled');assert.equal(h.read_status,undefined,'registration_unparsed');
  assert.equal(h.managed_mcp_argument_contract,true,'registration_arguments_conflict');assert.equal(h.config_consistent,true,'registration_changed');
  assert.deepEqual(h.package_roots,[entry.package_root],'registered_payload_conflict');assert.deepEqual(h.caveat_argument_files,[entry.launcher],'registered_entry_conflict');
  assert.equal(h.command_realpath,inv.collector_runtime.executable,'registered_runtime_conflict');assert.ok(/^node(?:\.exe)?$/i.test(h.command_basename),'registered_command_not_node');
 }
 const pkg=inv.packages.find(x=>x.root===entry.package_root);assert.ok(pkg?.managed_entry_verified&&pkg.deployment_revision_candidate,'unverified_selected_payload');assert.equal(pkg.installed_version,entry.version,'selected_version_mismatch');
 return {schema:'caveat.diagnostic_entry_descriptor.v1',status:'bound',observed_at:inv.finished_at,command:inv.collector_runtime.executable,args:['--disable-warning=ExperimentalWarning',entry.launcher,'factory-diagnostics','--json','--require-connector','cursor','--require-connector','grok'],installed_version:entry.version,entry,registered_harnesses:inv.harnesses.map(x=>({name:x.name,config_file:x.config_file,config_sha256:x.config_sha256})),deployment_revision:pkg.deployment_revision_candidate,health_inferred:false,selection:'all four configured Node/entry/payload targets must agree; no preference or PATH/global fallback',consumer_check:'fresh descriptor before and after invocation must retain command, entry/pointer and config fingerprints; output.version must equal installed_version; nonzero not_ready remains raw diagnostic'};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{console.log(JSON.stringify(diagnosticDescriptor(JSON.parse(readFileSync(0,'utf8'))),null,2));}
 catch(error){console.log(JSON.stringify({schema:'caveat.diagnostic_entry_descriptor.v1',status:'unbound',reason:error instanceof assert.AssertionError?error.message.split('\n')[0]:'descriptor_input_unavailable',action:'preserve original diagnostic/log/severity and normal registration; record unconfirmed version binding separately; never invent installed version'}));process.exitCode=2;}
}
