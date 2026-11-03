import test from 'node:test';
import assert from 'node:assert/strict';
import { SpritesAPI, ApiError } from '../src/api.mjs';

function api(response) {
  return new SpritesAPI('secret', new AbortController().signal, async () => response);
}
test('auth uses headers and mutations reject redirects', async () => {
  const client = new SpritesAPI('test-token', new AbortController().signal, async (url, options) => {
    assert.equal(url, 'https://api.sprites.dev/v1/sprites');
    assert.equal(options.headers.Authorization, 'Bearer test-token');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), { name: 'test' });
    return Response.json({ id: 'id' }, { status: 201 });
  });
  assert.deepEqual(await client.request('POST', '/sprites', { name: 'test' }), { id: 'id' });
});
test('404 is absent only when explicitly allowed', async () => {
  assert.equal(await api(new Response('secret', { status: 404 })).request('GET', '/x', undefined, { missing: true }), null);
  await assert.rejects(api(new Response('secret', { status: 404 })).request('GET', '/x'), ApiError);
});
test('401 and API body secrets are never exposed', async () => {
  await assert.rejects(api(new Response('private-token', { status: 401 })).request('GET', '/x'), e => {
    assert.equal(e.status, 401);
    return !e.message.includes('private-token');
  });
});
test('service NDJSON must complete successfully', async () => {
  const headers = { 'content-type': 'application/x-ndjson' };
  const success = '{"type":"started"}\n{"type":"complete"}\n';
  assert.equal((await api(new Response(success, { headers })).request('PUT', '/x')).length, 2);
  for (const body of ['{"type":"started"}\n', '{"type":"error","message":"secret"}\n{"type":"complete"}\n', 'broken']) {
    await assert.rejects(api(new Response(body, { headers })).request('PUT', '/x'), /invalid or failed/);
  }
});
test('stream parsing tolerates arbitrary transport chunk boundaries', async () => {
  const bytes = new TextEncoder().encode('{"type":"stdout","data":"☃"}\n{"type":"complete"}\n');
  const stream = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  const result = await api(new Response(stream, { headers: { 'content-type': 'application/x-ndjson' } })).request('POST', '/x');
  assert.equal(result[0].data, '☃');
});
test('empty non-delete and oversized responses fail closed', async () => {
  await assert.rejects(api(new Response('')).request('PUT', '/x'), /empty/);
  assert.deepEqual(await api(new Response(null, { status: 204 })).request('DELETE', '/x'), {});
  await assert.rejects(api(new Response('x'.repeat(1024 * 1024 + 1))).request('GET', '/x'), /too large/);
});
test('network errors are sanitized and never retried blindly', async () => {
  let attempts = 0;
  const client = new SpritesAPI('secret', new AbortController().signal, async () => {
    attempts++; throw new Error('https://secret@example.com');
  });
  await assert.rejects(client.request('POST', '/sprites'), e => !e.message.includes('secret'));
  assert.equal(attempts, 1);
});

test('current runtime accepts final sprite/service confirmations but rejects arbitrary events', async () => {
  const headers = { 'content-type': 'application/x-ndjson' };
  for (const event of [
    { type: 'sprite', services: { bootstrap: { desired_state: 'running' } } },
    { type: 'service', name: 'bootstrap', action: 'stop', result: { status: 'stopped' } },
  ]) {
    assert.deepEqual(await api(new Response(JSON.stringify(event)+'\n', { headers })).request('PUT','/x'), [event]);
  }
  for (const event of [{ type: 'sprite' }, { type: 'service', name: 'bootstrap' }, { type: 'info' }]) {
    await assert.rejects(api(new Response(JSON.stringify(event)+'\n', { headers })).request('PUT','/x'));
  }
});
