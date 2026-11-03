#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile, rename } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureAmp } from './src/install-amp.mjs';
import { SpritesAPI, ProviderError } from './src/api.mjs';
import { SpritesCLIAPI } from './src/cli-api.mjs';

const root = dirname(fileURLToPath(import.meta.url));
let lock;
let statusWrites = Promise.resolve();
function status(value) {
  if (!process.env.SPRITES_STATUS_FILE) return;
  const path = process.env.SPRITES_STATUS_FILE;
  statusWrites = statusWrites.then(async () => {
    await writeFile(path + '.tmp', JSON.stringify({ status: value, observedAt: new Date().toISOString() }), { mode: 0o600 });
    await rename(path + '.tmp', path);
  });
}
status('starting');
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: npm start -- --org <organization>\nReads AMP_ORB_PROVIDER_TOKEN from .env.local or the environment. Reuses the Sprite CLI login.');
    process.exit(0);
  }
  if (args.length !== 2 || args[0] !== '--org' || !/^[a-z0-9][a-z0-9-]*$/.test(args[1])) {
    throw new ProviderError('Pass the target organization explicitly: npm start -- --org <organization>');
  }
  const org = args[1];
  if (existsSync(join(root, '.env.local'))) process.loadEnvFile(join(root, '.env.local'));
  const token = process.env.AMP_ORB_PROVIDER_TOKEN;
  if (!token) throw new ProviderError('Add AMP_ORB_PROVIDER_TOKEN to .env.local using the token from Amp Settings → Orbs.');
  const provider = process.env.SPRITES_PROVIDER_ID || 'mcp-amp';
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(provider)) throw new ProviderError('Invalid SPRITES_PROVIDER_ID');
  const stateDir = resolve(process.env.SPRITES_STATE_DIR || join(root, '.state'));
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const lockPath = join(stateDir, `${provider}.controller.lock`);
  try {
    const old = JSON.parse(await readFile(lockPath, 'utf8'));
    try { process.kill(old.pid, 0); throw new ProviderError('This provider already has a running controller.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rm(lockPath);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const handle = await open(lockPath, 'wx', 0o600);
  lock = lockPath;
  await handle.writeFile(JSON.stringify({ pid: process.pid, org, provider }));
  await handle.close();

  const config = { org, spriteBin: process.env.SPRITE_BIN || 'sprite', token: process.env.SPRITE_TOKEN };
  const signal = AbortSignal.timeout(45_000);
  const api = config.token ? new SpritesAPI(config.token, signal) : new SpritesCLIAPI(config, signal);
  try { await api.request('GET', '/sprites?max_results=1'); }
  catch { throw new ProviderError(`Sprites access failed. Install the Sprite CLI and run: sprite login -o ${org}`); }
  const release = await ensureAmp(join(root, '.tools'), { version: process.env.SPRITES_AMP_VERSION });
  console.log(`Starting Orb provider for ${org}; Sprite prefix ${provider}-. Keep this controller running.`);
  const env = { PATH: process.env.PATH, HOME: process.env.HOME,
    AMP_ORB_PROVIDER_TOKEN: token, SPRITE_ORG: org, SPRITES_PROVIDER_ID: provider,
    SPRITES_STATE_DIR: stateDir, SPRITES_NATIVE_BASE: '1', SPRITE_BIN: config.spriteBin,
    SPRITES_AMP_BINARY_URL: release.linux.url, SPRITES_AMP_BINARY_SHA256: release.linux.sha256 };
  if (config.token) env.SPRITE_TOKEN = config.token;
  const child = spawn(release.binary, ['orb', 'provider', join(root, 'dispatch.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) createInterface({ input: stream }).on('line', line => {
    if (line.includes('Orb provider started')) status('connected');
    if (line.includes('Orb provider stopped')) status('disconnected');
    console.log(line.replaceAll(token, '[REDACTED]').replace(/aop_live_[A-Za-z0-9_-]+/g, '[REDACTED]'));
  });
  for (const event of ['SIGTERM', 'SIGINT']) process.once(event, () => child.kill(event));
  process.exitCode = await new Promise((accept, reject) => {
    child.once('error', () => reject(new ProviderError('Could not start the Amp provider')));
    child.once('exit', code => accept(code ?? 1));
  });
} catch (error) {
  console.error(error instanceof ProviderError ? error.message : 'Provider setup failed. Check tool installation, local state, and network access.');
  process.exitCode = 1;
} finally { status('stopped'); await statusWrites; if (lock) await rm(lock, { force: true }); }
