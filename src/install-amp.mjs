import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError } from './api.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const base = 'https://static.ampcode.com/cli';
async function download(fetchImpl, path, maxBytes, timeout = 180_000) {
  const response = await fetchImpl(`${base}/${path}`, { signal: AbortSignal.timeout(timeout), redirect: 'error' });
  if (!response.ok) throw new ProviderError('Could not download official Amp release');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new ProviderError('Amp download exceeded its size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function latestVersion(fetchImpl, timeout) {
  const version = (await download(fetchImpl, 'cli-version.txt', 1024, timeout)).toString().trim();
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new ProviderError('Invalid Amp release version');
  return version;
}
async function checksum(fetchImpl, version, targetName, timeout) {
  const value = (await download(fetchImpl, `${version}/${targetName}-amp.sha256`, 1024, timeout)).toString().trim();
  if (!/^[a-f0-9]{64}$/.test(value)) throw new ProviderError('Invalid Amp release checksum');
  return value;
}
const linuxRelease = (version, sha256) => ({ url: `${base}/${version}/amp-linux-x64`, sha256 });

// The latest official Linux binary for Sprites, looked up at most once per
// maxAgeMs so a long-running dispatcher does not keep handing out the release
// that was current when it started.
export async function latestLinuxAmp(cachePath, {
  fetchImpl = fetch, now = Date.now(), maxAgeMs = 3600_000, timeout = 10_000,
} = {}) {
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8'));
    if (now - cached.checkedAt < maxAgeMs && now >= cached.checkedAt) return cached.linux;
  } catch { /* Look the release up again. */ }
  const version = await latestVersion(fetchImpl, timeout);
  const linux = linuxRelease(version, await checksum(fetchImpl, version, 'linux-x64', timeout));
  const temporary = `${cachePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ version, linux, checkedAt: now }), { mode: 0o600 });
  await rename(temporary, cachePath);
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
  version ||= await latestVersion(fetchImpl);
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
