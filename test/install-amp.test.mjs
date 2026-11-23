import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { ensureAmp, latestLinuxAmp } from '../src/install-amp.mjs';

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
  // An operator's SPRITES_AMP_VERSION is checked before any request is made.
  const none=async()=>assert.fail('no request expected');
  for(const version of ['../bad','1.2 ','1?x']) await assert.rejects(ensureAmp(directory,{fetchImpl:none,version}),/Invalid Amp release version/);
});

test('Sprite binary lookup follows new releases and caches each lookup for an hour', async t => {
  const directory=await mkdtemp(join(tmpdir(),'amp-latest-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const cache=join(directory,'release.json');
  let version='v1', calls=0;
  const fetchImpl=async url=>{
    calls++;
    if(url.endsWith('cli-version.txt')) return new Response(version);
    assert.ok(url.endsWith(`/${version}/linux-x64-amp.sha256`));
    return new Response((version==='v1'?'1':'2').repeat(64));
  };
  const at=1_000_000;
  assert.deepEqual(await latestLinuxAmp(cache,{fetchImpl,now:at}),
    {url:'https://static.ampcode.com/cli/v1/amp-linux-x64',sha256:'1'.repeat(64)});
  version='v2';
  assert.equal((await latestLinuxAmp(cache,{fetchImpl,now:at+3599_000})).sha256,'1'.repeat(64));
  assert.equal(calls,2);
  assert.deepEqual(await latestLinuxAmp(cache,{fetchImpl,now:at+3600_000}),
    {url:'https://static.ampcode.com/cli/v2/amp-linux-x64',sha256:'2'.repeat(64)});
  await assert.rejects(latestLinuxAmp(join(directory,'other.json'),{fetchImpl:async()=>new Response('x',{status:503})}),/Could not download/);
});

test('a failing release host costs one lookup per retry interval and keeps the last release', async t => {
  const directory=await mkdtemp(join(tmpdir(),'amp-latest-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const cache=join(directory,'release.json');
  let calls=0, up=true;
  const fetchImpl=async url=>{
    calls++;
    if(!up) return new Response('x',{status:503});
    return new Response(url.endsWith('cli-version.txt')?'v1':'1'.repeat(64));
  };
  const at=1_000_000, hour=3600_000, known={url:'https://static.ampcode.com/cli/v1/amp-linux-x64',sha256:'1'.repeat(64)};
  // Nothing known yet: the caller keeps its own release and does not ask again for five minutes.
  up=false;
  await assert.rejects(latestLinuxAmp(cache,{fetchImpl,now:at}),/Could not download/);
  assert.equal(await latestLinuxAmp(cache,{fetchImpl,now:at+299_000}),null);
  assert.equal(calls,1);
  up=true;
  assert.deepEqual(await latestLinuxAmp(cache,{fetchImpl,now:at+300_000}),known);
  // An expired entry outlives a failed refresh instead of giving way to an older release.
  up=false; calls=0;
  assert.deepEqual(await latestLinuxAmp(cache,{fetchImpl,now:at+2*hour}),known);
  assert.deepEqual(await latestLinuxAmp(cache,{fetchImpl,now:at+2*hour+299_000}),known);
  assert.equal(calls,1);
});

test('release cache entries are validated and a shutdown is not recorded as a failure', async t => {
  const directory=await mkdtemp(join(tmpdir(),'amp-latest-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const cache=join(directory,'release.json');
  const fetchImpl=async url=>new Response(url.endsWith('cli-version.txt')?'v2':'2'.repeat(64));
  const at=1_000_000;
  for(const linux of [{}, {url:'https://example.com/amp',sha256:'1'.repeat(64)}, {url:'https://static.ampcode.com/cli/v1/amp-linux-x64',sha256:'bad'}]) {
    await writeFile(cache,JSON.stringify({linux,checkedAt:at}));
    assert.equal((await latestLinuxAmp(cache,{fetchImpl,now:at+1})).sha256,'2'.repeat(64));
  }
  const other=join(directory,'other.json');
  const abort=new AbortController(); abort.abort();
  const aborted=async(url,{signal})=>{signal.throwIfAborted();return new Response('v2');};
  await assert.rejects(latestLinuxAmp(other,{fetchImpl:aborted,now:at,signal:abort.signal}));
  await assert.rejects(readFile(other),{code:'ENOENT'});
});
