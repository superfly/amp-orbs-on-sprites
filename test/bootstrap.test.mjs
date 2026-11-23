import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

async function holdRun(t, ampSource) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-hold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  await writeFile(log, '');
  const executable = (name, source) => writeFile(join(dir, name), '#!/bin/bash\n' + source, { mode: 0o700 });
  await executable('sprite-env', 'echo "$*" >> "$HOLD_LOG"\n');
  await executable('sleep', '/bin/sleep 0.05\n');
  await executable('amp', ampSource);
  const source = (await readFile(new URL('../bootstrap/run.sh', import.meta.url), 'utf8')).replace('amp_bin=/usr/local/bin/amp', 'amp_bin=amp').replaceAll('/.sprite/bin/sprite-env', 'sprite-env');
  assert.ok(source.includes('amp_bin=amp\n'));
  await writeFile(join(dir, 'run.sh'), source);
  const child = spawn('bash', [join(dir, 'run.sh')], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOME: dir, HOLD_LOG: log }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const closed = new Promise(resolve => child.on('exit', code => resolve(code)));
  return { child, closed, log };
}
// Sprites stops the service while sprite-env cannot answer, so releasing from
// the signal path only delays the stop until SIGKILL; pause releases instead.
test('bootstrap renews its hold and leaves release to pause on termination', async t => {
  const { child, closed, log } = await holdRun(t, 'echo amp-start >> "$HOLD_LOG"\nexec /bin/sleep 20\n');
  let calls = '';
  for (let i = 0; i < 100; i++) {
    calls = await readFile(log, 'utf8');
    if ((calls.match(/--for/g) || []).length >= 2) break;
    await delay(20);
  }
  assert.ok(calls.includes('amp-start'));
  assert.ok((calls.match(/--for/g) || []).length >= 2);
  child.kill('SIGTERM');
  assert.equal(await closed, 143);
  assert.doesNotMatch(await readFile(log, 'utf8'), /--release/);
});
test('bootstrap releases its hold when Amp exits on its own', async t => {
  const { closed, log } = await holdRun(t, 'echo amp-start >> "$HOLD_LOG"\nexit 3\n');
  assert.equal(await closed, 3);
  assert.match(await readFile(log, 'utf8'), /amp-start[\s\S]*--release/);
});

// Amp's updater writes ~/.amp/bin/amp and restarts by re-executing the path it
// was started from; the pinned binary would loop there instead of connecting.
async function startedBinary(t, updated) {
  const dir = await mkdtemp(join(tmpdir(), 'amp-updated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  await writeFile(log, '');
  const executable = (path, source) => writeFile(path, '#!/bin/bash\n' + source, { mode: 0o700 });
  await executable(join(dir, 'sprite-env'), 'exit 0\n');
  await executable(join(dir, 'amp'), 'echo "pinned $*" >> "$HOLD_LOG"\n');
  if (updated !== undefined) {
    await mkdir(join(dir, '.amp', 'bin'), { recursive: true });
    await executable(join(dir, '.amp', 'bin', 'amp'), updated);
  }
  const source = (await readFile(new URL('../bootstrap/run.sh', import.meta.url), 'utf8'))
    .replace('amp_bin=/usr/local/bin/amp', `amp_bin=${join(dir, 'amp')}`).replaceAll('/.sprite/bin/sprite-env', join(dir, 'sprite-env'));
  await writeFile(join(dir, 'run.sh'), source);
  const child = spawn('bash', [join(dir, 'run.sh')], { env: { PATH: process.env.PATH, HOME: dir, HOLD_LOG: log }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  await new Promise(resolve => child.on('exit', resolve));
  return (await readFile(log, 'utf8')).trim().split('\n');
}
test('bootstrap runs the copy Amp updated itself into, when it works', async t => {
  assert.deepEqual(await startedBinary(t), ['pinned orb bootstrap']);
  const working = 'if [[ "$1" == --version ]]; then exit 0; fi\necho "updated $*" >> "$HOLD_LOG"\n';
  assert.deepEqual(await startedBinary(t, working), ['updated orb bootstrap']);
  assert.deepEqual(await startedBinary(t, 'exit 1\n'), ['pinned orb bootstrap']);
});
