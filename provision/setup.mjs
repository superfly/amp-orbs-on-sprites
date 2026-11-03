import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { promisify } from 'node:util';
import { FlyPlatform } from './fly-platform.mjs';
import { SpritesCLIAPI } from '../src/cli-api.mjs';
import { ProviderError } from '../src/api.mjs';
import { setupFlow } from './setup-flow.mjs';
import { runInstallation } from './run.mjs';
import { readSecret } from './terminal.mjs';
const execute=promisify(execFile);
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const options={};
const help=`Usage: ./setup [--org SLUG] [--app NAME] [--provider PREFIX] [--region ord]
               [--rebuild] [--handoff-local] [--yes]

Guides Fly/Sprites login and Amp provider setup, builds on Fly, and deploys one
hosted dispatcher. Requires Node.js 22+. Missing Fly/Sprite CLIs can be installed
in this checkout. No Docker or local Amp installation is required.

Rerun to resume/check an installation. --rebuild deploys the current source.
--yes accepts installation/deployment prompts; supply --org and a token in the
environment for unattended new installations. Tokens are never command flags.`;

async function interactive(binary,args,env=process.env) {
  await new Promise((accept,reject)=>{
    const child=spawn(binary,args,{cwd:root,env,stdio:'inherit'});
    child.once('error',()=>reject(new ProviderError(`Could not start ${binary}.`)));
    child.once('exit',code=>code===0?accept():reject(new ProviderError(`${binary} did not complete. Rerun ./setup to try again.`)));
  });
}
const ui={
  log:message=>console.log(message),
  async ask(label,fallback) {
    if(!process.stdin.isTTY) {
      if(options.yes && fallback!==undefined)return fallback;
      throw new ProviderError('Interactive setup needs a terminal. For automation, pass --yes --org SLUG --app NAME and set AMP_ORB_PROVIDER_TOKEN for a new installation.');
    }
    const rl=createInterface({input:process.stdin,output:process.stdout});
    try {return (await rl.question(`${label}${fallback===undefined?'':` [${fallback}]`}: `)).trim() || fallback || '';}
    finally {rl.close();}
  },
  async choose(label,choices) {
    console.log(`\n${label}`);choices.forEach((choice,index)=>console.log(`  ${index+1}. ${choice}`));
    while(true){
      const answer=await this.ask('Choose a number');
      if(/^\d+$/.test(answer) && Number(answer)>=1 && Number(answer)<=choices.length)return Number(answer)-1;
      console.log('Enter one of the listed numbers.');
    }
  },
  async confirm(label) {return /^(y|yes)$/i.test(await this.ask(`${label} [y/N]`));},
  secret:readSecret,
};

const messages={
  'checking-access':'Checking access…', 'building-image':'Preparing the remote build…',
  'building-container':'Building on Fly (no local Docker required)…', 'build-running':'The remote build is still running…',
  'publishing-container':'Verifying the published image…','preparing-storage':'Checking persistent storage…',
  'connecting-sprites':'Creating and verifying the restricted Sprite credential…',
  'activating-dispatcher':'Deploying the dispatcher…','verifying-connection':'Waiting for the Amp connection…',
  ready:'Dispatcher connected to Amp.',
};
try {
  const args=process.argv.slice(2);
  if(args.includes('--help') || args.includes('-h')) {console.log(help);process.exit(0);}
  for(let i=0;i<args.length;i++) {
    const flag=args[i];
    if(['--org','--app','--provider','--region'].includes(flag) && args[i+1] && !args[i+1].startsWith('--'))options[flag.slice(2)]=args[++i];
    else if(flag==='--yes')options.yes=true;
    else if(flag==='--rebuild')options.rebuild=true;
    else if(flag==='--handoff-local')options.handoff=true;
    else throw new ProviderError(help);
  }
  if(existsSync(join(root,'.env.local')))process.loadEnvFile(join(root,'.env.local'));
  process.env.PATH=[join(root,'.tools','bin'),join(root,'.tools','fly','bin'),join(homedir(),'.fly','bin'),join(homedir(),'.local','bin'),process.env.PATH].join(delimiter);
  const platform=new FlyPlatform({root,directory:join(root,'.state'),progress:e=>ui.log(messages[e.step] || e.step)});
  async function installTool(name) {
    try {await execute(name,['--help'],{env:process.env,timeout:10_000});return;}
    catch(error){if(error.code!=='ENOENT')throw new ProviderError(`${name} is installed but cannot run. Repair it and rerun ./setup.`);}
    if(!options.yes && !await ui.confirm(`Install the ${name} CLI in this checkout?`))throw new ProviderError(`${name} is required. Install it and rerun ./setup.`);
    const url=name==='fly'?'https://fly.io/install.sh':'https://sprites.dev/install.sh';
    const response=await fetch(url,{signal:AbortSignal.timeout(30_000)});
    if(!response.ok || !response.url.startsWith('https:'))throw new ProviderError(`Could not download the official ${name} installer.`);
    const content=await response.text();
    if(content.length>256_000)throw new ProviderError('Unexpected installer response.');
    const directory=join(root,'.tools');await mkdir(directory,{recursive:true,mode:0o700});
    const path=join(directory,`install-${name}.sh`);await writeFile(path,content,{mode:0o700});
    ui.log(`Installing ${name} from its official distribution…`);
    await interactive('sh',[path,...(name==='sprite'?['--bin-dir',join(directory,'bin')]:[])],{...process.env,FLYCTL_INSTALL:join(directory,'fly')});
    await execute(name,['--help'],{env:process.env,timeout:10_000});
  }
  const connection={
    ensureTools:async()=>{await installTool('fly');await installTool('sprite');},
    flyConnected:async()=>{try{await platform.fly(['auth','whoami']);return true;}catch{return false;}},
    flyLogin:async mode=>{ui.log('Complete Fly sign-in in the browser; the CLI will show a link if it cannot open one.');await interactive('fly',['auth',mode]);},
    async organizations() {
      const token=(await platform.fly(['auth','token'])).trim();
      const response=await fetch('https://api.fly.io/graphql',{method:'POST',redirect:'error',signal:AbortSignal.timeout(30_000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({query:'{ organizations { nodes { name rawSlug } } }'})});
      if(!response.ok)throw new ProviderError('Could not list Fly organizations. Check account access and retry.');
      const data=await response.json();
      if(data.errors || !Array.isArray(data.data?.organizations?.nodes))throw new ProviderError('Could not list Fly organizations. Check account access and retry.');
      return data.data.organizations.nodes.map(o=>({name:o.name,slug:o.rawSlug})).sort((a,b)=>a.slug.localeCompare(b.slug));
    },
    async spritesConnected(org) {
      try {
        const api=new SpritesCLIAPI({org,spriteBin:'sprite'},AbortSignal.timeout(45_000));
        const data=await api.request('GET','/organization');return data.organization?.slug===org && data.organization?.sprites_enabled===true;
      }catch{return false;}
    },
    spritesLogin:org=>interactive('sprite',['login','-o',org]),
  };
  const installations=[];
  const base=join(root,'.state','installations');
  for(const name of existsSync(base)?await readdir(base):[]) {
    try {const state=JSON.parse(await readFile(join(base,name,'installation.json'),'utf8'));if(state.spec)installations.push(state);}
    catch(error){if(error.code!=='ENOENT' && error.code!=='ENOTDIR')throw new ProviderError('Cannot read saved installation state. Inspect .state/installations before continuing.');}
  }
  const result=await setupFlow({options,env:process.env,ui,connection,installations,run:input=>runInstallation({root,...input,progress:e=>ui.log(messages[e.step] || e.step)})});
  if(result) {
    console.log(`\nReady: https://fly.io/apps/${result.spec.app}`);
    console.log('In Amp, start a thread and select the provider whose token you supplied. You can close this terminal.');
    console.log(`Sprite credential expires ${result.credentialExpiresAt}. Credential rotation is not automated yet.`);
  }
}catch(error){console.error(error instanceof ProviderError?error.message:'Setup failed. Check your connection and saved installation state, then rerun ./setup.');process.exitCode=1;}
