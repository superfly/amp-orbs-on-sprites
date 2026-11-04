import { createHash, randomBytes } from 'node:crypto';
import { installationSpec } from '../src/provision.mjs';
import { ProviderError } from '../src/api.mjs';
import { ampProviderSpec } from './amp-provider.mjs';

const safe = text => String(text).replace(/[\x00-\x1f\x7f]/g, '').slice(0,160);
export async function setupFlow({options={},env={},ui,connection,installations=[],run}) {
  ui.log('Amp Orbs on Sprites — hosted setup');
  await connection.ensureTools();
  if (!await connection.flyConnected()) {
    const choice=await ui.choose('Connect your Fly account', ['Sign in','Create an account']);
    await connection.flyLogin(choice===1?'signup':'login');
    if(!await connection.flyConnected())throw new ProviderError('Fly sign-in did not complete. Run ./setup again after signing in.');
  }
  ui.log('Connected to Fly.');
  const orgs=await connection.organizations();
  if(!orgs.length)throw new ProviderError('No Fly organizations are available. Complete account setup at https://fly.io/dashboard, then retry.');
  let org;
  if(options.org) {
    org=orgs.find(o=>o.slug===options.org);
    if(!org)throw new ProviderError('The selected organization is not available to this Fly account.');
  } else {
    const index=orgs.length===1?0:await ui.choose('Where should the dispatcher run?',orgs.map(o=>`${safe(o.name)} (${safe(o.slug)})`));
    org=orgs[index];
  }
  if(!org || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(org.slug) || org.slug==='personal')throw new ProviderError('Could not resolve the real organization slug.');
  ui.log(`Organization: ${safe(org.slug)}`);
  if(!await connection.spritesConnected(org.slug)) {
    ui.log('Authorize Sprites for this organization in the browser window opened by its CLI.');
    await connection.spritesLogin(org.slug);
    if(!await connection.spritesConnected(org.slug))throw new ProviderError('Sprites access is not ready. Complete Sprites activation for this organization and rerun ./setup.');
  }
  ui.log('Connected to Sprites. This provider requires Sprites 2 access.');
  const candidates=installations.filter(i=>i.spec.org===org.slug);
  let existing=options.app?candidates.find(i=>i.spec.app===options.app):undefined;
  if(!options.app && candidates.length) {
    const index=await ui.choose('Resume an installation or create a new one', [...candidates.map(i=>safe(i.spec.app)), 'Create a new installation']);
    existing=candidates[index];
  }
  const suffix=randomBytes(4).toString('hex');
  const suggested=`amp-orbs-${org.slug.slice(0,24)}-${suffix}`;
  const app=options.app || existing?.spec.app || await ui.ask('Fly app name',suggested);
  const spec=installationSpec({org:org.slug,app,provider:options.provider || existing?.spec.provider || env.SPRITES_PROVIDER_ID || `amp-${suffix}`,region:options.region || existing?.spec.region || 'ord'});
  // Reusing staged credentials does not require retaining or retrieving a token.
  let ampToken=env.AMP_ORB_PROVIDER_TOKEN;
  if(ampToken && !/^aop_live_[A-Za-z0-9_-]+$/.test(ampToken))throw new ProviderError('AMP_ORB_PROVIDER_TOKEN is not a valid Amp provider token.');
  if(ampToken && (options['amp-provider'] || options['amp-workspace']))throw new ProviderError('Use automatic Amp provider options or AMP_ORB_PROVIDER_TOKEN, not both.');
  let ampProvider=existing?.ampProvider;
  if(ampProvider && ((options['amp-provider'] && options['amp-provider']!==ampProvider.name) || (options['amp-workspace'] && options['amp-workspace']!==ampProvider.workspace)))throw new ProviderError('Amp provider identity changed; use the original name and workspace.');
  if(!ampToken && !existing?.secretsConfigured && !ampProvider) {
    if(existing)throw new ProviderError('This installation needs its original AMP_ORB_PROVIDER_TOKEN.');
    if(options.handoff)throw new ProviderError('Local handoff requires the existing AMP_ORB_PROVIDER_TOKEN.');
    const name=options['amp-provider'] || (options.yes ? app : await ui.ask('Amp provider name',app));
    let workspace=options['amp-workspace'] || null;
    if(!workspace && !options.yes && await ui.choose('Who should use this Amp provider?', ['Personal','An Amp workspace'])===1)workspace=await ui.ask('Amp workspace namespace');
    ampProvider=ampProviderSpec({name,workspace});
  }
  if(existing?.secretsConfigured && !ampProvider && (options['amp-provider'] || options['amp-workspace']))throw new ProviderError('This installation already has an Amp provider; automatic creation options do not apply.');
  if(ampToken) {
    const fingerprint=createHash('sha256').update(ampToken).digest('hex');
    const other=installations.find(i=>i.fingerprint===fingerprint && (i.spec.app!==spec.app || i.spec.org!==spec.org));
    if(other)throw new ProviderError(`This token already belongs to ${other.spec.app}. Resume that installation instead of starting another dispatcher.`);
  }
  const action=existing?.activated ? options.rebuild?'Rebuild and replace the existing dispatcher':'Check the existing dispatcher' : 'Deploy the dispatcher';
  ui.log(`${action}: ${spec.app}, organization ${spec.org}, region ${spec.region}.`);
  if(!existing?.activated)ui.log('This creates one always-on 512 MB Machine and a 1 GB volume. Fly hosting, remote builds, and Sprite usage are billed to this organization.');
  if(ampProvider && !existing?.secretsConfigured)ui.log(`${existing?.ampProvider?'Reuse':'Create'} Amp provider ${safe(ampProvider.name)} (${ampProvider.workspace?`workspace ${safe(ampProvider.workspace)}`:'personal'}). Its token is transferred automatically to Fly app secrets.`);
  if(options.rebuild)ui.log('The build runs on Fly. The existing dispatcher will briefly restart when the new image is deployed.');
  if(!options.yes && !await ui.confirm('Continue?')) {ui.log('Setup cancelled. No dispatcher resources were changed.');return null;}
  return run({spec,ampToken,ampProvider,handoff:!!options.handoff,rebuild:!!options.rebuild});
}
