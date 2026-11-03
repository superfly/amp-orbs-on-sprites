import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

test('bootstrap renews and releases its hold on termination', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amp-hold-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls');
  await writeFile(log, '');
  const executable = (name, source) => writeFile(join(dir, name), '#!/bin/bash\n' + source, { mode: 0o700 });
  await executable('sprite-env', 'echo "$*" >> "$HOLD_LOG"\n');
  await executable('sleep', '/bin/sleep 0.05\n');
  await executable('amp', 'echo amp-start >> "$HOLD_LOG"\nexec /bin/sleep 20\n');
  const source = (await readFile(new URL('../bootstrap/run.sh', import.meta.url), 'utf8')).replace('/usr/local/bin/amp orb bootstrap', 'amp orb bootstrap').replaceAll('/.sprite/bin/sprite-env', 'sprite-env');
  await writeFile(join(dir, 'run.sh'), source);
  const child = spawn('bash', [join(dir, 'run.sh')], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOLD_LOG: log }, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const closed = new Promise(resolve => child.on('exit', code => resolve(code)));
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
  assert.match(await readFile(log, 'utf8'), /--release/);
});
