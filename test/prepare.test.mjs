import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareSprite } from '../src/provider.mjs';

test('preparation uses argv/stdin, has a remote timeout, and excludes Amp credentials', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'amp-prepare-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const binary = join(dir, 'sprite-stub');
  const report = join(dir, 'report.json');
  await writeFile(binary, `#!${process.execPath}\nconst fs = require('node:fs');
let input = ''; process.stdin.on('data', c => input += c);
process.stdin.on('end', () => fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, input })));
`, { mode: 0o700 });
  await prepareSprite({ spriteBin: binary, org: 'test-org', name: 'test-name', token: 'sprite-test-secret',
    orbToken: 'orb-test-secret', binaryUrl: 'https://example.com/amp', binarySha: 'a'.repeat(64) }, new AbortController().signal);
  const captured = JSON.parse(await readFile(report, 'utf8'));
  assert.ok(captured.args.includes('--no-port-forward'));
  assert.ok(captured.args.includes('220s'));
  assert.equal(captured.env.SPRITE_TOKEN, 'sprite-test-secret');
  assert.equal(captured.env.ORB_TOKEN, undefined);
  assert.equal(captured.env.AMP_ORB_PROVIDER_TOKEN, undefined);
  assert.ok(captured.input.includes('sha256sum --check --status'));
  assert.ok(!captured.args.some(v => v.includes('secret')));
  assert.ok(!captured.input.includes('secret'));
});

test('preparation reports missing CLI safely', async () => {
  await assert.rejects(prepareSprite({ spriteBin: '/no/such/sprite', org: 'org', name: 'name', token: 'secret',
    binaryUrl: 'https://example.com/amp', binarySha: 'a'.repeat(64) }, new AbortController().signal), /Cannot execute/);
});
