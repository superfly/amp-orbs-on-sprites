import test from 'node:test';
import assert from 'node:assert/strict';
import { cliFetch } from '../src/cli-api.mjs';
import { SpritesAPI } from '../src/api.mjs';

test('saved-login transport uses stdin for secrets and isolates child credentials', async () => {
  const transport = cliFetch({ org: 'alex-ezell', spriteBin: 'sprite' }, (binary, args, options, callback) => {
    assert.equal(binary, 'sprite');
    assert.deepEqual(args.slice(0, 4), ['-o', 'alex-ezell', 'api', '/v1/sprites/test/services/bootstrap']);
    assert.ok(args.includes('@-'));
    assert.ok(args.every(v => !v.includes('orb-secret')));
    assert.equal(options.env.AMP_ORB_PROVIDER_TOKEN, undefined);
    assert.equal(options.env.SPRITE_TOKEN, undefined);
    return { stdin: { on() {}, end(input) {
      assert.equal(JSON.parse(input).env.ORB_TOKEN, 'orb-secret');
      callback(null, '{"state":{"status":"running"}}\n__FLY_AMP_HTTP__200 application/json');
    } } };
  });
  const api = new SpritesAPI('', new AbortController().signal, transport);
  assert.equal((await api.request('PUT', '/sprites/test/services/bootstrap', { env: { ORB_TOKEN: 'orb-secret' } })).state.status, 'running');
});

test('saved-login transport preserves 404 and 204 semantics', async () => {
  for (const status of [404, 204]) {
    const transport = cliFetch({ org: 'test', spriteBin: 'sprite' }, (_, args, options, callback) => ({
      stdin: { on() {}, end() { callback(null, `\n__FLY_AMP_HTTP__${status} `); } },
    }));
    const api = new SpritesAPI('', new AbortController().signal, transport);
    assert.deepEqual(await api.request('DELETE', '/sprites/test', undefined, { missing: true }), status === 404 ? null : {});
  }
});

test('CLI failures suppress raw output', async () => {
  const transport = cliFetch({ org: 'test', spriteBin: 'sprite' }, (_, args, options, callback) => ({
    stdin: { on() {}, end() { callback(new Error('secret-token'), 'secret-token'); } },
  }));
  await assert.rejects(transport('https://api.sprites.dev/v1/sprites', { method: 'GET' }), e => !e.message.includes('secret-token'));
});
