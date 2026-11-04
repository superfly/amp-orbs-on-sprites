import test from 'node:test';
import assert from 'node:assert/strict';
import { provision, installationSpec } from '../src/provision.mjs';
import { flyConfig } from '../provision/fly-platform.mjs';
const input={org:'example',app:'amp-example',provider:'amp-test',region:'ord',ampToken:'aop_live_testsecret'};
function fixture(){
  let state=null, app=false, volumes=[];
  const calls=[];
  const platform={
    preflight:async()=>{}, appExists:async()=>app,
    createApp:async()=>{app=true;calls.push('app');},
    buildImage:async()=>{calls.push('image');return 'registry.fly.io/amp-example@sha256:'+'a'.repeat(64);},
    volumes:async()=>volumes,
    createVolume:async()=>{calls.push('volume');volumes=[{id:'vol_1',name:'dispatcher_data',region:'ord'}];return 'vol_1';},
    mintCredential:async()=>{calls.push('mint');return {token:'runtime-secret',expiresAt:'future'};},
    revokeCredential:async()=>{calls.push('revoke');},
    setSecrets:async()=>{calls.push('secrets');}, deploy:async()=>{calls.push('deploy');},
    verify:async()=>({machineId:'machine_1'}),
  };
  const journal={read:async()=>state,write:async s=>{state=structuredClone(s);}};
  return {platform,journal,calls,get state(){return state;}};
}
test('provision is resumable, redacts journal/progress, and hands off before activation',async()=>{
  const f=fixture(), events=[];
  const options={...f,progress:e=>events.push(e),beforeActivate:async()=>f.calls.push('handoff')};
  await provision(input,options);await provision(input,options);
  assert.deepEqual(f.calls,['app','image','volume','mint','secrets','handoff','deploy']);
  assert.equal(f.state.phase,'ready');
  for (const value of [input.ampToken, 'runtime-secret']) assert.ok(!JSON.stringify([f.state,events]).includes(value));
});
test('deployment retry reuses app, volume, image, and configured credentials',async()=>{
  const f=fixture();f.platform.deploy=async()=>{throw Error('interrupted');};
  await assert.rejects(provision(input,f),/interrupted/);
  f.platform.deploy=async()=>f.calls.push('retry-deploy');
  await provision(input,f);
  for(const name of ['app','volume','image','mint'])assert.equal(f.calls.filter(c=>c===name).length,1);
});
test('a failed readiness check is rechecked without redeployment',async()=>{
  const f=fixture();f.platform.verify=async()=>{throw Error('offline');};
  await assert.rejects(provision(input,f),/offline/);
  f.platform.verify=async()=>({machineId:'m'});await provision(input,f);
  assert.equal(f.calls.filter(c=>c==='deploy').length,1);
});
test('unknown app and volume collisions are not adopted',async()=>{
  const f=fixture();f.platform.appExists=async()=>true;
  await assert.rejects(provision(input,f),/without.*ownership/);assert.deepEqual(f.calls,[]);
  const g=fixture();g.platform.volumes=async()=>[{id:'foreign'}];
  await assert.rejects(provision(input,g),/Unrecorded volume/);
  assert.ok(!g.calls.includes('mint'));
});
test('secret upload failure revokes the new credential and never activates',async()=>{
  const f=fixture();f.platform.setSecrets=async()=>{throw Error('upload failed');};
  await assert.rejects(provision(input,f),/upload failed/);
  assert.ok(f.calls.includes('revoke'));assert.ok(!f.calls.includes('deploy'));
});
test('Fly secret transfer uses stdin and only the dispatcher credentials',async()=>{
  const {FlyPlatform}=await import('../provision/fly-platform.mjs');
  const p=new FlyPlatform({root:'.',directory:'.'});let captured;
  p.fly=async(args,options)=>{captured={args,options};};
  await p.setSecrets(input,{ampToken:'aop_live_transfer',spriteToken:'sprite-secret',initialRecords:[],accountToken:'must-not-transfer'});
  assert.deepEqual(captured.args,['secrets','import','--app',input.app,'--stage']);
  assert.match(captured.options.input,/AMP_ORB_PROVIDER_TOKEN=aop_live_transfer\n/);
  assert.match(captured.options.input,/SPRITE_TOKEN=sprite-secret\n/);
  assert.ok(!captured.options.input.includes('must-not-transfer'));
});
test('changed installation identity or lost volume refuses further mutations',async()=>{
  const f=fixture();await provision(input,f);
  await assert.rejects(provision({...input,org:'different'},f),/identity changed/);
  await assert.rejects(provision({...input,ampToken:'aop_live_other'},f),/identity changed/);
  f.platform.volumes=async()=>[];await assert.rejects(provision(input,f),/volume is missing/);
});
test('configuration uses an explicit organization and a private single dispatcher',()=>{
  assert.throws(()=>installationSpec({...input,org:'personal'}));
  const config=flyConfig(input,'registry.fly.io/amp-example@sha256:'+'a'.repeat(64));
  assert.match(config,/strategy = "immediate"/);assert.match(config,/destination = "\/data"/);
  assert.ok(!config.includes('[http_service]'));assert.ok(!config.includes('secret'));
});

test('token issuance confirms restrictions through metadata when response omits policy', async()=>{
  const {FlyPlatform}=await import('../provision/fly-platform.mjs');
  const p=new FlyPlatform({root:'.',directory:'.'});
  let issued,description;
  p.sprites={request:async(method,path,body)=>{
    if(method==='POST'){issued=body;description=body.description;return {token:'opaque-test'};}
    return {tokens:[{id:'new-token',description,policy:{name_prefix:'amp-test-',expires_at:'future'}}]};
  }};
  p.runtimeClient=()=>({request:async(method,path)=>{
    if(path==='/tokens')throw Object.assign(Error('forbidden'),{status:403});
    return {sprites:[]};
  }});
  const result=await p.mintCredential(input);
  assert.equal(result.tokenId,'new-token');assert.equal(result.expiresAt,'future');
  assert.equal(issued.policy.name_prefix,'amp-test-');assert.equal(issued.name_prefix,'amp-test-');
});

test('a credential that still permits administration is revoked before deployment',async()=>{
  const {FlyPlatform}=await import('../provision/fly-platform.mjs');
  const p=new FlyPlatform({root:'.',directory:'.'});
  let description;const deleted=[];
  p.sprites={request:async(method,path,body)=>{
    if(method==='POST'){description=body.description;return {token:'overbroad-test'};}
    if(method==='DELETE'){deleted.push(path);return {};}
    return {tokens:[{id:'overbroad-id',description,policy:{name_prefix:'amp-test-',expires_at:'future'}}]};
  }};
  p.runtimeClient=()=>({request:async()=>({})});
  await assert.rejects(p.mintCredential(input),/unexpectedly permits/);
  assert.deepEqual(deleted,['/tokens/overbroad-id']);
});

test('a rebuild replaces the image without replacing storage or credentials',async()=>{
  const f=fixture();await provision(input,f);
  await provision({...input,ampToken:undefined,rebuild:true},f);
  assert.equal(f.calls.filter(c=>c==='image').length,2);
  assert.equal(f.calls.filter(c=>c==='deploy').length,2);
  for(const name of ['app','volume','mint'])assert.equal(f.calls.filter(c=>c===name).length,1);
});

test('a failed remote rebuild preserves the active image and activation record',async()=>{
  const f=fixture();await provision(input,f);const image=f.state.image;
  f.platform.buildImage=async()=>{throw Error('build failed');};
  await assert.rejects(provision({...input,rebuild:true},f),/build failed/);
  assert.equal(f.state.image,image);assert.equal(f.state.activated,true);
});
