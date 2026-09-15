// HTTP client for sec.gov: identifying User-Agent, <10 req/s throttle, retries,
// and a small TTL cache so the UI can flip between filings without re-downloading.

const MIN_INTERVAL_MS = 110;

export class SecClient {
  constructor({ userAgent = process.env.SEC_USER_AGENT, timeoutMs = 60_000 } = {}) {
    if (!userAgent) {
      throw new Error(
        'SEC requires a User-Agent that identifies you, e.g. "MyCompany contact@example.com". ' +
          'Set the SEC_USER_AGENT environment variable.',
      );
    }
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
    this.lastRequest = 0;
    this.cache = new Map(); // url -> { expires, value }
  }

  // Serialise requests so the throttle holds even under concurrent API calls.
  _slot() {
    const run = this.queue.then(async () => {
      const wait = MIN_INTERVAL_MS - (Date.now() - this.lastRequest);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest = Date.now();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async fetch(url, { retries = 3 } = {}) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      await this._slot();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': this.userAgent, 'Accept-Encoding': 'gzip, deflate' },
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`SEC returned ${res.status} for ${url}`);
          await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
          continue;
        }
        if (res.status === 403) {
          throw Object.assign(
            new Error(`SEC returned 403 for ${url}. Check SEC_USER_AGENT (name + email) and rate limits.`),
            { status: 403 },
          );
        }
        if (res.status === 404) throw Object.assign(new Error(`Not found on SEC: ${url}`), { status: 404 });
        if (!res.ok) throw Object.assign(new Error(`SEC returned ${res.status} for ${url}`), { status: res.status });
        return res;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr;
  }

  async _cached(url, ttlMs, loader) {
    if (ttlMs > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value;
    }
    const value = await loader();
    if (ttlMs > 0) {
      this.cache.set(url, { expires: Date.now() + ttlMs, value });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    }
    return value;
  }

  text(url, { ttlMs = 0 } = {}) {
    return this._cached(url, ttlMs, async () => (await this.fetch(url)).text());
  }

  json(url, { ttlMs = 0 } = {}) {
    return this._cached(url, ttlMs, async () => (await this.fetch(url)).json());
  }
}
