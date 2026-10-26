// Real original parent executor + real adopted product registration module.
// Sources/issuer/SH and setup result are synthetic. No ordinary product setup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalDeployment as canonical } from '../../lib/factory/deployment-writer.mjs';
import { runProductSetup } from '../../lib/factory/product-setup.mjs';
import { createPublicCoreExecutor } from '../../lib/factory/update-context-public-executor.mjs';
import { run } from '../../lib/factory/command.mjs';
process.env.DOTAGENTS_PUBLIC_FIXTURE_SENTINEL='before';
const [directory,entry,mode]=process.argv.slice(2),registration=new URL('./update-ledger-core-registration.js',`file://${entry}`).pathname;
const preload=fileURLToPath(new URL('../../lib/factory/update-context-product-preload.mjs',import.meta.url));
const origin=spawnSync('/usr/bin/python3',['-I','-S',fileURLToPath(new URL('./public_core_origin_fixture.py',import.meta.url)),directory,fileURLToPath(import.meta.url),entry,registration,preload],{encoding:'utf8'});
assert.equal(origin.status,0,origin.stderr);const originals=JSON.parse(origin.stdout),held={factory:false,product:false},counts={current:0,issuer:0,execute:0,launch:0};let childStarted=false;
const hash=value=>createHash('sha256').update(value).digest('hex');
function definition(name){
 const bundle=originals[name],identity={product_id:name,host_id:'fixture',owner:{system:'fixture',id:'owner'}};
 const root=`/fixture/${name}`,resources=[root],generation=name==='factory'?'11111111-1111-4111-8111-111111111111':'22222222-2222-4222-8222-222222222222';
 bundle.capture.execution_package_root=root;bundle.capture.artifact_or_tree_sha256=name==='factory'?'b'.repeat(64):bundle.capture.artifact_sha256;
 bundle.provenance.subject.evidence_ref=`fixture:provenance:${name}`;
 const payload={identity,execution_package_root:root,mutation_resources:resources,deployment_generation:generation,manifest_sha256:bundle.capture.manifest_sha256,artifact_or_tree_sha256:bundle.capture.artifact_or_tree_sha256,provenance_evidence_ref:bundle.provenance.subject.evidence_ref,adopted_targets_sha256:hash(canonical(bundle.adoption.subject))};
 bundle.factory_payload_sha256=hash(canonical(payload));const receipt={payload,issuer_id:'fixture:issuer',evidence_ref:`fixture:${name}`,proof:{fixture:true}};
 const input={identity,execution_package_root:root,mutation_resources:resources,deadline:Date.now()+60000};
 return {input,writer:{status:'committed',generation,receipt},ports:{
  async withReadLease(rows,g,_deadline,fn){held[name]=true;try{return await fn({mode:'SH',resources:rows,generation:g,signal:new AbortController().signal,async assertCurrent(){assert.equal(held[name],true);}});}finally{held[name]=false;if(mode==='release-error')throw new Error('fixture-release');}},
  store:{async load(){return {...input,phase:'committed',generation,receipt};}},
  async verifyCurrent(){assert.equal(held[name],true);counts.current++;},async readSourceEvidence(){return bundle;},
  async resolveTrustedIssuer(){counts.issuer++;assert.equal(held.factory&&held.product,true);if(mode==='issuer-before'||(mode==='issuer-lost'&&childStarted))throw new Error('fixture-lost');return {status:'verified',issuer:'fixture:issuer',trust_ref:'fixture:root',subject_sha256:hash(canonical(payload))};}
 }};
}
const adapter=createPublicCoreExecutor({definitions:{factory:definition('factory'),product:definition('product')},evidenceKind:'fixture',
 resolveInstalledLaunch:async()=>{counts.launch++;process.env.DOTAGENTS_PUBLIC_FIXTURE_SENTINEL='after';return {nodeExecutable:process.execPath,productEntry:entry,registrationModule:registration};}});
let normal,output='';const state=await runProductSetup('gpt-connector',{gptCoreExecute:adapter,output:{write(v){output+=v;}},execute:async(...args)=>{counts.execute++;if(mode==='issuer-before'){assert.equal(held.factory||held.product,false);normal={ok:false,code:2,reason:'exit',stdout:JSON.stringify({overall:'partial'})+'\n',stderr:''};return normal;}assert.equal(held.factory&&held.product,true);childStarted=true;normal=await run(...args);assert.equal(held.factory&&held.product,true);return normal;}});
writeFileSync(`${directory}/normal-original.json`,JSON.stringify({state,normal,output,counts})+'\n',{mode:0o600});
assert.equal(counts.execute,1);assert.equal(state,'partial');assert.equal(normal.code,2);assert.equal(JSON.parse(normal.stdout).overall,'partial');assert.equal(held.factory||held.product,false);
let core=null;try{core=JSON.parse(readFileSync(`${directory}/core_result.json`));}catch{}
process.stdout.write(JSON.stringify({state,normal,output,counts,leases_released:true,core_recorded:core?.status??null,kind:core?.kind??null,reporting_allowed:core?.reporting_allowed??false,resource_read_authorized:core?.resource_read_authorized??false})+'\n');
