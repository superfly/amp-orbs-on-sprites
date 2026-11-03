import { execFile } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SpritesCLIAPI } from '../src/cli-api.mjs';
import { randomUUID } from 'node:crypto';
import { SpritesAPI, ProviderError } from '../src/api.mjs';

export function flyConfig(spec, image) {
  return `app = "${spec.app}"
primary_region = "${spec.region}"
kill_signal = "SIGTERM"
kill_timeout = "30s"
[build]
  image = "${image}"
[env]
  SPRITE_ORG = "${spec.org}"
  SPRITES_PROVIDER_ID = "${spec.provider}"
  SPRITES_STATE_DIR = "/data"
  SPRITES_STATUS_FILE = "/data/provider-status.json"
[deploy]
  strategy = "immediate"
[[mounts]]
  source = "dispatcher_data"
  destination = "/data"
[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "512mb"
[[restart]]
  policy = "always"
`;
}

// CLI transport for the first installer. A Fly-hosted wizard can supply an API
// transport to the same provision() operation without changing its workflow.
export class FlyPlatform {
  constructor({ root, directory, progress = () => {}, env = process.env }) {
    this.root = root; this.directory = directory; this.progress = progress; this.env = env;
    this.runtimeClient = token => new SpritesAPI(token, AbortSignal.timeout(45000));
  }
  async command(binary, args, { input, timeout = 120_000, cwd = this.root } = {}) {
    // Raw stdout/stderr can contain API credentials. Only callers selecting
    // known non-sensitive fields may publish results.
    return new Promise((accept, reject) => {
      const child = execFile(binary, args, { cwd, env: this.env, timeout, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => error ? reject(new ProviderError(`${binary} ${args[0]} failed; check access, resource state, and local tool availability`)) : accept(stdout));
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    });
  }
  async fly(args, options) { return this.command('fly', args, options); }
  async preflight(spec) {
    await this.fly(['auth','whoami']);
    this.sprites = new SpritesCLIAPI({ org: spec.org, spriteBin: 'sprite' }, AbortSignal.timeout(60 * 60_000));
    const result = await this.sprites.request('GET','/organization');
    if (result.organization?.slug !== spec.org || !result.organization?.sprites_enabled) throw new ProviderError('Sprites is not enabled in the selected organization');
  }
  async appRequest(method, path, body) {
    this.flyToken ||= (await this.fly(['auth','token'])).trim();
    const response = await fetch(`https://api.machines.dev/v1${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Bearer ${this.flyToken}`, 'Content-Type':'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (method === 'GET' && response.status === 404) return null;
    if (!response.ok) throw new ProviderError(`Fly Apps API returned HTTP ${response.status}`);
    return response.json();
  }
  async appExists(spec) {
    const app = await this.appRequest('GET', `/apps/${spec.app}`);
    if (!app) return false;
    if (app.organization?.slug !== spec.org) throw new ProviderError('App is outside the selected organization');
    return true;
  }
  async createApp(spec) { await this.appRequest('POST','/apps',{ app_name:spec.app,org_slug:spec.org }); }
  async buildImage(spec) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const config = join(this.directory, 'build.toml');
    await writeFile(config, `app = "${spec.app}"\nprimary_region = "${spec.region}"\n`, { mode: 0o600 });
    const label = `setup-${randomUUID()}`;
    this.progress({ step: 'building-container', app: spec.app });
    const heartbeat = setInterval(() => this.progress({ step: 'build-running', app: spec.app }), 20_000);
    try {
      await this.fly(['deploy', this.root, '--app', spec.app, '--config', resolve(config),
        '--dockerfile', join(this.root, 'Dockerfile'), '--remote-only', '--depot=false',
        '--build-only', '--push', '--image-label', label, '--ha=false', '--yes'], { timeout: 30 * 60_000 });
    } finally { clearInterval(heartbeat); }
    this.progress({ step: 'publishing-container', app: spec.app });
    this.flyToken ||= (await this.fly(['auth', 'token'])).trim();
    const response = await fetch(`https://registry.fly.io/v2/${spec.app}/manifests/${label}`, {
      method: 'HEAD', redirect: 'error', signal: AbortSignal.timeout(45_000),
      headers: { Authorization: `Basic ${Buffer.from('x:' + this.flyToken).toString('base64')}`,
        Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
    });
    const digest = response.headers.get('docker-content-digest');
    if (!response.ok || !/^sha256:[a-f0-9]{64}$/.test(digest || '')) throw new ProviderError('Remote build finished but its registry digest could not be verified; retry setup');
    return `registry.fly.io/${spec.app}@${digest}`;
  }
  async volumes(spec) {
    const data = JSON.parse(await this.fly(['volumes','list','--app',spec.app,'--json']));
    return data.map(v => ({ id: v.id, name: v.name, region: v.region }));
  }
  async createVolume(spec) {
    const result = JSON.parse(await this.fly(['volumes','create','dispatcher_data','--app',spec.app,'--region',spec.region,'--size','1','--yes','--json']));
    const volume = Array.isArray(result) ? result[0] : result;
    if (!volume.id) throw new ProviderError('Volume creation returned no ID; inspect before retrying');
    return volume.id;
  }
  async mintCredential(spec) {
    const description = `Amp dispatcher ${spec.app} ${randomUUID()}`;
    const expiresAt = new Date(Date.now() + 90 * 86400_000).toISOString();
    const prefix = `${spec.provider}-`;
    // Authentication format, not guest runtime, selects the token API contract.
    // Supply the equivalent prefix/expiry restrictions in both formats.
    const value = await this.sprites.request('POST','/tokens', {
      description, ttl: 90 * 86400, name_prefix: prefix, mint_ttl: 0,
      sprites: { '*': ['read','create','exec','start','stop','destroy','services'] },
      policy: { name_prefix: prefix, expires_at: expiresAt },
    });
    const credential = { token: value.token, expiresAt: value.expires_at || value.policy?.expires_at };
    if (!value.expires_at) {
      const { tokens } = await this.sprites.request('GET','/tokens');
      const matches = tokens.filter(t => t.description === description);
      if (matches.length !== 1) throw new ProviderError('Cannot identify newly minted runtime credential; inspect token metadata');
      credential.tokenId = matches[0].id;
      credential.expiresAt = matches[0].policy?.expires_at;
      credential.confirmedPrefix = matches[0].policy?.name_prefix;
    }
    try {
      if (!credential.token || !credential.expiresAt || (!value.expires_at && credential.confirmedPrefix !== prefix)) throw new ProviderError('Runtime credential restrictions were not confirmed');
      const child = this.runtimeClient(credential.token);
      await child.request('GET','/sprites?max_results=1');
      let denied = false;
      try { await child.request('GET','/tokens'); } catch(error) { if(error.status === 403) denied = true; else throw error; }
      if (!denied) throw new ProviderError('Runtime credential unexpectedly permits token administration');
      return credential;
    } catch(error) { await this.revokeCredential(credential); throw error; }
  }
  async revokeCredential(credential) {
    if (credential.tokenId) await this.sprites.request('DELETE',`/tokens/${credential.tokenId}`);
    else await this.sprites.request('POST','/tokens/revoke',{token:credential.token});
  }
  async setSecrets(spec, secrets) {
    const values = { AMP_ORB_PROVIDER_TOKEN: secrets.ampToken, SPRITE_TOKEN: secrets.spriteToken,
      SPRITES_INITIAL_RECORDS: JSON.stringify(secrets.initialRecords) };
    if (Object.values(values).some(v => /[\r\n]/.test(v))) throw new ProviderError('Invalid multiline credential');
    await this.fly(['secrets','import','--app',spec.app,'--stage'], { input: Object.entries(values).map(([k,v])=>`${k}=${v}`).join('\n')+'\n' });
  }
  async machines(spec) { return JSON.parse(await this.fly(['machine','list','--app',spec.app,'--json'])); }
  async deploy(spec, image) {
    const machines = await this.machines(spec);
    if (machines.length > 1) throw new ProviderError('Expected at most one dispatcher Machine; inspect before deploying');
    await mkdir(this.directory, { recursive:true, mode:0o700 });
    const config = join(this.directory,'fly.toml');
    await writeFile(config,flyConfig(spec,image),{mode:0o600});
    await this.fly(['deploy','--app',spec.app,'--config',resolve(config),'--image',image,'--strategy','immediate','--ha=false','--yes','--wait-timeout','5m'],{timeout:10*60_000});
  }
  async verify(spec) {
    for (let attempt=0;attempt<24;attempt++) {
      const machines = await this.machines(spec);
      if (machines.length > 1) throw new ProviderError('More than one dispatcher Machine exists');
      if (machines.length===1 && machines[0].state==='started') {
        try {
          const raw=await this.fly(['machine','exec',machines[0].id,'cat /data/provider-status.json','--app',spec.app,'--json']);
          const result=JSON.parse(raw);
          const status=JSON.parse(result.stdout ?? result.output ?? raw);
          if (status.status==='connected') return {machineId:machines[0].id};
        } catch { /* Boot may still be starting. */ }
      }
      await delay(5000);
    }
    throw new ProviderError('Dispatcher did not confirm its Amp connection; inspect the app before retrying');
  }
}
