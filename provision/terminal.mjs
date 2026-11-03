import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { ProviderError } from '../src/api.mjs';

export async function readSecret(label) {
  if (!process.stdin.isTTY) throw new ProviderError('Set AMP_ORB_PROVIDER_TOKEN in the environment for unattended setup.');
  const rl=createInterface({input:process.stdin,output:process.stdout,terminal:false});
  const restore=()=>{try{execFileSync('stty',['echo'],{stdio:'inherit'});}finally{rl.close();}};
  const interrupted=()=>{restore();process.exit(130);};
  process.once('SIGINT',interrupted);process.once('SIGTERM',interrupted);
  try {
    execFileSync('stty',['-echo'],{stdio:'inherit'});
    return (await rl.question(label)).trim();
  } finally {
    process.removeListener('SIGINT',interrupted);process.removeListener('SIGTERM',interrupted);
    restore();console.log();
  }
}
