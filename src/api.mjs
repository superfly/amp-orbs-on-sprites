export class ProviderError extends Error {}
export class ApiError extends ProviderError {
  constructor(status) { super(`Sprites API returned HTTP ${status}`); this.status = status; }
}

// Never include response bodies, request URLs, or fetch errors in diagnostics.
export class SpritesAPI {
  constructor(token, signal, fetchImpl = fetch) {
    this.token = token;
    this.signal = signal;
    this.fetch = fetchImpl;
  }
  async request(method, path, body, { missing = false } = {}) {
    let response;
    try {
      response = await this.fetch(`https://api.sprites.dev/v1${path}`, {
        method, redirect: 'error',
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.any([this.signal, AbortSignal.timeout(45_000)]),
      });
    } catch { throw new ProviderError('Sprites request failed or timed out; inspect resource state before retrying'); }
    if (missing && response.status === 404) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new ApiError(response.status); }
    let raw = '';
    let size = 0;
    try {
      const decoder = new TextDecoder();
      for await (const chunk of response.body ?? []) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new Error('limit');
        raw += decoder.decode(chunk, { stream: true });
      }
      raw += decoder.decode();
    } catch { throw new ProviderError('Sprites response incomplete or too large'); }
    if (!raw.trim()) {
      if (method === 'DELETE') return {};
      throw new ProviderError('Sprites returned an empty response');
    }
    try {
      if (response.headers.get('content-type')?.includes('ndjson')) {
        const events = raw.trim().split('\n').filter(s => s.trim()).map(s => JSON.parse(s));
        const terminal = events.at(-1);
        const finished = terminal?.type === 'complete'
          || (terminal?.type === 'sprite' && typeof terminal.services === 'object')
          || (terminal?.type === 'service' && terminal.name && terminal.action && terminal.result);
        if (events.some(e => e.type === 'error') || !finished) {
          throw new Error('incomplete operation');
        }
        return events;
      }
      return JSON.parse(raw);
    } catch { throw new ProviderError('Sprites returned an invalid or failed operation response'); }
  }
}
