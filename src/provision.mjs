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

export const ROTATION_WARNING_DAYS = 14;
// Describes the recorded Sprite credential expiry for operator messages.
export function credentialStatus(expiresAt, now = Date.now()) {
  const at = Date.parse(expiresAt || '');
  if (Number.isNaN(at)) return { known: false };
  const daysLeft = Math.floor((at - now) / 86400_000);
  return { known: true, expiresAt: new Date(at).toISOString(), daysLeft, expired: at <= now, expiringSoon: daysLeft < ROTATION_WARNING_DAYS };
}

function recordedInstallation(spec, state) {
  if (!state?.spec) throw new ProviderError('No installation is recorded for this app; run ./setup to install one or check --app');
  if (JSON.stringify(state.spec) !== JSON.stringify(spec)) throw new ProviderError('Installation identity changed; use its original organization, prefix, app, and region');
}

// Replaces the dispatcher's restricted Sprite credential on a completed
// installation. The Amp provider token stays staged; only SPRITE_TOKEN moves.
export async function rotateCredential(input, { platform, journal, progress = () => {} }) {
  const spec = installationSpec(input);
  let state = await journal.read();
  recordedInstallation(spec, state);
  if (!state.secretsConfigured || !state.activated || !state.image) throw new ProviderError('Finish the installation with ./setup before rotating its credential');
  const save = async patch => { state = { ...state, ...patch }; await journal.write(state); };
  const step = name => progress({ step: name, app: spec.app });
  step('checking-access');
  await platform.preflight(spec);
  if (!await platform.appExists(spec)) throw new ProviderError('Recorded app is missing or outside the chosen organization');
  if (state.previousCredentialTokenId) {
    // An earlier rotation deployed its credential but could not revoke the old one.
    step('revoking-credential');
    await platform.revokeCredential({ tokenId: state.previousCredentialTokenId });
    await save({ previousCredentialTokenId: undefined });
  }
  const previous = { tokenId: state.credentialTokenId, expiresAt: state.credentialExpiresAt };
  step('connecting-sprites');
  const credential = await platform.mintCredential(spec);
  try {
    await platform.setSecrets(spec, { spriteToken: credential.token });
    step('activating-dispatcher');
    await platform.deploy(spec, state.image);
  } catch (error) {
    // The previous credential stays valid and recorded; rerun to retry.
    await platform.revokeCredential(credential).catch(() => {});
    throw error;
  }
  await save({ credentialExpiresAt: credential.expiresAt, credentialTokenId: credential.tokenId, previousCredentialTokenId: previous.tokenId, activated: true });
  step('verifying-connection');
  const ready = await platform.verify(spec);
  await save({ phase: 'ready', machineId: ready.machineId, verifiedAt: new Date().toISOString() });
  let previousRevoked = false;
  if (previous.tokenId) {
    step('revoking-credential');
    await platform.revokeCredential({ tokenId: previous.tokenId });
    await save({ previousCredentialTokenId: undefined });
    previousRevoked = true;
  }
  progress({ step: 'rotated', app: spec.app, machineId: ready.machineId });
  return { ...state, rotation: { previousRevoked, previousExpiresAt: previous.expiresAt } };
}

// Tears down the dispatcher once no Orb Sprite with its prefix remains. Steps
// are journaled so an interrupted teardown resumes where it stopped. The caller
// removes the installation directory after this returns.
export async function destroyInstallation(input, { platform, journal, progress = () => {} }) {
  const spec = installationSpec(input);
  let state = await journal.read();
  recordedInstallation(spec, state);
  const save = async patch => { state = { ...state, ...patch }; await journal.write(state); };
  const step = name => progress({ step: name, app: spec.app });
  step('checking-access');
  await platform.preflight(spec);
  step('checking-orbs');
  const remaining = await platform.listSprites(spec);
  if (remaining.names.length || remaining.more) {
    const count = `${remaining.more ? 'at least ' : ''}${remaining.names.length}`;
    throw new ProviderError(`${count} Sprite(s) named ${spec.provider}-… still exist. Delete (not just archive) their threads in Amp, wait for the dispatcher to remove them, then rerun ./setup --destroy`);
  }
  await save({ phase: 'destroying', activated: false });
  if (state.appCreated) {
    step('destroying-app');
    if (await platform.appExists(spec)) await platform.destroyApp(spec);
    await save({ appCreated: false, volumeId: undefined, machineId: undefined, image: undefined });
  }
  let credentialRevoked = false;
  for (const key of ['previousCredentialTokenId', 'credentialTokenId']) {
    if (!state[key]) continue;
    step('revoking-credential');
    await platform.revokeCredential({ tokenId: state[key] });
    await save({ [key]: undefined });
    credentialRevoked = true;
  }
  progress({ step: 'destroyed', app: spec.app });
  return { destroyed: true, spec, credentialRevoked, credentialExpiresAt: state.credentialExpiresAt, ampProvider: state.ampProvider };
}
