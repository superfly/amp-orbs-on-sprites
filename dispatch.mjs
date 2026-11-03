#!/usr/bin/env node
import { configuration, dispatch } from './src/provider.mjs';
import { SpritesAPI, ProviderError } from './src/api.mjs';
import { SpritesCLIAPI } from './src/cli-api.mjs';

// Leave thirty seconds of Amp's five-minute dispatch window for shutdown.
const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), 270_000);
const hardStop = setTimeout(() => {
  console.error('Provider deadline exceeded; inspect resource state before retrying.');
  process.exit(1);
}, 280_000);
process.once('SIGTERM', () => abort.abort());
process.once('SIGINT', () => abort.abort());
try {
  const config = configuration(process.env);
  const api = config.token ? new SpritesAPI(config.token, abort.signal) : new SpritesCLIAPI(config, abort.signal);
  await dispatch(config, api, { signal: abort.signal });
} catch (error) {
  console.error(error instanceof ProviderError ? error.message : 'Provider operation failed; inspect local state and resource status.');
  process.exitCode = 1;
} finally { clearTimeout(timer); clearTimeout(hardStop); }
