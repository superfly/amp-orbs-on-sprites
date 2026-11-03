import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const org = process.env.SPRITE_ORG;
const provider = process.env.SPRITES_PROVIDER_ID;
if (!org || !/^[a-z][a-z0-9-]{0,19}$/.test(provider || '')) throw new Error('Missing hosted installation identity');
const root = join('/data', provider);
await mkdir(root, { recursive: true, mode: 0o700 });
const imported = join('/data', `${provider}.imported`);
let alreadyImported = false;
try { await readFile(imported); alreadyImported = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
for (const record of alreadyImported ? [] : JSON.parse(process.env.SPRITES_INITIAL_RECORDS || '[]')) {
  if (record.org !== org || typeof record.orbId !== 'string' || typeof record.id !== 'string' || record.paused !== true) throw new Error('Only paused, matching ownership records may be imported');
  const name = `${provider}-${createHash('sha256').update(record.orbId).digest('hex').slice(0,32)}`;
  const path = join(root, `${name}.json`);
  try {
    const existing = JSON.parse(await readFile(path, 'utf8'));
    if (existing.id !== record.id || existing.org !== org || existing.orbId !== record.orbId) throw new Error('Imported ownership conflicts with persistent state');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await writeFile(path, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
  }
}
await writeFile(imported, 'done', { mode: 0o600 });
delete process.env.SPRITES_INITIAL_RECORDS;
// The entrypoint holds an OS lock on this volume, so stale PID files are safe
// to remove even when a new VM happens to reuse a previous process's PID.
await rm(join('/data', `${provider}.controller.lock`), { force: true });
const child = spawn(process.execPath, ['start.mjs', '--org', org], { stdio: 'inherit' });
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', code => { process.exitCode = code ?? 1; });
