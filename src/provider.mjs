import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { ProviderError } from './api.mjs';

const SERVICE = 'amp-orb-bootstrap';
const hash = value => createHash('sha256').update(value).digest('hex');
const required = (env, key) => {
  if (!env[key]?.trim()) throw new ProviderError(`Missing ${key}`);
  return env[key];
};

export function configuration(env) {
  const operation = required(env, 'ORB_OPERATION');
  if (!['spawn', 'pause', 'delete'].includes(operation)) throw new ProviderError('Unsupported ORB_OPERATION');
  const orbId = required(env, 'ORB_ID');
  if (orbId.length > 512 || /[\x00-\x1f\x7f]/.test(orbId)) throw new ProviderError('Invalid ORB_ID');
  const provider = required(env, 'SPRITES_PROVIDER_ID');
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(provider)) throw new ProviderError('Invalid SPRITES_PROVIDER_ID');
  const config = {
    operation, orbId, provider,
    name: `${provider}-${hash(orbId).slice(0, 32)}`,
    org: required(env, 'SPRITE_ORG'), token: env.SPRITE_TOKEN || undefined,
    stateDir: resolve(required(env, 'SPRITES_STATE_DIR')),
    spriteBin: env.SPRITE_BIN || 'sprite',
    snapshot: Boolean(env.ORB_SNAPSHOT_ID),
  };
  if (operation === 'spawn') {
    if (env.SPRITES_NATIVE_BASE !== '1') throw new ProviderError('Set SPRITES_NATIVE_BASE=1 to acknowledge the native Sprite base instead of ORB_IMAGE');
    if (env.ORB_TYPE && env.ORB_TYPE !== 'native') throw new ProviderError('Unsupported ORB_TYPE; configure no types or only native');
    config.orbToken = required(env, 'ORB_TOKEN');
    config.ampUrl = env.AMP_URL || 'https://ampcode.com';
    config.binaryUrl = required(env, 'SPRITES_AMP_BINARY_URL');
    config.binarySha = required(env, 'SPRITES_AMP_BINARY_SHA256').toLowerCase();
    for (const value of [config.ampUrl, config.binaryUrl]) {
      let url;
      try { url = new URL(value); } catch { throw new ProviderError('Invalid Amp URL'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new ProviderError('Amp URLs must use HTTPS without credentials, query, or fragment');
    }
    if (!/^[a-f0-9]{64}$/.test(config.binarySha)) throw new ProviderError('SPRITES_AMP_BINARY_SHA256 must be a SHA-256 digest');
  }
  return config;
}

// Amp currently uses amp-<thread ID>. Unknown formats are not eligible for retirement.
function threadForOrb(orbId) {
  const match = /^amp-(?:T-)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.exec(orbId);
  return match ? `T-${match[1]}` : null;
}

export function retirementConfiguration(env, request) {
  if (env.SPRITES_ALLOW_WORKER_RETIREMENT !== '1') throw new ProviderError('Worker retirement is disabled');
  const identity = request?.identity;
  if (request?.version !== 1 || !/^[0-9a-f-]{36}$/.test(request.id || '') ||
      !/^T-[0-9a-f-]{36}$/.test(request.owner || '') || request.owner === request.worker ||
      !['reviewer', 'security'].includes(request.role) ||
      !/^[0-9a-f]{64}$/.test(request.receiptHash || '') ||
      typeof identity?.orbId !== 'string' || threadForOrb(identity.orbId) !== request.worker ||
      identity.threadID !== request.worker || !/^[0-9a-f-]{36}$/.test(identity.generation || '') ||
      typeof identity.spriteId !== 'string' || !identity.spriteId)
    throw new ProviderError('Invalid worker retirement identity or receipt binding');
  const config = configuration({ ...env, ORB_OPERATION: 'pause', ORB_ID: identity.orbId });
  if (identity.provider !== config.provider || identity.org !== config.org || identity.name !== config.name)
    throw new ProviderError('Retirement targets a different provider or organization');
  return { ...config, operation: 'retire', retirement: request };
}

async function readRecord(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw new ProviderError('Cannot read provider state'); }
}
async function saveRecord(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
  await rename(temporary, path);
}

export async function prepareSprite(config, signal) {
  const prepareScript = await readFile(new URL('../bootstrap/prepare.sh', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../bootstrap/run.sh', import.meta.url), 'utf8');
  const identity = Buffer.from(JSON.stringify(config.identity ?? null)).toString('base64');
  const script = `${prepareScript}\nrunner_tmp=$(mktemp)\ncat >"$runner_tmp" <<'AMP_SPRITES_RUNNER'\n${runner}\nAMP_SPRITES_RUNNER\ninstall -m 0755 "$runner_tmp" /usr/local/bin/amp-orb-bootstrap\nprintf '%s' '${identity}' | base64 -d >"$runner_tmp"\ninstall -m 0644 "$runner_tmp" /etc/amp-orb-identity.json\nrm -f "$runner_tmp"\n`;
  await new Promise((accept, reject) => {
    // In particular do not inherit AMP_ORB_PROVIDER_TOKEN or ORB_TOKEN.
    const child = spawn(config.spriteBin, [
      '-o', config.org, '-s', config.name, 'exec', '--no-port-forward', '--',
      'sudo', '-n', 'timeout', '--kill-after=5s', '220s', 'bash', '-se', '--', config.binaryUrl, config.binarySha,
    ], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SPRITE_TOKEN: config.token },
      stdio: ['pipe', 'ignore', 'ignore'], signal, killSignal: 'SIGKILL',
    });
    child.once('error', () => reject(new ProviderError('Cannot execute Sprite preparation')));
    child.once('close', code => code === 0 ? accept() : reject(new ProviderError('Sprite preparation failed; check bootstrap prerequisites and binary checksum')));
    child.stdin.on('error', () => {});
    child.stdin.end(script);
  });
}

export async function releaseSpriteHold(config, signal) {
  await new Promise((accept, reject) => {
    const child = spawn(config.spriteBin, [
      '-o', config.org, '-s', config.name, 'exec', '--no-port-forward', '--',
      'sudo', '-n', '-H', '-u', 'user', '/.sprite/bin/sprite-env', 'keep-awake', '--release',
    ], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, SPRITE_TOKEN: config.token },
      stdio: 'ignore', signal, timeout: 15_000, killSignal: 'SIGKILL',
    });
    child.once('error', () => reject(new ProviderError('Cannot release Sprite activity hold')));
    child.once('close', code => code === 0 ? accept() : reject(new ProviderError('Sprite activity hold release failed; retry pause')));
  });
}

export async function dispatch(config, api, {
  signal, prepare = prepareSprite, release = releaseSpriteHold, sleep = ms => delay(ms, undefined, { signal }), log = console.log,
} = {}) {
  const c = config;
  const root = join(c.stateDir, c.provider);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, `${c.name}.lock`);
  try { await mkdir(lock); }
  catch (e) {
    if (e.code === 'EEXIST') throw new ProviderError('Orb is locked; retry after the other job or recover a stale lock');
    throw e;
  }
  try {
    const recordPath = join(root, `${c.name}.json`);
    let record = await readRecord(recordPath);
    const path = `/sprites/${c.name}`;
    let sprite = await api.request('GET', path, undefined, { missing: true });
    if (record && (record.orbId !== c.orbId || record.org !== c.org)) throw new ProviderError('Provider state identity mismatch');
    if (sprite && (!record || record.id !== sprite.id || sprite.organization !== c.org)) {
      throw new ProviderError('Sprite ownership is unverified; inspect state before adopting or deleting');
    }
    if (c.operation === 'retire') {
      const request = c.retirement;
      if (!record || record.id !== request.identity.spriteId || record.generation !== request.identity.generation)
        throw new ProviderError('Worker incarnation changed or is unknown; retirement refused');
      const fingerprint = hash(JSON.stringify(request));
      if (record.retirement && record.retirement.fingerprint !== fingerprint)
        throw new ProviderError('Conflicting retirement request');
      if (record.retirement?.status === 'done') {
        if (sprite) throw new ProviderError('Retired Sprite reappeared; inspect ownership');
        return { status: 'retired', id: request.id, identity: request.identity, receiptHash: request.receiptHash };
      }
      if (!record.paused) return { status: 'waiting_for_pause', id: request.id };
      // No wake-inducing exec. A resume shares this lock and rotates generation.
      if (sprite) {
        const service = await api.request('GET', `${path}/services/${SERVICE}`, undefined, { missing: true });
        if (service && (service.data?.desired_state !== 'stopped' ||
            !(service.data.runtime?.status === 'stopped' || service.data.runtime?.running === false)))
          throw new ProviderError('Worker bootstrap is not stopped; retirement refused');
        if (record.retirement) throw new ProviderError('Retirement outcome uncertain; Sprite still exists. Inspect before retrying deletion');
        record.retirement = { fingerprint, status: 'pending' };
        await saveRecord(recordPath, record);
        await api.request('DELETE', path, undefined, { missing: true });
        let absent = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          const remaining = await api.request('GET', path, undefined, { missing: true });
          if (!remaining) { absent = true; break; }
          if (remaining.id !== record.id) throw new ProviderError('Sprite identity changed during retirement');
          await sleep(1000);
        }
        if (!absent) throw new ProviderError('Retirement not yet confirmed; ownership retained');
      }
      // Keep a tombstone until a later spawn establishes a new incarnation.
      record.retirement = { fingerprint, status: 'done' };
      await saveRecord(recordPath, record);
      return { status: 'retired', id: request.id, identity: request.identity, receiptHash: request.receiptHash };
    }
    if (c.snapshot) log('Project snapshots are unsupported; new Orbs run normal setup.');
    if (c.operation === 'delete') {
      if (sprite) {
        await api.request('DELETE', path, undefined, { missing: true });
        let absent = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          const remaining = await api.request('GET', path, undefined, { missing: true });
          if (!remaining) { absent = true; break; }
          if (remaining.id !== record.id) throw new ProviderError('Sprite identity changed during deletion; ownership record retained');
          await sleep(1000);
        }
        if (!absent) throw new ProviderError('Sprite deletion not yet confirmed; ownership record retained');
      }
      await rm(recordPath, { force: true });
      log(`Deleted ${c.name} (or already absent).`);
      return;
    }
    if (c.operation === 'pause') {
      if (sprite && !record.paused) {
        await stopBootstrap(api, path, sleep);
        // Sprites 2 may terminate the service group before its shell trap completes.
        await release(c, signal);
        await saveRecord(recordPath, { ...record, paused: true });
      }
      // No suspend call, wake-inducing poll, checkpoint, or disk deletion.
      log(`Released ${c.name} for automatic idle sleep; other workload activity may keep it awake.`);
      return;
    }
    if (sprite && record?.retirement) throw new ProviderError('Retirement is unresolved; confirm deletion before resuming this Orb');
    if (!sprite) {
      sprite = await api.request('POST', '/sprites', { name: c.name, url_settings: { auth: 'sprite' } });
      if (Array.isArray(sprite)) sprite = sprite.find(event => event.type === 'sprite');
      if (sprite?.data?.id) sprite = sprite.data;
      if (!sprite?.id || sprite.organization !== c.org || sprite.name !== c.name) throw new ProviderError('Unexpected Sprite creation identity; inspect before retrying');
      record = { orbId: c.orbId, org: c.org, id: sprite.id };
      // Record ownership before preparation so a failed bootstrap can be retried.
      await saveRecord(recordPath, record);
    }
    if (sprite.runtime_kind !== 'flyfs') throw new ProviderError('This provider requires the Sprites 2 runtime (flyfs)');
    record = { ...record, paused: false, generation: randomUUID() };
    delete record.retirement;
    await saveRecord(recordPath, record);
    await stopBootstrap(api, path, sleep);
    await prepare({ ...c, identity: { provider: c.provider, org: c.org, orbId: c.orbId, name: c.name,
      spriteId: record.id, generation: record.generation, threadID: threadForOrb(c.orbId) } }, signal);
    const definition = {
      cmd: '/usr/bin/sudo',
      args: ['-n', '-H', '-u', 'user', '--preserve-env=ORB_TOKEN,AMP_URL', '--', '/usr/local/bin/amp-orb-bootstrap'],
      dir: '/home/user', needs: [],
      env: { ORB_TOKEN: c.orbToken, AMP_URL: c.ampUrl },
    };
    const body = {
      process: { argv: [definition.cmd, ...definition.args], cwd: definition.dir, env: definition.env },
      needs: [], restart: 'always', desired_state: 'running',
    };
    await api.request('PUT', `${path}/services/${SERVICE}`, body);
    await waitService(api, path, new Set(['running']), sleep);
    log(`Started ${c.name}; bootstrap is running (Amp connection still needs end-to-end verification).`);
  } finally { await rm(lock, { recursive: true, force: true }); }
}

async function stopBootstrap(api, path, sleep) {
  const service = await api.request('GET', `${path}/services/${SERVICE}`, undefined, { missing: true });
  if (!service) return;
  if (!service.data?.process) throw new ProviderError('Expected Sprites 2 service schema');
  // Persist desired state: a runtime-only stop can restart after a cold boot.
  const { runtime, ...definition } = service.data;
  const retainedEnv = Object.keys(definition.process.env || {}).length > 0;
  if (definition.desired_state === 'stopped' && runtime?.status === 'stopped' && !retainedEnv) return;
  // Drop the Orb token from the stored definition so it does not persist on a
  // paused Sprite; spawn always supplies a fresh definition and token.
  await api.request('PUT', `${path}/services/${SERVICE}`, { ...definition, process: { ...definition.process, env: {} }, desired_state: 'stopped' });
  await waitService(api, path, new Set(['stopped']), sleep);
}
async function waitService(api, path, desired, sleep) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const service = await api.request('GET', `${path}/services/${SERVICE}`, undefined, { missing: true });
    if (desired.has(service?.data?.runtime?.status)) return;
    if (desired.has('stopped') && service?.data?.desired_state === 'stopped' && service.data.runtime?.running === false) return;
    await sleep(1000);
  }
  throw new ProviderError('Bootstrap service did not reach the required state');
}
