#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installationSpec } from './src/provision.mjs';
import { runInstallation } from './provision/run.mjs';
import { readSecret } from './provision/terminal.mjs';
import { ProviderError } from './src/api.mjs';
const root=dirname(fileURLToPath(import.meta.url));
try {
  const args=process.argv.slice(2), flags={};
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--rebuild') flags.rebuild=true;
    else if(args[i]==='--handoff-local') flags.handoff=true;
    else if(['--org','--app','--provider','--region'].includes(args[i]) && args[i+1]) flags[args[i++].slice(2)]=args[i];
    else throw new ProviderError('Usage: npm run provision -- --org SLUG --app NAME [--provider PREFIX] [--region ord] [--handoff-local]');
  }
  if(existsSync(join(root,'.env.local'))) process.loadEnvFile(join(root,'.env.local'));
  const spec=installationSpec({...flags,provider:flags.provider || process.env.SPRITES_PROVIDER_ID || 'amp-orbs'});
  let ampToken=process.env.AMP_ORB_PROVIDER_TOKEN;
  if(!ampToken) ampToken=await readSecret('Paste Amp provider token (hidden): ');
  const result=await runInstallation({root,spec,ampToken,handoff:flags.handoff,rebuild:flags.rebuild,progress:e=>console.log(JSON.stringify(e))});
  console.log(`Dispatcher ready: https://fly.io/apps/${result.spec.app} (runtime credential expires ${result.credentialExpiresAt}).`);
}catch(error){console.error(error instanceof ProviderError ? error.message : 'Provisioning failed; inspect the installation journal before retrying.');process.exitCode=1;}
