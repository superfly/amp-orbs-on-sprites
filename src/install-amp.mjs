import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { ProviderError } from './api.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
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
  const base = 'https://static.ampcode.com/cli';
  async function download(path, maxBytes) {
    const response = await fetchImpl(`${base}/${path}`, { signal: AbortSignal.timeout(180_000), redirect: 'error' });
    if (!response.ok) throw new ProviderError('Could not download official Amp release');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) throw new ProviderError('Amp download exceeded its size limit');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  version ||= (await download('cli-version.txt', 1024)).toString().trim();
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new ProviderError('Invalid Amp release version');
  async function checksum(targetName) {
    const value = (await download(`${version}/${targetName}-amp.sha256`, 1024)).toString().trim();
    if (!/^[a-f0-9]{64}$/.test(value)) throw new ProviderError('Invalid Amp release checksum');
    return value;
  }
  const [digest, linuxDigest] = await Promise.all([checksum(target), checksum('linux-x64')]);
  log(`Installing verified Amp ${version} for ${target}.`);
  const bytes = gunzipSync(await download(`${version}/amp-${target}.gz`, 256 * 1024 * 1024), { maxOutputLength: 512 * 1024 * 1024 });
  if (sha256(bytes) !== digest) throw new ProviderError('Amp binary checksum mismatch');
  const temporary = join(directory, `amp-${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o755 });
  await rename(temporary, binary);
  const release = { version, target, sha256: digest,
    linux: { url: `${base}/${version}/amp-linux-x64`, sha256: linuxDigest } };
  await writeFile(manifest, JSON.stringify(release, null, 2) + '\n', { mode: 0o600 });
  return { ...release, binary };
}
