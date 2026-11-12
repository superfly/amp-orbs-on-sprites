import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { AmpProviderSetup, ampProviderSpec, ampSecretsPath, tokenFingerprint } from '../provision/amp-provider.mjs';
import { runInstallation } from '../provision/run.mjs';

const key='orb-provider-token@https://ampcode.com/';
const token='aop_live_new_test_secret';
const spec={org:'example',app:'amp-example',provider:'amp-test',region:'ord'};
const provider={name:'my-orbs',workspace:null};
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'amp-provider-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const env={HOME:root,AMP_API_KEY:'private-login',AMP_ORB_PROVIDER_TOKEN:'old-provider',AMP_URL:'https://wrong.example'};
  const calls=[],logs=[],installs=[];let active=true,state=null;
  const f={root,calls,logs,installs,create:async()=>f.store(token),get state(){return state;},set state(value){state=value;},setActive:value=>{active=value;}};
  const amp=new AmpProviderSetup({root,env,log:s=>logs.push(s),
    install:async(_directory,options)=>{installs.push(options);return {binary:'/verified/amp'};},
    interactive:async(_bin,args)=>{calls.push(args);active=true;},
    run:async(_bin,args,options)=>{
      assert.equal(options.env.AMP_URL,'https://ampcode.com');
      assert.equal(options.env.AMP_API_KEY,undefined);assert.equal(options.env.AMP_ORB_PROVIDER_TOKEN,undefined);
      calls.push(args);
      if(args.includes('--help'))return {stdout:`Usage: amp orb provider ${args[2]} [options] <name>`};
      if(args[0]==='account')return {stdout:JSON.stringify({accounts:active?[{active:true}]:[]})};
      if(args[2]==='set-default')return {stdout:''};
      await f.create();return {stdout:`Created provider ${token}`,stderr:'private-login'};
    }});
  f.amp=amp;f.journal={read:async()=>state,write:async s=>{state=structuredClone(s);}};
  f.store=async value=>writeFile(amp.secretPath,JSON.stringify({apiKey:'private-login',...(value===undefined?{}:{[key]:value})}),{mode:0o600});
  await mkdir(dirname(amp.secretPath),{recursive:true});await f.store(undefined);
  f.resolve=()=>amp.resolve({spec,provider,journal:f.journal});
  return f;
}
test('creates with normal login, transfers only the provider token, and saves only its fingerprint',async t=>{
  const f=await fixture(t);f.setActive(false);
  assert.equal(await f.resolve(),token);
  assert.ok(f.calls.some(a=>a[0]==='login'));
  assert.deepEqual(f.calls.slice(-2),[['orb','provider','create','my-orbs'],['orb','provider','set-default','my-orbs']]);
  assert.equal(f.state.fingerprint,tokenFingerprint(token));
  assert.equal(f.state.ampProvider.phase,'created');
  assert.equal(f.state.ampProvider.defaultSet,true);
  for(const secret of [token,'private-login'])assert.ok(!JSON.stringify([f.state,f.logs,f.calls]).includes(secret));
  assert.equal(JSON.parse(await readFile(f.amp.secretPath)).apiKey,'private-login');
});
test('workspace creation and default selection pass the same explicit namespace',async t=>{
  const f=await fixture(t);
  await f.amp.resolve({spec,provider:{...provider,workspace:'team'},journal:f.journal});
  assert.deepEqual(f.calls.slice(-2),[['orb','provider','create','my-orbs','--workspace','team'],['orb','provider','set-default','my-orbs','--workspace','team']]);
  assert.equal(f.state.ampProvider.defaultSet,true);
});
test('failed default selection can retry without recreating the provider or leaking output',async t=>{
  const f=await fixture(t);const run=f.amp.run;
  f.amp.run=async(...args)=>{
    if(args[1][2]==='set-default'&&!args[1].includes('--help'))throw Error(token);
    return run(...args);
  };
  await assert.rejects(f.resolve(),e=>!e.message.includes(token)&&/Rerun setup to retry/.test(e.message));
  assert.equal(f.state.ampProvider.phase,'created');assert.equal(f.state.ampProvider.defaultSet,undefined);
  assert.equal(f.state.fingerprint,tokenFingerprint(token));
  f.amp.run=run;
  assert.equal(await f.resolve(),token);
  assert.equal(f.state.ampProvider.defaultSet,true);
  assert.equal(f.calls.filter(a=>a[2]==='create'&&!a.includes('--help')).length,1);
});
test('retry reuses the original token without creating, installing, or authenticating again',async t=>{
  const f=await fixture(t);await f.resolve();const count=f.calls.length;
  assert.equal(await f.resolve(),token);assert.equal(f.calls.length,count);
  await f.store('aop_live_different');
  await assert.rejects(f.resolve(),/no longer matches/);assert.equal(f.calls.length,count);
});
test('configured installation needs no local Amp token or CLI',async t=>{
  const f=await fixture(t);await f.resolve();f.state={...f.state,secretsConfigured:true};
  await rm(f.amp.secretPath);f.calls.length=0;
  assert.equal(await f.resolve(),undefined);assert.deepEqual(f.calls,[]);
});
test('failed creation leaves an ambiguous journal and does not silently create again',async t=>{
  const f=await fixture(t);f.create=async()=>{await f.store(token);throw Error(token);};
  await assert.rejects(f.resolve(),e=>!e.message.includes(token)&&/no token was transferred/.test(e.message));
  assert.equal(f.state.ampProvider.phase,'creating');const count=f.calls.length;
  await assert.rejects(f.resolve(),/will not create another/);assert.equal(f.calls.length,count);
});
test('missing, unchanged, or malformed token is never transferred after creation',async t=>{
  for(const value of [undefined,'aop_live_old',42]) {
    const f=await fixture(t);await f.store('aop_live_old');f.create=async()=>f.store(value);
    await assert.rejects(f.resolve(),/fresh provider token|secret-storage format/);
    assert.equal(f.state.ampProvider.phase,'creating');assert.equal(f.state.fingerprint,undefined);
  }
});
test('refuses concurrent creation and changed installation/provider identities',async t=>{
  const f=await fixture(t);const lock=join(dirname(f.amp.secretPath),'amp-orbs-on-sprites-provider.lock');
  await mkdir(lock);await assert.rejects(f.resolve(),/Another Amp provider setup/);assert.equal(f.state,null);
  await rm(lock,{recursive:true});await f.resolve();
  await assert.rejects(f.amp.resolve({spec:{...spec,org:'other'},provider,journal:f.journal}),/identity changed/);
  await assert.rejects(f.amp.resolve({spec,provider:{...provider,name:'other'},journal:f.journal}),/identity changed/);
});
test('refreshes a cached CLI lacking either required provider subcommand',async t=>{
  for(const missing of ['create','set-default']) {
    for(const throws of [false,true]) {
      const f=await fixture(t);const original=f.amp.command.bind(f.amp);
      f.amp.command=async args=>{
        if(args.includes('--help')&&args[2]===missing&&f.installs.length===1) {
          if(throws)throw Error('unsupported command');
          return 'Usage: amp orb provider <script>';
        }
        return original(args);
      };
      await f.resolve();assert.equal(f.installs.length,2);assert.equal(f.installs[1].refresh,true);
    }
  }
});
test('fails before creation when the refreshed CLI still lacks default selection',async t=>{
  const f=await fixture(t);const original=f.amp.command.bind(f.amp);
  f.amp.command=async args=>args[2]==='set-default'?'Usage: amp orb provider <script>':original(args);
  await assert.rejects(f.resolve(),/does not support.*default selection/);
  assert.equal(f.state,null);assert.equal(f.installs.length,2);
  assert.ok(!f.calls.some(a=>a[2]==='create'&&!a.includes('--help')));
});
test('secret path follows Amp platform rules and invalid names cannot become CLI options',()=>{
  assert.equal(ampSecretsPath({HOME:'/home/me',XDG_DATA_HOME:'/data'},'linux'),'/data/amp/secrets.json');
  assert.equal(ampSecretsPath({HOME:'/home/me',XDG_DATA_HOME:'/data'},'darwin'),'/home/me/.local/share/amp/secrets.json');
  for(const name of ['--workspace','x','a\nname'])assert.throws(()=>ampProviderSpec({name}));
  assert.throws(()=>ampProviderSpec({name:'valid',workspace:'--other'}));
});
test('installation retry survives a build failure without duplicating Amp providers or leaking tokens',async t=>{
  const f=await fixture(t);let exists=false,fail=true,received,volume=false,deploys=0;
  const platform={preflight:async()=>{},appExists:async()=>exists,createApp:async()=>{exists=true;},
    buildImage:async()=>{if(fail)throw Error('build failed');return 'image';},
    volumes:async()=>volume?[{id:'vol',name:'dispatcher_data',region:'ord'}]:[],createVolume:async()=>{volume=true;return 'vol';},
    mintCredential:async()=>({token:'sprite-secret'}),setSecrets:async(_spec,secrets)=>{received=secrets;},
    deploy:async()=>{deploys++;},verify:async()=>({machineId:'machine'})};
  const input={root:f.root,spec,ampProvider:provider,platform,resolveAmpProvider:args=>f.amp.resolve(args)};
  await assert.rejects(runInstallation(input),/build failed/);fail=false;
  await runInstallation(input);
  assert.equal(f.calls.filter(a=>a[2]==='create'&&!a.includes('--help')).length,1);
  assert.equal(received.ampToken,token);assert.ok(!Object.values(received).includes('private-login'));
  const saved=await readFile(join(f.root,'.state','installations',spec.app,'installation.json'),'utf8');
  assert.ok(!saved.includes(token));assert.equal(JSON.parse(saved).secretsConfigured,true);
  await rm(f.amp.secretPath);const calls=f.calls.length;
  await runInstallation(input);assert.equal(f.calls.length,calls);assert.equal(deploys,1);
});
test('Fly name collision is rejected before any Amp provider creation',async t=>{
  const f=await fixture(t);
  await assert.rejects(runInstallation({root:f.root,spec,ampProvider:provider,
    platform:{preflight:async()=>{},appExists:async()=>true},resolveAmpProvider:args=>f.amp.resolve(args)}),/without a completed ownership/);
  assert.deepEqual(f.calls,[]);
});
