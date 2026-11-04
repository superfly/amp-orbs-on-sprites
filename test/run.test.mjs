import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallation } from '../provision/run.mjs';

const spec={org:'example',app:'amp-example',provider:'amp-test',region:'ord'};
async function checkout(t,state){
  const root=await mkdtemp(join(tmpdir(),'amp-run-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const directory=join(root,'.state','installations',spec.app);
  await mkdir(directory,{recursive:true});
  await writeFile(join(directory,'installation.json'),JSON.stringify(state));
  await writeFile(join(directory,'fly.toml'),'app = "amp-example"\n');
  return {root,directory};
}
function platform(calls,{sprites=[]}={}){
  return {
    preflight:async()=>calls.push('preflight'), appExists:async()=>true,
    listSprites:async()=>({names:sprites,more:false}), destroyApp:async()=>calls.push('destroy-app'),
    revokeCredential:async c=>calls.push(`revoke:${c.tokenId}`),
    mintCredential:async()=>({token:'rotated-secret',expiresAt:'later',tokenId:'tok_2'}),
    setSecrets:async(s,secrets)=>calls.push(`secrets:${Object.keys(secrets).join(',')}`), deploy:async()=>calls.push('deploy'),
    verify:async()=>({machineId:'m_1'}),
  };
}
const completed={version:1,spec,appCreated:true,image:'registry.fly.io/amp-example@sha256:'+'a'.repeat(64),volumeId:'vol_1',secretsConfigured:true,activated:true,credentialExpiresAt:'2026-12-01T00:00:00Z',credentialTokenId:'tok_1',phase:'ready'};

test('destroy removes the installation directory only after teardown succeeds',async t=>{
  const calls=[];const {root,directory}=await checkout(t,completed);
  const result=await runInstallation({root,spec,mode:'destroy',platform:platform(calls)});
  assert.equal(result.destroyed,true);assert.deepEqual(calls,['preflight','destroy-app','revoke:tok_1']);
  await assert.rejects(stat(directory),{code:'ENOENT'});
});
test('destroy refusal keeps the journal, releases the lock, and touches no resources',async t=>{
  const calls=[];const {root,directory}=await checkout(t,completed);
  await assert.rejects(runInstallation({root,spec,mode:'destroy',platform:platform(calls,{sprites:['amp-test-live']})}),/still exist/);
  assert.deepEqual(calls,['preflight']);
  assert.deepEqual(JSON.parse(await readFile(join(directory,'installation.json'),'utf8')),completed);
  await assert.rejects(stat(join(directory,'operation.lock')),{code:'ENOENT'});
});
test('rotation through the runner updates the journal in place',async t=>{
  const calls=[];const {root,directory}=await checkout(t,completed);
  await runInstallation({root,spec,mode:'rotate',platform:platform(calls)});
  assert.deepEqual(calls,['preflight','secrets:spriteToken','deploy','revoke:tok_1']);
  const journal=JSON.parse(await readFile(join(directory,'installation.json'),'utf8'));
  assert.equal(journal.credentialTokenId,'tok_2');assert.equal(journal.credentialExpiresAt,'later');
  assert.ok(!JSON.stringify(journal).includes('rotated-secret'));
});
