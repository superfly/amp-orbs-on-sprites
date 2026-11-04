import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { provision, rotateCredential, destroyInstallation } from '../src/provision.mjs';
import { FlyPlatform } from './fly-platform.mjs';
import { ProviderError } from '../src/api.mjs';

// mode: 'install' (default), 'rotate' (replace the Sprite credential), or
// 'destroy' (tear down and forget the installation).
export async function runInstallation({root,spec,ampToken,ampProvider,resolveAmpProvider,handoff=false,rebuild=false,mode='install',progress=()=>{},platform:providedPlatform}) {
  let lock;
  try {
  const directory=join(root,'.state','installations',spec.app);
  await mkdir(directory,{recursive:true,mode:0o700});
  const lockPath=join(directory,'operation.lock');
  await mkdir(lockPath);
  lock=lockPath; // Deliberately not age-based; recover interrupted locks explicitly.
  const path=join(directory,'installation.json');
  const journal={
    read:async()=>{try{return JSON.parse(await readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}},
    write:async value=>{await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});await rename(path+'.tmp',path);},
  };
  const platform=providedPlatform || new FlyPlatform({root,directory,progress});
  if(mode==='rotate')return rotateCredential(spec,{platform,journal,progress});
  if(mode==='destroy') {
    const result=await destroyInstallation(spec,{platform,journal,progress});
    // The lock lives inside the directory; remove the whole installation record.
    await rm(directory,{recursive:true,force:true});lock=undefined;
    return result;
  }
  const saved=await journal.read();
  if(saved && JSON.stringify(saved.spec)!==JSON.stringify(spec))throw new ProviderError('Installation identity changed; use the original settings.');
  if(ampProvider && !ampToken && !saved?.secretsConfigured) {
    if(!resolveAmpProvider)throw new ProviderError('Automatic Amp provider setup is unavailable.');
    // Check Fly access and name collisions before creating an Amp provider.
    await platform.preflight(spec);
    if(!saved?.appCreated && await platform.appExists(spec))throw new ProviderError('App already exists without a completed ownership record; inspect it before recovery');
    ampToken=await resolveAmpProvider({spec,provider:ampProvider,journal});
  }
  const initialRecords=[];
  const localRoot=resolve(process.env.SPRITES_STATE_DIR || join(root,'.state'));
  if(handoff) {
    for(const name of await readdir(join(localRoot,spec.provider))) if(name.endsWith('.json')) {
      const record=JSON.parse(await readFile(join(localRoot,spec.provider,name),'utf8'));
      if(record.org!==spec.org || record.paused!==true) throw new ProviderError('Pause all local Orbs before handoff');
      initialRecords.push(record);
    }
  }
  const beforeActivate=async()=>{
    const controllerLock=join(localRoot,`${spec.provider}.controller.lock`);
    let local;
    try {local=JSON.parse(await readFile(controllerLock,'utf8'));} catch(e){if(e.code==='ENOENT')return;throw e;}
    try{process.kill(local.pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}
    if(!handoff)throw new ProviderError('Local controller is running; pause Orbs and use --handoff-local');
    if(local.org!==spec.org||local.provider!==spec.provider)throw new ProviderError('Local controller identity mismatch');
    // Verify the PID still belongs to this checkout before signaling it.
    const command=await platform.command('ps',['-p',String(local.pid),'-o','command=']);
    if(!command.includes('node') || !command.includes('start.mjs') || !command.includes(`--org ${spec.org}`)) throw new ProviderError('Controller PID identity changed; inspect before handoff');
    const cwdInfo=await platform.command('lsof',['-a','-p',String(local.pid),'-d','cwd','-Fn']);
    if(!cwdInfo.split('\n').includes(`n${root}`)) throw new ProviderError('Local controller belongs to another checkout; inspect before handoff');
    process.kill(local.pid,'SIGTERM');
    for(let i=0;i<30;i++) {
      try{process.kill(local.pid,0);}catch(e){if(e.code==='ESRCH')return;throw e;}
      await delay(1000);
    }
    throw new ProviderError('Local controller has not stopped; hosted activation withheld');
  };
  const result=await provision({...spec,ampToken,initialRecords,rebuild},{platform,journal,beforeActivate,progress});
  return result;
  } finally {if(lock)await rm(lock,{recursive:true,force:true});}
}
