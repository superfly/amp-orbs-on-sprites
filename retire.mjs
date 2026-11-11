#!/usr/bin/env node
// Operator-only entrypoint, invoked on the dispatcher host through authenticated SSH.
// No inbound listener and no provider credential is sent to an orb.
import { retirementConfiguration, dispatch } from './src/provider.mjs';
import { SpritesAPI, ProviderError } from './src/api.mjs';
import { SpritesCLIAPI } from './src/cli-api.mjs';

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 60_000);
const hardStop = setTimeout(() => process.exit(1), 70_000);
try {
  const encoded = process.argv[2];
  if (process.argv.length !== 3 || !encoded || encoded.length > 16000 || !/^[A-Za-z0-9+/]+=*$/.test(encoded))
    throw new ProviderError('Expected one base64-encoded retirement request');
  const request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const config = retirementConfiguration(process.env, request);
  const api = config.token ? new SpritesAPI(config.token, abort.signal) : new SpritesCLIAPI(config, abort.signal);
  console.log(JSON.stringify(await dispatch(config, api, { signal: abort.signal, log: () => {} })));
} catch (error) {
  console.error(error instanceof ProviderError ? error.message : 'Worker retirement failed; inspect provider state before retrying.');
  process.exitCode = 1;
} finally { clearTimeout(timer); clearTimeout(hardStop); }
