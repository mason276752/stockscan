// HTTP client for sec.gov: identifying User-Agent, <10 req/s throttle, retries,
// and a small TTL cache so the UI can flip between filings without re-downloading.

const MIN_INTERVAL_MS = 110;
const MAX_IN_FLIGHT = 4;
const IDLE_MS = 3000; // low-priority (prefetch) requests wait for this much user quiet

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
    this.inFlight = 0;
    this.waiters = [];
    this.userInFlight = 0;
    this.lastUserActivity = 0;
    this.cache = new Map(); // url -> { expires, value }
  }

  // Mark user activity (also called by the API layer for cache hits).
  touch() {
    this.lastUserActivity = Date.now();
  }

  get idle() {
    return this.userInFlight === 0 && Date.now() - this.lastUserActivity > IDLE_MS;
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

  async _acquire() {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight++;
      return;
    }
    await new Promise((r) => this.waiters.push(r));
    this.inFlight++;
  }

  _release() {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  async fetch(url, { retries = 4, priority = 'high', headers = {}, method = 'GET' } = {}) {
    if (priority === 'low') {
      // background work yields to anything the user is waiting for
      while (!this.idle) await new Promise((r) => setTimeout(r, 500));
    } else {
      this.touch();
      this.userInFlight++;
    }
    await this._acquire();
    try {
      return await this._fetchWithRetry(url, retries, headers, method);
    } finally {
      this._release();
      if (priority !== 'low') {
        this.userInFlight--;
        this.touch();
      }
    }
  }

  // Same client, but every request is low priority.
  lowPriority() {
    return {
      text: (url, opts = {}) => this.text(url, { ...opts, priority: 'low' }),
      json: (url, opts = {}) => this.json(url, { ...opts, priority: 'low' }),
      buffer: (url, opts = {}) => this.buffer(url, { ...opts, priority: 'low' }),
      head: (url, opts = {}) => this.head(url, { ...opts, priority: 'low' }),
    };
  }

  async _fetchWithRetry(url, retries, headers, method) {
    let lastErr;
    for (let attempt = 0; attempt < retries; attempt++) {
      await this._slot();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        let res;
        try {
          res = await fetch(url, {
            method,
            headers: { 'User-Agent': this.userAgent, 'Accept-Encoding': 'gzip, deflate', ...headers },
            signal: ctrl.signal,
          });
        } catch (err) {
          // network hiccup / timeout: back off and try again
          lastErr = new Error(`${err.cause?.message || err.message} while fetching ${url}`);
          await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
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

  text(url, { ttlMs = 0, priority } = {}) {
    return this._cached(url, ttlMs, async () => (await this.fetch(url, { priority })).text());
  }

  json(url, { ttlMs = 0, priority } = {}) {
    return this._cached(url, ttlMs, async () => (await this.fetch(url, { priority })).json());
  }

  // Raw bytes; with `range` ([from, to], inclusive) only that slice of the
  // file is requested - used to pull one member out of a large zip.
  async buffer(url, { priority, range } = {}) {
    const headers = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
    const res = await this.fetch(url, { priority, headers });
    if (range && res.status !== 206) throw new Error(`SEC did not honour the Range request for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Content-Length (null when the server does not say).
  async head(url, { priority } = {}) {
    const res = await this.fetch(url, { priority, method: 'HEAD' });
    const len = res.headers.get('content-length');
    return { size: len ? Number(len) : null };
  }
}
