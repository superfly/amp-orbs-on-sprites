import test from 'node:test';
import assert from 'node:assert/strict';
import { provision, installationSpec, rotateCredential, destroyInstallation, credentialStatus } from '../src/provision.mjs';
import { flyConfig, FlyPlatform } from '../provision/fly-platform.mjs';
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
    mintCredential:async()=>{calls.push('mint');return {token:'runtime-secret',expiresAt:'future',tokenId:'tok_1'};},
    revokeCredential:async c=>{calls.push(`revoke:${c.tokenId||'by-token'}`);},
    listSprites:async()=>({names:[],more:false}), destroyApp:async()=>{calls.push('destroy-app');app=false;},
    setSecrets:async(spec,secrets)=>{calls.push(`secrets:${Object.keys(secrets).sort().join(',')}`);}, deploy:async()=>{calls.push('deploy');},
    verify:async()=>({machineId:'machine_1'}),
  };
  const journal={read:async()=>state,write:async s=>{state=structuredClone(s);}};
  return {platform,journal,calls,get state(){return state;}};
}
test('provision is resumable, redacts journal/progress, and hands off before activation',async()=>{
  const f=fixture(), events=[];
  const options={...f,progress:e=>events.push(e),beforeActivate:async()=>f.calls.push('handoff')};
  await provision(input,options);await provision(input,options);
  assert.deepEqual(f.calls,['app','image','volume','mint','secrets:ampToken,initialRecords,spriteToken','handoff','deploy']);
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
  assert.ok(f.calls.includes('revoke:tok_1'));assert.ok(!f.calls.includes('deploy'));
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
  assert.equal(result.tokenId,'new-token');assert.equal(result.expiresAt,'future');assert.equal(result.confirmedPrefix,undefined);
  assert.equal(issued.name_prefix,'amp-test-');assert.equal(issued.mint_ttl,0);assert.equal(issued.policy,undefined);
});

test('an opaque parent that rejects child-token fields gets the policy-only request',async()=>{
  const {FlyPlatform}=await import('../provision/fly-platform.mjs');
  const mint=(status)=>{
    const p=new FlyPlatform({root:'.',directory:'.'});
    const posts=[];let description;
    p.sprites={request:async(method,path,body)=>{
      if(method==='POST'){
        posts.push(body);description=body.description;
        if(body.sprites||body.ttl||body.name_prefix||'mint_ttl' in body)throw Object.assign(Error('rejected'),{status});
        return {token:'opaque-test'};
      }
      return {tokens:[{id:'policy-token',description,policy:body?.policy||{name_prefix:'amp-test-',expires_at:'future'}}]};
    }};
    p.runtimeClient=()=>({request:async(method,path)=>{
      if(path==='/tokens')throw Object.assign(Error('forbidden'),{status:403});
      return {sprites:[]};
    }});
    return {p,posts};
  };
  const opaque=mint(400);
  const result=await opaque.p.mintCredential(input);
  assert.equal(result.tokenId,'policy-token');assert.equal(result.expiresAt,'future');
  assert.equal(opaque.posts.length,2);
  const [,fallback]=opaque.posts;
  assert.deepEqual(Object.keys(fallback).sort(),['description','policy']);
  assert.equal(fallback.policy.name_prefix,'amp-test-');assert.ok(!Number.isNaN(Date.parse(fallback.policy.expires_at)));
  assert.equal(fallback.description,opaque.posts[0].description);
  const denied=mint(403);
  await assert.rejects(denied.p.mintCredential(input),e=>e.status===403);
  assert.equal(denied.posts.length,1);
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

function minter({created={token:'opaque-test'},listed={}}={}){
  const p=new FlyPlatform({root:'.',directory:'.'});
  const deleted=[],revoked=[];let description;
  p.sprites={request:async(method,path,body)=>{
    if(method==='POST' && path==='/tokens'){description=body.description;return created;}
    if(method==='POST' && path==='/tokens/revoke'){revoked.push(body);return {};}
    if(method==='DELETE'){deleted.push(path);return {};}
    return {tokens:[{id:'listed-id',description,policy:{name_prefix:'amp-test-',expires_at:'listed-future',...listed}}]};
  }};
  p.runtimeClient=()=>({request:async(method,path)=>{if(path==='/tokens')throw Object.assign(Error('forbidden'),{status:403});return {sprites:[]};}});
  return {p,deleted,revoked};
}
test('token issuance confirms the prefix from metadata even when the response carries expires_at',async()=>{
  const ok=minter({created:{token:'opaque-test',expires_at:'response-future'}});
  const credential=await ok.p.mintCredential(input);
  assert.equal(credential.tokenId,'listed-id');assert.equal(credential.expiresAt,'response-future');
  const wrong=minter({created:{token:'opaque-test',expires_at:'response-future'},listed:{name_prefix:'other-'}});
  await assert.rejects(wrong.p.mintCredential(input),/not confirmed/);
  assert.deepEqual(wrong.deleted,['/tokens/listed-id']);
  const omitted=minter({listed:{name_prefix:'other-'}});
  await assert.rejects(omitted.p.mintCredential(input),/not confirmed/);
  assert.deepEqual(omitted.deleted,['/tokens/listed-id']);
});
test('an unidentifiable new credential is revoked by value',async()=>{
  const m=minter();m.p.sprites.request=async(method,path,body)=>{
    if(method==='POST' && path==='/tokens')return {token:'opaque-test'};
    if(method==='POST' && path==='/tokens/revoke'){m.revoked.push(body);return {};}
    return {tokens:[]};
  };
  await assert.rejects(m.p.mintCredential(input),/Cannot identify/);
  assert.deepEqual(m.revoked,[{token:'opaque-test'}]);
});
test('rotation restages only the Sprite credential and revokes the previous one afterwards',async()=>{
  const f=fixture();await provision(input,f);
  let minted=0;f.platform.mintCredential=async()=>{f.calls.push('mint');return {token:`rotated-secret-${++minted}`,expiresAt:'later',tokenId:`tok_${minted+1}`};};
  f.calls.length=0;const events=[];
  const result=await rotateCredential({...input,ampToken:undefined},{...f,progress:e=>events.push(e.step)});
  assert.deepEqual(f.calls,['mint','secrets:spriteToken','deploy','revoke:tok_1']);
  assert.equal(f.state.credentialTokenId,'tok_2');assert.equal(f.state.credentialExpiresAt,'later');
  assert.equal(f.state.previousCredentialTokenId,undefined);assert.equal(f.state.phase,'ready');assert.equal(f.state.secretsConfigured,true);
  assert.equal(result.rotation.previousRevoked,true);
  assert.ok(events.indexOf('revoking-credential')>events.indexOf('verifying-connection'));
  assert.ok(!JSON.stringify([f.state,events,result]).includes('rotated-secret'));
});
test('a failed restage or redeploy revokes the new credential and keeps the old one recorded',async()=>{
  for(const failing of ['setSecrets','deploy']){
    const f=fixture();await provision(input,f);
    f.platform.mintCredential=async()=>{f.calls.push('mint');return {token:'rotated-secret',expiresAt:'later',tokenId:'tok_new'};};
    f.platform[failing]=async()=>{throw Error(`${failing} failed`);};
    f.calls.length=0;
    await assert.rejects(rotateCredential(input,f),new RegExp(`${failing} failed`));
    assert.ok(f.calls.includes('revoke:tok_new'));assert.ok(!f.calls.includes('revoke:tok_1'));
    assert.equal(f.state.credentialTokenId,'tok_1');assert.equal(f.state.credentialExpiresAt,'future');assert.equal(f.state.activated,true);
  }
});
test('a rotation interrupted before revocation revokes the previous credential on the next run',async()=>{
  const f=fixture();await provision(input,f);
  f.platform.revokeCredential=async()=>{throw Error('sprites unreachable');};
  f.platform.mintCredential=async()=>({token:'rotated-secret',expiresAt:'later',tokenId:'tok_2'});
  await assert.rejects(rotateCredential(input,f),/unreachable/);
  assert.equal(f.state.credentialTokenId,'tok_2');assert.equal(f.state.previousCredentialTokenId,'tok_1');
  f.platform.revokeCredential=async c=>{f.calls.push(`revoke:${c.tokenId}`);};
  f.platform.mintCredential=async()=>({token:'rotated-again',expiresAt:'latest',tokenId:'tok_3'});
  await rotateCredential(input,f);
  assert.deepEqual(f.calls.filter(c=>c.startsWith('revoke')),['revoke:tok_1','revoke:tok_2']);
  assert.equal(f.state.credentialTokenId,'tok_3');assert.equal(f.state.previousCredentialTokenId,undefined);
});
test('rotation refuses an unknown, changed, or incomplete installation',async()=>{
  const f=fixture();await assert.rejects(rotateCredential(input,f),/No installation/);
  f.platform.deploy=async()=>{throw Error('interrupted');};await assert.rejects(provision(input,f),/interrupted/);
  await assert.rejects(rotateCredential(input,f),/Finish the installation/);
  f.platform.deploy=async()=>{};await provision(input,f);
  await assert.rejects(rotateCredential({...input,org:'different'},f),/identity changed/);
  assert.ok(!f.calls.some(c=>c.startsWith('revoke')));
});
test('destroy refuses while Orb Sprites with the prefix remain and changes nothing',async()=>{
  const f=fixture();await provision(input,f);f.calls.length=0;
  f.platform.listSprites=async spec=>{assert.equal(spec.provider,'amp-test');return {names:['amp-test-abc'],more:true};};
  await assert.rejects(destroyInstallation(input,f),/at least 1 Sprite.*still exist/);
  assert.deepEqual(f.calls,[]);assert.equal(f.state.appCreated,true);assert.equal(f.state.credentialTokenId,'tok_1');
});
test('destroy removes the app, revokes the recorded credential, and journals each step',async()=>{
  const f=fixture();await provision(input,f);f.calls.length=0;
  const result=await destroyInstallation(input,f);
  assert.deepEqual(f.calls,['destroy-app','revoke:tok_1']);
  assert.equal(result.destroyed,true);assert.equal(result.credentialRevoked,true);
  assert.equal(f.state.appCreated,false);assert.equal(f.state.credentialTokenId,undefined);assert.equal(f.state.phase,'destroying');
  const g=fixture();await provision(input,g);g.calls.length=0;
  g.platform.appExists=async()=>false;g.state.credentialTokenId=undefined;
  g.journal.read=async()=>({...g.state,credentialTokenId:undefined});
  const partial=await destroyInstallation(input,g);
  assert.deepEqual(g.calls,[]);assert.equal(partial.credentialRevoked,false);
  await assert.rejects(destroyInstallation(input,fixture()),/No installation/);
});
test('credential status flags expiry within fourteen days',()=>{
  const now=Date.parse('2026-11-04T00:00:00Z');
  assert.deepEqual(credentialStatus(undefined,now),{known:false});
  assert.equal(credentialStatus('2027-01-01T00:00:00Z',now).expiringSoon,false);
  const soon=credentialStatus('2026-11-10T12:00:00Z',now);
  assert.equal(soon.expiringSoon,true);assert.equal(soon.daysLeft,6);assert.equal(soon.expired,false);
  assert.equal(credentialStatus('2026-11-01T00:00:00Z',now).expired,true);
});
test('Fly secret rotation stages only the Sprite credential',async()=>{
  const p=new FlyPlatform({root:'.',directory:'.'});let captured;
  p.fly=async(args,options)=>{captured={args,options};};
  await p.setSecrets(input,{spriteToken:'sprite-rotated'});
  assert.deepEqual(captured.args,['secrets','import','--app',input.app,'--stage']);
  assert.equal(captured.options.input,'SPRITE_TOKEN=sprite-rotated\n');
  await assert.rejects(p.setSecrets(input,{spriteToken:''}),/Invalid/);
});
test('teardown lists Sprites by prefix and destroys only the dispatcher app',async()=>{
  const p=new FlyPlatform({root:'.',directory:'.'});const paths=[],flyCalls=[];
  p.sprites={request:async(method,path)=>{paths.push(`${method} ${path}`);return {sprites:[{name:'amp-test-abc'},{name:'other-x'}],has_more:false};}};
  p.fly=async args=>{flyCalls.push(args);return '';};
  assert.deepEqual(await p.listSprites(input),{names:['amp-test-abc'],more:false});
  assert.deepEqual(paths,['GET /sprites?prefix=amp-test-&max_results=50']);
  await p.destroyApp(input);
  assert.deepEqual(flyCalls,[['apps','destroy','amp-example','--yes']]);
});
