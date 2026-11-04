import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { ensureAmp } from '../src/install-amp.mjs';
import { ProviderError } from '../src/api.mjs';

const execute = promisify(execFile);
const tokenKey = 'orb-provider-token@https://ampcode.com/';
export const tokenFingerprint = token => createHash('sha256').update(token).digest('hex');
export function ampProviderSpec({ name, workspace = null }) {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(name || '')) throw new ProviderError('Use a provider name of 3–63 lowercase letters, digits, or hyphens, starting with a letter.');
  if (workspace !== null && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(workspace)) throw new ProviderError('Enter a valid Amp workspace namespace.');
  return { name, workspace };
}
export function ampSecretsPath(env = process.env, platform = process.platform) {
  const home = env.HOME || homedir();
  const base = platform === 'linux' && env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, '.local', 'share');
  return join(base, 'amp', 'secrets.json');
}

export class AmpProviderSetup {
  constructor({ root, env = process.env, interactive, log = () => {}, run = execute, install = ensureAmp }) {
    this.root = root; this.log = log; this.interactive = interactive;
    this.run = run; this.install = install;
    this.env = { ...env, AMP_URL: 'https://ampcode.com' };
    delete this.env.AMP_API_KEY;
    delete this.env.AMP_ORB_PROVIDER_TOKEN;
    this.secretPath = ampSecretsPath(this.env);
  }
  async command(args) {
    try { return (await this.run(this.binary, args, { cwd: this.root, env: this.env, timeout: 60_000, maxBuffer: 1024 * 1024 })).stdout; }
    catch { throw new ProviderError('Amp command failed. Raw output was withheld because it may contain credentials.'); }
  }
  async ensureCLI() {
    const directory = join(this.root, '.tools', 'setup-amp');
    this.binary = (await this.install(directory, { log: this.log })).binary;
    const supportsCreate = async () => /Usage: amp orb provider create\b/.test(await this.command(['orb', 'provider', 'create', '--help']));
    if (!await supportsCreate()) {
      this.binary = (await this.install(directory, { log: this.log, refresh: true })).binary;
      if (!await supportsCreate()) throw new ProviderError('This Amp release does not support provider creation. Retry after updating Amp.');
    }
  }
  async ensureLogin() {
    const connected = async () => {
      try {
        const result = JSON.parse(await this.command(['account', 'list', '--json']));
        return Array.isArray(result.accounts) && result.accounts.some(a => a.active === true);
      } catch { return false; }
    };
    if (await connected()) return;
    this.log('Sign in to Amp in the browser window opened by its CLI.');
    await this.interactive(this.binary, ['login'], this.env);
    if (!await connected()) throw new ProviderError('Amp sign-in did not complete. Run setup again after signing in.');
  }
  async savedToken() {
    try {
      const data = JSON.parse(await readFile(this.secretPath, 'utf8'));
      const token = data[tokenKey];
      if (token === undefined) return undefined;
      if (typeof token !== 'string' || !/^aop_live_[A-Za-z0-9_-]+$/.test(token)) throw new Error('format');
      return token;
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw new ProviderError('Cannot read the saved Amp provider token. The CLI secret-storage format may have changed.');
    }
  }
  // Called under the installation lock. The journal never contains credentials.
  async resolve({ spec, provider, journal }) {
    const identity = ampProviderSpec(provider);
    let state = await journal.read();
    if (state && JSON.stringify(state.spec) !== JSON.stringify(spec)) throw new ProviderError('Installation identity changed; use the original installation settings.');
    if (state?.ampProvider && (state.ampProvider.name !== identity.name || state.ampProvider.workspace !== identity.workspace)) throw new ProviderError('Amp provider identity changed; use the original name and workspace.');
    if (state?.secretsConfigured) return undefined;
    if (state?.ampProvider?.phase === 'creating') throw new ProviderError('Amp provider creation was interrupted or failed. Inspect Amp Settings → Orbs before recovery; setup will not create another provider automatically.');
    if (state?.fingerprint) {
      const token = await this.savedToken();
      if (!token || tokenFingerprint(token) !== state.fingerprint) throw new ProviderError('Amp’s saved provider token no longer matches this installation. Restore its original token through AMP_ORB_PROVIDER_TOKEN; do not create another provider to retry this installation.');
      return token;
    }
    if (state && !state.ampProvider) throw new ProviderError('This installation needs its original AMP_ORB_PROVIDER_TOKEN. Automatic creation cannot replace an existing provider.');
    await this.ensureCLI();
    await this.ensureLogin();
    // Serialize this installer's create/read sequence across checkouts. Amp itself
    // does not honor this lock; do not create another provider concurrently.
    const lock = join(dirname(this.secretPath), 'amp-orbs-on-sprites-provider.lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { throw new ProviderError('Another Amp provider setup may be running. Inspect the provider lock beside Amp secrets.json before retrying.'); }
    try {
      const previous = await this.savedToken();
      state = { version: 1, spec, ampProvider: { ...identity, phase: 'creating' } };
      await journal.write(state);
      this.log(`Creating Amp provider ${identity.name} (${identity.workspace || 'personal'})…`);
      const args = ['orb', 'provider', 'create', identity.name];
      if (identity.workspace) args.push('--workspace', identity.workspace);
      try { await this.command(args); }
      catch { throw new ProviderError('Amp provider creation did not complete reliably. Inspect Amp Settings → Orbs before retrying; no token was transferred.'); }
      const token = await this.savedToken();
      if (!token || token === previous) throw new ProviderError('Amp did not save a fresh provider token. Inspect the created provider before recovery; no token was transferred.');
      await journal.write({ ...state, fingerprint: tokenFingerprint(token), ampProvider: { ...identity, phase: 'created' } });
      return token;
    } finally { await rm(lock, { recursive: true, force: true }); }
  }
}
