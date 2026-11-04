import test from 'node:test';
import assert from 'node:assert/strict';
import { setupFlow, credentialNotice } from '../provision/setup-flow.mjs';
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
test('guides login, organization selection, Sprite authorization, and automatic Amp provider creation',async()=>{
  const f=fixture();await setupFlow({...f,options:{provider:'amp-test'}});
  assert.deepEqual(f.events,['tools','fly-login','sprites-example','provision']);
  assert.deepEqual(f.submitted.spec,spec);assert.equal(f.submitted.ampToken,undefined);
  assert.deepEqual(f.submitted.ampProvider,{name:spec.app,workspace:null});
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
test('automatic workspace choice and unattended personal default reach the operation',async()=>{
  const f=fixture();f.connect();
  await setupFlow({...f,options:{org:'example',app:spec.app,'amp-provider':'team-orbs','amp-workspace':'team',yes:true}});
  assert.deepEqual(f.submitted.ampProvider,{name:'team-orbs',workspace:'team'});
  const g=fixture();g.connect();
  g.ui.ask=async()=>{throw Error('Unexpected prompt in unattended setup');};
  await setupFlow({...g,options:{org:'example',app:spec.app,yes:true}});
  assert.equal(g.submitted.ampProvider.workspace,null);
});
test('pending automatic installation reuses recorded provider identity',async()=>{
  const f=fixture();f.connect();const ampProvider={name:'saved-name',workspace:'team',phase:'created'};
  await setupFlow({...f,options:{org:'example',app:spec.app,yes:true},installations:[{spec,ampProvider}]});
  assert.deepEqual(f.submitted.ampProvider,ampProvider);
});
test('existing token remains supported, but cannot be combined with automatic creation flags',async()=>{
  const f=fixture();f.connect();
  await setupFlow({...f,options:{org:'example',app:spec.app,yes:true},env:{AMP_ORB_PROVIDER_TOKEN:token}});
  assert.equal(f.submitted.ampToken,token);assert.equal(f.submitted.ampProvider,undefined);
  await assert.rejects(setupFlow({...f,options:{org:'example','amp-provider':'new-provider'},env:{AMP_ORB_PROVIDER_TOKEN:token}}),/not both/);
});
test('completed automatic install does not need local credentials and refuses a changed provider',async()=>{
  const f=fixture();f.connect();const saved={spec,secretsConfigured:true,activated:true,ampProvider:{name:'saved',workspace:null,phase:'created'}};
  await setupFlow({...f,options:{org:'example',app:spec.app,yes:true},installations:[saved]});
  assert.equal(f.submitted.ampToken,undefined);
  await assert.rejects(setupFlow({...f,options:{org:'example',app:spec.app,'amp-provider':'different'},installations:[saved]}),/identity changed/);
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

const completed={spec,secretsConfigured:true,activated:true,image:'img',credentialExpiresAt:'2026-11-10T00:00:00Z',credentialTokenId:'tok_1',ampProvider:{name:'saved',workspace:null,phase:'created'}};
const now=Date.parse('2026-11-04T00:00:00Z');
test('credential notices name the rotation command and warn within fourteen days',()=>{
  assert.deepEqual(credentialNotice({spec},now),[]);
  const fine=credentialNotice({...completed,credentialExpiresAt:'2027-01-01T00:00:00Z'},now);
  assert.equal(fine.length,1);assert.match(fine[0],/expires 2027-01-01.*--rotate-credential --app amp-example/);
  const soon=credentialNotice(completed,now);
  assert.equal(soon.length,2);assert.match(soon[0],/6 days left/);assert.match(soon[1],/^Rotate it with: \.\/setup --rotate-credential --app amp-example$/);
  assert.match(credentialNotice({...completed,credentialExpiresAt:'2026-11-01T00:00:00Z'},now)[0],/expired 2026-11-01/);
});
test('plain reruns warn about a credential that expires soon',async()=>{
  const f=fixture();f.connect();
  await setupFlow({...f,options:{org:'example',app:spec.app,yes:true},installations:[completed],now});
  assert.ok(f.logs.some(l=>/6 days left/.test(l)));assert.ok(f.logs.some(l=>l.includes('--rotate-credential --app amp-example')));
  assert.equal(f.submitted.mode,undefined);
});
test('rotation runs only for a completed installation and skips Amp provider prompts',async()=>{
  const f=fixture();f.connect();
  await setupFlow({...f,options:{rotate:true,org:'example',app:spec.app,yes:true},installations:[completed],now});
  assert.deepEqual(f.submitted,{spec,mode:'rotate'});assert.ok(!f.events.includes('token-prompt'));
  assert.ok(f.logs.some(l=>l.includes('revoke the previous credential')));
  await assert.rejects(setupFlow({...f,options:{rotate:true,org:'example',app:'unknown-app'},installations:[completed]}),/No installation named unknown-app/);
  await assert.rejects(setupFlow({...f,options:{rotate:true,org:'example',app:spec.app},installations:[{spec,secretsConfigured:true,activated:false}]}),/Finish the installation/);
  const g=fixture();g.connect();g.ui.confirm=async()=>false;
  assert.equal(await setupFlow({...g,options:{rotate:true,org:'example',app:spec.app},installations:[completed]}),null);
  assert.ok(!g.events.includes('provision'));
});
test('destroy requires the typed app name and is not bypassed by --yes',async()=>{
  const f=fixture();f.connect();f.ui.ask=async()=>'amp-exampl';
  assert.equal(await setupFlow({...f,options:{destroy:true,org:'example',app:spec.app,yes:true},installations:[completed]}),null);
  assert.ok(!f.events.includes('provision'));assert.ok(f.logs.some(l=>l.includes('did not match')));
  f.ui.ask=async label=>{assert.match(label,/amp-example/);return spec.app;};
  await setupFlow({...f,options:{destroy:true,org:'example',app:spec.app},installations:[completed]});
  assert.deepEqual(f.submitted,{spec,mode:'destroy'});
  assert.ok(f.logs.some(l=>l.includes('Amp Settings → Orbs')));
  const g=fixture();g.connect();g.ui.ask=async()=>{throw new Error('Interactive setup needs a terminal.');};
  await assert.rejects(setupFlow({...g,options:{destroy:true,org:'example',app:spec.app,yes:true},installations:[completed]}),/needs a terminal/);
  assert.ok(!g.events.includes('provision'));
});
