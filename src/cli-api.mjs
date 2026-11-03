import { execFile } from 'node:child_process';
import { SpritesAPI, ProviderError } from './api.mjs';

export function cliFetch(config, execute = execFile) {
  return async (url, options) => {
    const target = new URL(url);
    if (target.origin !== 'https://api.sprites.dev' || !target.pathname.startsWith('/v1/')) {
      throw new ProviderError('Invalid Sprites API destination');
    }
    const args = ['-o', config.org, 'api', target.pathname + target.search, '--',
      '--silent', '--show-error', '--max-time', '40', '--connect-timeout', '10',
      '--request', options.method, '--header', 'Content-Type: application/json',
      '--write-out', '\n__FLY_AMP_HTTP__%{http_code} %{content_type}'];
    if (options.body !== undefined) args.push('--data-binary', '@-');
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    if (config.token) env.SPRITE_TOKEN = config.token;
    const output = await new Promise((accept, reject) => {
      const child = execute(config.spriteBin, args, {
        env, signal: options.signal, timeout: 45_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024,
      }, (error, stdout) => error ? reject(new ProviderError('Authenticated Sprite CLI request failed')) : accept(stdout));
      child.stdin.on('error', () => {});
      child.stdin.end(options.body);
    });
    const marker = output.lastIndexOf('\n__FLY_AMP_HTTP__');
    if (marker < 0) throw new ProviderError('Missing Sprite CLI response status');
    const trailer = output.slice(marker + '\n__FLY_AMP_HTTP__'.length);
    const match = /^(\d{3}) (.*)$/.exec(trailer);
    if (!match || Number(match[1]) < 200) throw new ProviderError('Invalid Sprite CLI response status');
    const status = Number(match[1]);
    return new Response([204, 205, 304].includes(status) ? null : output.slice(0, marker), {
      status, headers: { 'content-type': match[2] },
    });
  };
}

export class SpritesCLIAPI extends SpritesAPI {
  constructor(config, signal) { super('', signal, cliFetch(config)); }
}
