import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration, retirementConfiguration, dispatch } from '../src/provider.mjs';

function environment(dir, extra = {}) {
  return {
    ORB_OPERATION: 'spawn', ORB_ID: 'amp-thread-123', ORB_TOKEN: 'orb-secret',
    SPRITE_TOKEN: 'sprite-secret', SPRITE_ORG: 'example', SPRITES_PROVIDER_ID: 'test',
    SPRITES_STATE_DIR: dir, SPRITES_NATIVE_BASE: '1',
    SPRITES_AMP_BINARY_URL: 'https://example.com/amp', SPRITES_AMP_BINARY_SHA256: 'a'.repeat(64), ...extra,
  };
}
class FakeAPI {
  modern = true;
  sprite = null;
  service = null;
  calls = [];
  async request(method, path, body) {
    this.calls.push({ method, path, body });
    if (path === '/sprites' && method === 'POST') {
      return this.sprite = { name: body.name, id: 'sprite-1', organization: 'example', status: 'running', ...(this.modern ? { runtime_kind: 'flyfs' } : {}) };
    }
    if (path.endsWith('/stop')) { this.service.state.status = 'stopped'; return [{ type: 'complete' }]; }
    if (path.includes('/services/')) {
      if (method === 'GET') {
        if (!this.modern || !this.service) return this.service;
        const { state, ...definition } = this.service;
        return { data: { ...definition, runtime: state } };
      }
      this.service = { ...body, state: { status: body.desired_state === 'stopped' ? 'stopped' : 'running' } };
      return this.service;
    }
    if (method === 'DELETE') { this.sprite = null; this.service = null; return {}; }
    return this.sprite;
  }
}
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-sprites-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const api = new FakeAPI();
  const logs = [];
  let preparations = 0;
  const options = { release: async () => {}, prepare: async () => { preparations++; }, sleep: async () => {}, log: s => logs.push(s) };
  return { dir, api, logs, options, get preparations() { return preparations; },
    run: extra => dispatch(configuration(environment(dir, extra)), api, options) };
}

test('spawn reuses one Sprite and replaces bootstrap with a fresh token', async t => {
  const f = await fixture(t);
  await f.run();
  await f.run({ ORB_TOKEN: 'new-secret', AMP_URL: 'https://amp.example.com' });
  assert.equal(f.api.calls.filter(c => c.method === 'POST' && c.path === '/sprites').length, 1);
  assert.equal(f.api.calls.filter(c => c.method === 'PUT' && c.body?.desired_state === 'stopped').length, 1);
  assert.deepEqual(f.api.service.process.env, { ORB_TOKEN: 'new-secret', AMP_URL: 'https://amp.example.com' });
  assert.equal(f.api.service.process.argv[0], '/usr/bin/sudo');
  assert.ok(f.api.service.process.argv.includes('user'));
  assert.equal(f.api.service.http_port, undefined);
  assert.equal(f.api.calls.find(c => c.path === '/sprites').body.url_settings.auth, 'sprite');
  assert.ok(f.logs.every(s => !s.includes('secret')));
  const files = await readdir(join(f.dir, 'test'));
  const saved = await readFile(join(f.dir, 'test', files[0]), 'utf8');
  assert.ok(!saved.includes('secret'));
});

test('pause stops bootstrap once, retains disk, and lets Sprites idle', async t => {
  const f = await fixture(t);
  await f.run();
  const sprite = f.api.sprite;
  await f.run({ ORB_OPERATION: 'pause', ORB_TOKEN: '' });
  await f.run({ ORB_OPERATION: 'pause', ORB_TOKEN: '' });
  assert.equal(f.api.sprite, sprite);
  assert.equal(f.api.service.state.status, 'stopped');
  assert.equal(f.api.calls.filter(c => c.method === 'PUT' && c.body?.desired_state === 'stopped').length, 1);
  assert.ok(f.api.calls.every(c => !c.path.includes('suspend') && c.method !== 'DELETE'));
  assert.ok(f.logs.some(s => s.includes('other workload activity')));
  await f.run({ ORB_TOKEN: 'resumed-secret' });
  assert.equal(f.api.sprite, sprite);
  assert.equal(f.api.service.process.env.ORB_TOKEN, 'resumed-secret');
});

test('pause of a sleeping Sprite still disables an existing bootstrap service', async t => {
  const f = await fixture(t);
  await f.run();
  f.api.sprite.status = 'cold';
  await f.run({ ORB_OPERATION: 'pause' });
  assert.equal(f.api.service.state.status, 'stopped');
});

test('repeat delete is harmless and removes the ownership record', async t => {
  const f = await fixture(t);
  await f.run();
  await f.run({ ORB_OPERATION: 'delete' });
  await f.run({ ORB_OPERATION: 'delete' });
  assert.equal(f.api.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.deepEqual(await readdir(join(f.dir, 'test')), []);
});

test('unconfirmed deletion retains ownership for retry', async t => {
  const f = await fixture(t);
  await f.run();
  const request = f.api.request.bind(f.api);
  f.api.request = async (...args) => args[0] === 'DELETE' ? {} : request(...args);
  await assert.rejects(f.run({ ORB_OPERATION: 'delete' }), /not yet confirmed/);
  assert.ok((await readdir(join(f.dir, 'test'))).some(name => name.endsWith('.json')));
});

test('failed bootstrap is explicitly stopped before marking paused', async t => {
  const f = await fixture(t);
  await f.run();
  f.api.service.state.status = 'failed';
  await f.run({ ORB_OPERATION: 'pause' });
  assert.equal(f.api.service.state.status, 'stopped');
  assert.equal(f.api.calls.filter(c => c.method === 'PUT' && c.body?.desired_state === 'stopped').length, 1);
});

test('pause/delete of an absent Sprite do not create resources', async t => {
  const f = await fixture(t);
  await f.run({ ORB_OPERATION: 'pause' });
  await f.run({ ORB_OPERATION: 'delete' });
  assert.ok(f.api.calls.every(c => c.method === 'GET'));
});

test('bootstrap failure preserves the new Sprite for retry', async t => {
  const f = await fixture(t);
  const prepare = f.options.prepare;
  f.options.prepare = async () => { throw new Error('fixture failure'); };
  await assert.rejects(f.run(), /fixture failure/);
  assert.ok(f.api.sprite);
  f.options.prepare = prepare;
  await f.run();
  assert.equal(f.api.calls.filter(c => c.path === '/sprites').length, 1);
});

test('untracked Sprite collision is never adopted or deleted', async t => {
  const f = await fixture(t);
  f.api.sprite = { id: 'someone-elses', organization: 'example' };
  for (const operation of ['spawn', 'pause', 'delete']) {
    await assert.rejects(f.run({ ORB_OPERATION: operation }), /ownership is unverified/);
  }
  assert.ok(f.api.calls.every(c => c.method === 'GET'));
});

test('a recreated name or wrong organization cannot be deleted', async t => {
  const f = await fixture(t);
  await f.run();
  f.api.sprite.id = 'replacement';
  await assert.rejects(f.run({ ORB_OPERATION: 'delete' }), /ownership is unverified/);
  f.api.sprite.id = 'sprite-1';
  f.api.sprite.organization = 'other';
  await assert.rejects(f.run({ ORB_OPERATION: 'delete' }), /ownership is unverified/);
  assert.ok(f.api.calls.every(c => c.method !== 'DELETE'));
});

test('lost create response refuses automatic adoption on retry', async t => {
  const f = await fixture(t);
  const request = f.api.request.bind(f.api);
  f.api.request = async (...args) => {
    const value = await request(...args);
    if (args[1] === '/sprites') throw new Error('connection lost');
    return value;
  };
  await assert.rejects(f.run(), /connection lost/);
  await assert.rejects(f.run(), /ownership is unverified/);
});

test('project snapshot limitation is visible and no checkpoint restore occurs', async t => {
  const f = await fixture(t);
  await f.run({ ORB_SNAPSHOT_ID: 'snapshot-1' });
  assert.ok(f.logs.some(s => s.includes('snapshots are unsupported')));
  assert.ok(f.api.calls.every(c => !c.path.includes('checkpoint')));
});

test('service never running fails spawn rather than claiming success', async t => {
  const f = await fixture(t);
  const request = f.api.request.bind(f.api);
  f.api.request = async (...args) => {
    const result = await request(...args);
    if (result?.data?.runtime) result.data.runtime.status = 'starting';
    return result;
  };
  await assert.rejects(f.run(), /did not reach/);
  assert.ok(!f.logs.some(s => s.startsWith('Started')));
});

test('per-Orb lock rejects overlapping jobs without touching the API', async t => {
  const f = await fixture(t);
  const c = configuration(environment(f.dir));
  await mkdir(join(f.dir, 'test', `${c.name}.lock`), { recursive: true });
  await assert.rejects(f.run(), /locked/);
  assert.equal(f.api.calls.length, 0);
});

test('names are deterministic and cannot contain shell or path syntax', () => {
  const env = environment('/tmp/state', { ORB_ID: '../../x; $(touch pwned)' });
  const first = configuration(env);
  assert.match(first.name, /^test-[a-f0-9]{32}$/);
  assert.equal(first.name, configuration(env).name);
  assert.notEqual(first.name, configuration({ ...env, ORB_ID: 'other' }).name);
});

test('invalid configuration fails before any resources are touched', () => {
  for (const override of [
    { ORB_OPERATION: 'destroy-all' }, { ORB_TOKEN: '' }, { SPRITE_ORG: '' },
    { SPRITES_PROVIDER_ID: '../bad' }, { SPRITES_NATIVE_BASE: '' }, { ORB_TYPE: 'gpu' },
    { SPRITES_AMP_BINARY_SHA256: 'bad' }, { SPRITES_AMP_BINARY_URL: 'http://example.com/amp' },
    { AMP_URL: 'https://name:secret@example.com' }, { SPRITES_AMP_BINARY_URL: 'https://example.com/?token=secret' },
  ]) assert.throws(() => configuration(environment('/tmp/state', override)));
});

test('current runtime uses process argv and persists stopped state across pause/resume', async t => {
  const f = await fixture(t);
  f.api.modern = true;
  await f.run();
  assert.equal(f.api.service.process.argv[0], '/usr/bin/sudo');
  assert.equal(f.api.service.process.env.ORB_TOKEN, 'orb-secret');
  await f.run({ ORB_OPERATION: 'pause' });
  assert.equal(f.api.service.desired_state, 'stopped');
  assert.equal(f.api.service.state.status, 'stopped');
  assert.equal(f.api.calls.filter(c => c.path.endsWith('/stop')).length, 0);
  await f.run({ ORB_TOKEN: 'fresh-token' });
  assert.equal(f.api.service.desired_state, 'running');
  assert.equal(f.api.service.process.env.ORB_TOKEN, 'fresh-token');
});

test('rejects the default runtime while retaining ownership for cleanup', async t => {
  const f = await fixture(t);
  f.api.modern = false;
  await assert.rejects(f.run(), /requires the Sprites 2 runtime/);
  assert.equal(f.preparations, 0);
  await f.run({ ORB_OPERATION: 'delete' });
  assert.equal(f.api.sprite, null);
});

test('pause accepts persisted stopped state when Sprites 2 is already asleep', async t => {
  const f = await fixture(t);
  await f.run();
  const request = f.api.request.bind(f.api);
  f.api.request = async (...args) => {
    const result = await request(...args);
    if (result?.data?.desired_state === 'stopped') result.data.runtime = { error: 'vm_not_running', running: false };
    return result;
  };
  await f.run({ ORB_OPERATION: 'pause' });
  assert.equal(f.api.service.desired_state, 'stopped');
});

test('pause remains retryable until explicit hold release succeeds', async t => {
  const f = await fixture(t);
  await f.run();
  f.options.release = async () => { throw new Error('release failed'); };
  await assert.rejects(f.run({ ORB_OPERATION: 'pause' }), /release failed/);
  const c = configuration(environment(f.dir));
  const record = JSON.parse(await readFile(join(f.dir, 'test', `${c.name}.json`)));
  assert.equal(record.paused, false);
  let releases = 0;
  f.options.release = async () => { releases++; };
  await f.run({ ORB_OPERATION: 'pause' });
  await f.run({ ORB_OPERATION: 'pause' });
  assert.equal(releases, 1);
});

test('pause clears the Orb token from the stored service definition', async t => {
  const f = await fixture(t);
  await f.run();
  assert.equal(f.api.service.process.env.ORB_TOKEN, 'orb-secret');
  await f.run({ ORB_OPERATION: 'pause', ORB_TOKEN: '' });
  assert.equal(f.api.service.desired_state, 'stopped');
  assert.deepEqual(f.api.service.process.env, {});
  assert.deepEqual(f.api.service.process.argv.slice(0, 1), ['/usr/bin/sudo']);
  const stopped = f.api.calls.filter(c => c.method === 'PUT' && c.body?.desired_state === 'stopped');
  assert.equal(stopped.length, 1);
  assert.deepEqual(stopped[0].body.process.env, {});
  assert.ok(!JSON.stringify(stopped).includes('orb-secret'));
});

test('a service already stopped with a retained token is rewritten without it', async t => {
  const f = await fixture(t);
  await f.run();
  f.api.service.desired_state = 'stopped';
  f.api.service.state.status = 'stopped';
  await f.run({ ORB_OPERATION: 'pause' });
  assert.deepEqual(f.api.service.process.env, {});
  assert.equal(f.api.calls.filter(c => c.method === 'PUT' && c.body?.desired_state === 'stopped').length, 1);
  await f.run({ ORB_OPERATION: 'pause' });
  assert.equal(f.api.calls.filter(c => c.method === 'PUT' && c.body?.desired_state === 'stopped').length, 1);
});

async function retirementFixture(t) {
  const f = await fixture(t);
  const worker = 'T-11111111-2222-4333-8444-555555555555';
  const env = environment(f.dir, { ORB_ID: `amp-${worker}`, SPRITES_ALLOW_WORKER_RETIREMENT: '1' });
  let identity;
  f.options.prepare = async c => { identity = c.identity; };
  const run = extra => dispatch(configuration({ ...env, ...extra }), f.api, f.options);
  await run();
  const request = { version: 1, id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    owner: 'T-99999999-8888-4777-8666-555555555555', worker, role: 'reviewer', identity, receiptHash: 'b'.repeat(64) };
  return { ...f, env, request, run, retire: (r = request) => dispatch(retirementConfiguration(env, r), f.api, f.options) };
}

test('retirement is opt-in, worker-bound, paused-only, and repeatable without a second DELETE', async t => {
  const f = await retirementFixture(t);
  assert.throws(() => retirementConfiguration({ ...f.env, SPRITES_ALLOW_WORKER_RETIREMENT: '' }, f.request), /disabled/);
  for (const patch of [ { role: 'author' }, { owner: f.request.worker }, { worker: f.request.owner },
    { identity: { ...f.request.identity, org: 'other' } },
    { identity: { ...f.request.identity, name: 'unrelated' } },
    { identity: { ...f.request.identity, orbId: 'unknown-convention' } } ]) {
    assert.throws(() => retirementConfiguration(f.env, { ...f.request, ...patch }));
  }
  assert.equal((await f.retire()).status, 'waiting_for_pause');
  assert.ok(f.api.calls.every(c => c.method !== 'DELETE'));
  await f.run({ ORB_OPERATION: 'pause' });
  const result = await f.retire();
  assert.equal(result.status, 'retired');
  assert.deepEqual(result.identity, f.request.identity);
  assert.equal(f.api.sprite, null);
  assert.deepEqual(await f.retire(), result);
  assert.equal(f.api.calls.filter(c => c.method === 'DELETE').length, 1);
  await assert.rejects(f.retire({ ...f.request, receiptHash: 'c'.repeat(64) }), /Conflicting/);
});

test('retirement shares lifecycle locks and cannot delete a resumed or recreated worker', async t => {
  const f = await retirementFixture(t);
  await f.run({ ORB_OPERATION: 'pause' });
  const lock = join(f.dir, 'test', `${f.request.identity.name}.lock`);
  await mkdir(lock);
  await assert.rejects(f.retire(), /locked/);
  await rm(lock, { recursive: true });
  await f.run(); // Same Sprite, new incarnation invalidates the old retirement request.
  await f.run({ ORB_OPERATION: 'pause' });
  await assert.rejects(f.retire(), /incarnation changed/);
  f.api.sprite.id = 'replacement';
  await assert.rejects(f.retire(), /ownership is unverified/);
  assert.ok(f.api.calls.every(c => c.method !== 'DELETE'));
});

test('reopening after retirement creates fresh compute and old requests cannot delete it', async t => {
  const f = await retirementFixture(t);
  await f.run({ ORB_OPERATION: 'pause' });
  await f.retire();
  await f.run();
  await f.run({ ORB_OPERATION: 'pause' });
  // The fake reuses its Sprite ID deliberately; generation must still protect it.
  await assert.rejects(f.retire(), /incarnation changed/);
  assert.ok(f.api.sprite);
  assert.equal(f.api.calls.filter(c => c.method === 'DELETE').length, 1);
  assert.equal(f.api.calls.filter(c => c.method === 'POST').length, 2);
});

test('ambiguous retirement retains ownership and reconciles absence without repeating deletion', async t => {
  const f = await retirementFixture(t);
  await f.run({ ORB_OPERATION: 'pause' });
  const request = f.api.request.bind(f.api);
  f.api.request = async (...args) => {
    const result = await request(...args);
    if (args[0] === 'DELETE') throw new Error('lost response');
    return result;
  };
  await assert.rejects(f.retire(), /lost response/);
  assert.equal((await f.retire()).status, 'retired');
  assert.equal(f.api.calls.filter(c => c.method === 'DELETE').length, 1);
});

test('unconfirmed retirement never repeats DELETE or resumes a worker being deleted', async t => {
  const f = await retirementFixture(t);
  await f.run({ ORB_OPERATION: 'pause' });
  const request = f.api.request.bind(f.api);
  let deletes = 0;
  f.api.request = async (...args) => {
    if (args[0] === 'DELETE') { deletes++; return {}; }
    return request(...args);
  };
  await assert.rejects(f.retire(), /not yet confirmed/);
  await assert.rejects(f.retire(), /outcome uncertain/);
  await assert.rejects(f.run(), /Retirement is unresolved/);
  assert.equal(deletes, 1);
  f.api.sprite = null;
  assert.equal((await f.retire()).status, 'retired');
});

test('retirement refuses a running bootstrap even when the ownership record says paused', async t => {
  const f = await retirementFixture(t);
  await f.run({ ORB_OPERATION: 'pause' });
  f.api.service.desired_state = 'running';
  await assert.rejects(f.retire(), /bootstrap is not stopped/);
  assert.ok(f.api.calls.every(c => c.method !== 'DELETE'));
});
