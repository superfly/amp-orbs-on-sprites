import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ensureAmp } from '../src/install-amp.mjs';

test('installer verifies official checksums, caches the binary, and detects tampering', async t => {
  const directory=await mkdtemp(join(tmpdir(),'amp-install-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const bytes=Buffer.from('test binary');
  const digest=createHash('sha256').update(bytes).digest('hex');
  let calls=0;
  const fetchImpl=async url=>{
    calls++;
    assert.ok(url.startsWith('https://static.ampcode.com/cli/'));
    if(url.endsWith('cli-version.txt')) return new Response('test-version');
    if(url.endsWith('.sha256')) return new Response(digest);
    return new Response(gzipSync(bytes));
  };
  const options={fetchImpl,platform:'darwin',arch:'arm64',log:()=>{}};
  const result=await ensureAmp(directory,options);
  assert.deepEqual(await readFile(result.binary),bytes);
  assert.equal(result.linux.url,'https://static.ampcode.com/cli/test-version/amp-linux-x64');
  const first=calls;
  await ensureAmp(directory,options);
  assert.equal(calls,first);
  await ensureAmp(directory,{...options,refresh:true});
  assert.ok(calls>first);
  const refreshed=calls;
  await writeFile(result.binary,'tampered');
  await ensureAmp(directory,options);
  assert.ok(calls>refreshed);
  assert.deepEqual(await readFile(result.binary),bytes);
});

test('installer rejects a checksum mismatch and invalid version metadata', async t => {
  const directory=await mkdtemp(join(tmpdir(),'amp-install-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const fetchImpl=async url=>new Response(url.endsWith('cli-version.txt')?'test':url.endsWith('.sha256')?'a'.repeat(64):gzipSync(Buffer.from('bad')));
  await assert.rejects(ensureAmp(directory,{fetchImpl,log:()=>{}}),/checksum mismatch/);
  await assert.rejects(ensureAmp(directory,{fetchImpl:async()=>new Response('../bad')}),/Invalid Amp release version/);
});
