import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFlow } from '../provision/setup-flow.mjs';
import { FlyPlatform } from '../provision/fly-platform.mjs';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
const token='aop_live_hidden_test';
const spec={org:'example',app:'amp-example',provider:'amp-test',region:'ord'};
function fixture(){
  const events=[],logs=[];
  let fly=false,sprites=false,submitted;
  const connection={
    ensureTools:async()=>events.push('tools'),flyConnected:async()=>fly,
    flyLogin:async mode=>{events.push(`fly-${mode}`);fly=true;},
    organizations:async()=>[{name:'Example',slug:'example'},{name:'Other',slug:'other'}],
    spritesConnected:async org=>{assert.equal(org,'example');return sprites;},
    spritesLogin:async org=>{events.push(`sprites-${org}`);sprites=true;},
  };
  const ui={log:s=>logs.push(s),choose:async()=>0,ask:async()=>spec.app,secret:async()=>{events.push('token-prompt');return token;},confirm:async()=>true};
  const run=async input=>{submitted=input;events.push('provision');return {spec:input.spec};};
  return {connection,ui,run,logs,events,get submitted(){return submitted;},connect:()=>{fly=true;sprites=true;}};
}
test('guides login, real organization selection, Sprite authorization, and hidden token entry',async()=>{
  const f=fixture();await setupFlow({...f,options:{provider:'amp-test'}});
  assert.deepEqual(f.events,['tools','fly-login','sprites-example','token-prompt','provision']);
  assert.deepEqual(f.submitted.spec,spec);assert.equal(f.submitted.ampToken,token);
  assert.ok(!f.logs.join('\n').includes(token));
});
test('signup is available to a new Fly user',async()=>{
  const f=fixture();let selection=0;
  f.ui.choose=async()=>selection++===0?1:0;
  await setupFlow({...f});assert.ok(f.events.includes('fly-signup'));
});
test('existing installation reuses its credentials without requiring the token again',async()=>{
  const f=fixture();f.connect();
  await setupFlow({...f,options:{org:'example',app:spec.app,yes:true},installations:[{spec,secretsConfigured:true,activated:true}]});
  assert.ok(!f.events.includes('token-prompt'));assert.equal(f.submitted.ampToken,undefined);
  assert.deepEqual(f.submitted.spec,spec);
});
test('unknown org is rejected before Sprite authorization or provisioning',async()=>{
  const f=fixture();await assert.rejects(setupFlow({...f,options:{org:'no-access'}}),/not available/);
  assert.ok(!f.events.some(e=>e.startsWith('sprites-')));assert.ok(!f.events.includes('provision'));
});
test('declining the cost review does not provision resources',async()=>{
  const f=fixture();f.ui.confirm=async()=>false;
  assert.equal(await setupFlow({...f}),null);assert.ok(!f.events.includes('provision'));
});
test('the same token cannot launch another recorded installation',async()=>{
  const f=fixture();f.connect();
  const fingerprint=createHash('sha256').update(token).digest('hex');
  await assert.rejects(setupFlow({...f,options:{org:'example',app:'another-app'},env:{AMP_ORB_PROVIDER_TOKEN:token},installations:[{spec,fingerprint}]}),/already belongs/);
  assert.ok(!f.events.includes('provision'));
});
test('remote builder never calls Docker and resolves a digest without registry redirects',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'amp-build-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const p=new FlyPlatform({root:process.cwd(),directory});const calls=[];
  p.fly=async args=>{calls.push(args);return args[0]==='auth'?'fake-fly-token':'';};
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async(url,options)=>{
    assert.ok(url.startsWith('https://registry.fly.io/v2/amp-example/manifests/setup-'));
    assert.equal(options.redirect,'error');assert.equal(options.method,'HEAD');
    return new Response(null,{headers:{'docker-content-digest':'sha256:'+'b'.repeat(64)}});
  };
  t.after(()=>{globalThis.fetch=oldFetch;});
  assert.equal(await p.buildImage(spec),'registry.fly.io/amp-example@sha256:'+'b'.repeat(64));
  assert.ok(calls[0].includes('--remote-only'));assert.ok(calls[0].includes('--build-only'));assert.ok(calls[0].includes('--depot=false'));
  assert.ok(!calls.some(c=>c.includes('docker')||c.includes('--local-only')));
  const config=await readFile(join(directory,'build.toml'),'utf8');assert.ok(!config.includes('[build]'));assert.match(config,/amp-example/);
});
