// New prelaunch decline/release combination only. No real descriptors/processes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { withCoreAuthoritySources } from '../../lib/factory/core-authority-sources.mjs';
import { canonicalDeployment as canonical } from '../../lib/factory/deployment-writer.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const source = readFileSync(new URL('../../lib/factory/update-context-public-executor.mjs', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gmu, '').replace(/^const PRELOAD = .*;$/mu, 'const PRELOAD = "/fixture/preload.mjs";')
  .replace('export function createPublicCoreExecutor', 'function createPublicCoreExecutor');
const unused = () => { throw new Error('must_not_launch'); };
const factory = new Function('withCoreAuthoritySources','fstatSync','closeSync','createHash','process','readFileSync','realpathSync',
  'preparePublicCoreBootstrap','encodeCorePreloadRecord','createOriginalNodeAuthorityBroker','spawn',source+'\nreturn createPublicCoreExecutor;')(
  withCoreAuthoritySources,()=>({isSocket:()=>true}),()=>{},createHash,{platform:'linux',env:{}},unused,unused,unused,unused,unused,unused);
function fixture(releaseConfirmed) {
  const held={factory:false,product:false},definitions={};
  for(const [name,generation] of [['factory','11111111-1111-4111-8111-111111111111'],['product','22222222-2222-4222-8222-222222222222']]) {
    const identity={product_id:name,host_id:'fixture',owner:{system:'fixture',id:'owner'}},root=`/fixture/${name}`,resources=[root];
    const adoption={targets:['fixture']},provenance={evidence_ref:`fixture:provenance:${name}`};
    const payload={identity,execution_package_root:root,mutation_resources:resources,deployment_generation:generation,
      manifest_sha256:'a'.repeat(64),artifact_or_tree_sha256:'b'.repeat(64),provenance_evidence_ref:provenance.evidence_ref,adopted_targets_sha256:hash(canonical(adoption))};
    const receipt={payload,issuer_id:'fixture:issuer',evidence_ref:`fixture:${name}`,proof:{fixture:true}};
    const input={identity,execution_package_root:root,mutation_resources:resources,deadline:Date.now()+60000};
    const bundle={schema:'factory.deployment-sources.v1',factory_payload_sha256:hash(canonical(payload)),capture:{execution_package_root:root,
      manifest_sha256:payload.manifest_sha256,artifact_or_tree_sha256:payload.artifact_or_tree_sha256,artifact_or_tree_kind:name==='factory'?'tree':'artifact',artifact_sha256:name==='product'?'b'.repeat(64):null},provenance:{subject:provenance},adoption:{subject:adoption}};
    definitions[name]={input,writer:{status:'committed',generation,receipt},ports:{
      async withReadLease(rows,g,_deadline,fn){held[name]=true;try{return await fn({mode:'SH',resources:rows,generation:g,signal:new AbortController().signal,
        async assertCurrent(){assert.equal(held[name],true);}});}finally{if(!releaseConfirmed)throw new Error('fixture_release_unconfirmed');held[name]=false;}},
      store:{async load(){return {...input,phase:'committed',generation,receipt};}},async verifyCurrent(){assert.equal(held[name],true);},
      async readSourceEvidence(){assert.equal(held.factory&&held.product,true);return bundle;},
      async resolveTrustedIssuer(){throw new Error('fixture_issuer_unavailable_before_launch');}
    }};
  }
  return {held,definitions};
}
const observations=[];
for(const released of [false,true]) test(released?'confirmed two-SH cleanup permits one original fallback':'unconfirmed two-SH cleanup forbids any ordinary fallback',async()=>{
  const f=fixture(released);let calls=0,launches=0,heldAtFallback;
  const original={ok:false,code:2,reason:'exit',stdout:'{"overall":"partial"}\n',stderr:''};
  const execute=factory({definitions:f.definitions,resolveInstalledLaunch:async()=>{launches++;unused();}});
  const invocation={command:'gpt-connector',args:['setup'],before:{status:'recorded_raw'},options:{},execute:async()=>{calls++;heldAtFallback={...f.held};return original;}};
  if(released){assert.equal(await execute(invocation),original);assert.equal(calls,1);assert.deepEqual(heldAtFallback,{factory:false,product:false});}
  else{await assert.rejects(execute(invocation),/public_core_execution_unconfirmed/);assert.equal(calls,0);assert.deepEqual(f.held,{factory:true,product:true});}
  assert.equal(launches,0);
  observations.push({release_confirmed:released,execute_calls:calls,launch_calls:launches,held_at_fallback:heldAtFallback??null,held_after:{...f.held},result:released?'original_exit2':'rejected_public_core_execution_unconfirmed'});
  if(process.env.CORE_PRELAUNCH_RELEASE_EVIDENCE&&observations.length===2)writeFileSync(process.env.CORE_PRELAUNCH_RELEASE_EVIDENCE,JSON.stringify(observations,null,2)+'\n',{mode:0o600});
});
