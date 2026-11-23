import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError } from './api.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const base = 'https://static.ampcode.com/cli';
async function download(fetchImpl, path, maxBytes, signal = AbortSignal.timeout(180_000)) {
  const response = await fetchImpl(`${base}/${path}`, { signal, redirect: 'error' });
  if (!response.ok) throw new ProviderError('Could not download official Amp release');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new ProviderError('Amp download exceeded its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
// Applies to an operator's SPRITES_AMP_VERSION as well as the published one:
// the version becomes part of the URL that Sprites download from.
function checkedVersion(version) {
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new ProviderError('Invalid Amp release version');
  return version;
}
const latestVersion = async (fetchImpl, signal) => (await download(fetchImpl, 'cli-version.txt', 1024, signal)).toString().trim();
async function checksum(fetchImpl, version, targetName, signal) {
  const value = (await download(fetchImpl, `${version}/${targetName}-amp.sha256`, 1024, signal)).toString().trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ProviderError('Invalid Amp release checksum');
  return value;
}
const linuxRelease = (version, sha256) => ({ url: `${base}/${version}/amp-linux-x64`, sha256 });
const validLinux = linux => typeof linux?.url === 'string' && linux.url.startsWith(`${base}/`)
  && typeof linux.sha256 === 'string' && /^[a-f0-9]{64}$/.test(linux.sha256);
const within = (now, at, ms) => now >= at && now - at < ms;

// The latest official Linux binary for Sprites, looked up at most once per
// maxAgeMs so a long-running dispatcher does not keep handing out the release
// that was current when it started. Spawns must not wait on a release host that
// is down: one deadline covers the whole lookup, a failed lookup is not retried
// for retryMs, and the last release found is used meanwhile. Resolves to null
// when no release is known and a retry is not yet due.
export async function latestLinuxAmp(cachePath, {
  fetchImpl = fetch, now = Date.now(), maxAgeMs = 3600_000, retryMs = 300_000, timeout = 10_000, signal,
} = {}) {
  let cached = {};
  try { cached = JSON.parse(await readFile(cachePath, 'utf8')) ?? {}; } catch { /* Look the release up. */ }
  // A cache entry that would not pass the spawn configuration checks is ignored.
  const known = validLinux(cached.linux) ? { version: cached.version, linux: cached.linux, checkedAt: cached.checkedAt } : {};
  if (known.linux && within(now, known.checkedAt, maxAgeMs)) return known.linux;
  if (within(now, cached.failedAt, retryMs)) return known.linux ?? null;
  const save = async value => {
    const temporary = `${cachePath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, cachePath);
  };
  const deadline = AbortSignal.any([AbortSignal.timeout(timeout), ...(signal ? [signal] : [])]);
  let version, linux;
  try {
    version = checkedVersion(await latestVersion(fetchImpl, deadline));
    linux = linuxRelease(version, await checksum(fetchImpl, version, 'linux-x64', deadline));
  } catch (error) {
    // A dispatcher shutting down says nothing about the release host.
    if (!signal?.aborted) await save({ ...known, failedAt: now }).catch(() => {});
    if (known.linux) return known.linux;
    throw error;
  }
  await save({ version, linux, checkedAt: now }).catch(() => {});
  return linux;
}

export async function ensureAmp(directory, {
  fetchImpl = fetch, platform = process.platform, arch = process.arch, version, refresh = false, log = console.log,
} = {}) {
  const target = `${platform === 'darwin' ? 'darwin' : 'linux'}-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (!['darwin', 'linux'].includes(platform) || !['arm64', 'x64'].includes(arch)) {
    throw new ProviderError('The launcher supports macOS/Linux on ARM64 or x64; use WSL on Windows');
  }
  const binary = join(directory, 'amp');
  const manifest = join(directory, 'release.json');
  try {
    const cached = JSON.parse(await readFile(manifest, 'utf8'));
    if (!refresh && cached.target === target && (!version || cached.version === version)
        && sha256(await readFile(binary)) === cached.sha256) return { ...cached, binary };
  } catch { /* Install missing or invalid cached binary. */ }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  version = checkedVersion(version || await latestVersion(fetchImpl));
  const [digest, linuxDigest] = await Promise.all([checksum(fetchImpl, version, target), checksum(fetchImpl, version, 'linux-x64')]);
  log(`Installing verified Amp ${version} for ${target}.`);
  const bytes = gunzipSync(await download(fetchImpl, `${version}/amp-${target}.gz`, 256 * 1024 * 1024), { maxOutputLength: 512 * 1024 * 1024 });
  if (sha256(bytes) !== digest) throw new ProviderError('Amp binary checksum mismatch');
  const temporary = join(directory, `amp-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o755 });
  await rename(temporary, binary);
  const release = { version, target, sha256: digest, linux: linuxRelease(version, linuxDigest) };
  await writeFile(manifest, JSON.stringify(release, null, 2) + '\n', { mode: 0o600 });
  return { ...release, binary };
}
