import { createHash } from 'node:crypto';
import { ProviderError } from './api.mjs';

export function installationSpec(input) {
  const { org, app, provider, region = 'ord' } = input;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(org || '') || org === 'personal') throw new ProviderError('Choose an explicit organization slug');
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(app || '')) throw new ProviderError('Invalid app name');
  if (!/^[a-z][a-z0-9-]{0,19}$/.test(provider || '')) throw new ProviderError('Invalid provider prefix');
  if (!/^[a-z]{3}$/.test(region)) throw new ProviderError('Invalid region');
  return { org, app, provider, region };
}

// The caller supplies authenticated infrastructure/credential adapters and an
// exclusively locked durable journal. No secret is written to this journal.
export async function provision(input, { platform, journal, beforeActivate = async () => {}, progress = () => {} }) {
  const spec = installationSpec(input);
  let state = await journal.read();
  if (input.ampToken && !/^aop_live_[A-Za-z0-9_-]+$/.test(input.ampToken)) throw new ProviderError('Enter a valid Amp provider token');
  if (!input.ampToken && !state?.secretsConfigured) throw new ProviderError('Enter a valid Amp provider token');
  const fingerprint = input.ampToken ? createHash('sha256').update(input.ampToken).digest('hex') : state.fingerprint;
  if (state && (JSON.stringify(state.spec) !== JSON.stringify(spec) || state.fingerprint !== fingerprint)) throw new ProviderError('Installation identity changed; use its original organization, prefix, app, and provider token');
  state ||= { version: 1, spec, fingerprint };
  const save = async patch => { state = { ...state, ...patch }; await journal.write(state); };
  const step = name => progress({ step: name, app: spec.app });
  step('checking-access');
  await platform.preflight(spec);
  if (!state.appCreated) {
    if (await platform.appExists(spec)) throw new ProviderError('App already exists without a completed ownership record; inspect it before recovery');
    await save({ phase: 'creating-app' });
    await platform.createApp(spec);
    await save({ appCreated: true });
  } else if (!await platform.appExists(spec)) throw new ProviderError('Recorded app is missing or outside the chosen organization');
  if (!state.image || input.rebuild) {
    step('building-image');
    const image = await platform.buildImage(spec);
    await save({ image, activated: false });
  }
  step('preparing-storage');
  const volumes = await platform.volumes(spec);
  if (state.volumeId) {
    if (!volumes.some(v => v.id === state.volumeId && v.name === 'dispatcher_data' && v.region === spec.region)) throw new ProviderError('Recorded volume is missing or changed');
  } else {
    if (volumes.length) throw new ProviderError('Unrecorded volume exists; inspect before recovery');
    await save({ phase: 'creating-volume' });
    await save({ volumeId: await platform.createVolume(spec) });
  }
  if (!state.secretsConfigured) {
    step('connecting-sprites');
    const credential = await platform.mintCredential(spec);
    try {
      await platform.setSecrets(spec, { ampToken: input.ampToken, spriteToken: credential.token, initialRecords: input.initialRecords || [] });
    } catch (error) {
      await platform.revokeCredential(credential).catch(() => {});
      throw error;
    }
    await save({ secretsConfigured: true, credentialExpiresAt: credential.expiresAt, credentialTokenId: credential.tokenId });
  }
  if (!state.activated) {
    step('activating-dispatcher');
    // Deployment failure can be ambiguous: the adapter must inspect/reuse the
    // same managed Machine rather than blindly creating another one.
    await beforeActivate(spec);
    await platform.deploy(spec, state.image);
    await save({ activated: true });
  }
  step('verifying-connection');
  const ready = await platform.verify(spec);
  await save({ phase: 'ready', machineId: ready.machineId, verifiedAt: new Date().toISOString() });
  progress({ step: 'ready', app: spec.app, machineId: ready.machineId });
  return state;
}
