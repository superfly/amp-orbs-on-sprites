import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const SECRETS = ['AMP_ORB_PROVIDER_TOKEN', 'ORB_TOKEN'];

// Reads .env.local for the installer without leaving the Amp token in the
// process environment, where every child process (CLI installers, fly, sprite,
// ps, lsof) would otherwise inherit it. Shell values take precedence over the
// file, matching process.loadEnvFile. The token is returned to the caller only.
export async function loadSettings(root, env = process.env) {
  let file = {};
  try { file = parseEnv(await readFile(join(root, '.env.local'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ampToken = env.AMP_ORB_PROVIDER_TOKEN || file.AMP_ORB_PROVIDER_TOKEN || undefined;
  for (const [key, value] of Object.entries(file)) if (!SECRETS.includes(key) && !(key in env)) env[key] = value;
  for (const key of SECRETS) delete env[key];
  return { ampToken, settings: { SPRITES_PROVIDER_ID: env.SPRITES_PROVIDER_ID } };
}

// Environment for child processes: never carries Amp or Orb credentials.
export function childEnvironment(env = process.env) {
  const copy = { ...env };
  for (const key of SECRETS) delete copy[key];
  return copy;
}
