// HTTP client for sec.gov: identifying User-Agent, a strict gap between
// requests, retries, and a small TTL cache so the UI can flip between
// filings without re-downloading.

// SEC allows under 10 requests a second. Every request to sec.gov goes
// through _slot(), which starts it at least this long after the one before
// it - measured on the monotonic clock, and re-checked after each wait so a
// timer that fires early cannot shorten the gap.
const MIN_INTERVAL_MS = 101;
const MAX_IN_FLIGHT = 4;
const IDLE_MS = 3000; // low-priority (prefetch) requests wait for this much user quiet

/** High priority is a user waiting; low yields until the server is quiet. */
export type Priority = 'high' | 'low';

export interface SecClientOptions {
  userAgent?: string | undefined;
  timeoutMs?: number;
}

export interface FetchOptions {
  retries?: number;
  priority?: Priority | undefined;
  headers?: Record<string, string>;
  method?: string;
}

/** What text()/json()/buffer()/head() take. */
export interface RequestOptions {
  ttlMs?: number;
  priority?: Priority | undefined;
  /** inclusive byte range, to pull one member out of a large zip */
  range?: readonly [number, number];
}

/** The read methods, as the low-priority view and the callers that only fetch see them. */
export interface Fetcher {
  text(url: string, opts?: RequestOptions): Promise<string>;
  json<T = unknown>(url: string, opts?: RequestOptions): Promise<T>;
  buffer(url: string, opts?: RequestOptions): Promise<Buffer>;
  head(url: string, opts?: RequestOptions): Promise<{ size: number | null }>;
}

/** An error carrying the HTTP status SEC answered with. */
export interface HttpError extends Error {
  status?: number;
}

export class SecClient implements Fetcher {
  readonly userAgent: string;
  readonly timeoutMs: number;
  private queue: Promise<void>;
  private lastRequest: number;
  private inFlight: number;
  private waiters: (() => void)[];
  private userInFlight: number;
  private lastUserActivity: number;
  private cache: Map<string, { expires: number; value: unknown }>;

  constructor({ userAgent = process.env.SEC_USER_AGENT, timeoutMs = 60_000 }: SecClientOptions = {}) {
    if (!userAgent) {
      throw new Error(
        'SEC requires a User-Agent that identifies you, e.g. "MyCompany contact@example.com". ' +
          'Set the SEC_USER_AGENT environment variable.',
      );
    }
    this.userAgent = userAgent;
    this.timeoutMs = timeoutMs;
    this.queue = Promise.resolve();
    this.lastRequest = -MIN_INTERVAL_MS; // monotonic (performance.now()); the first request waits for nothing
    this.inFlight = 0;
    this.waiters = [];
    this.userInFlight = 0;
    this.lastUserActivity = 0;
    this.cache = new Map(); // url -> { expires, value }
  }

  // Mark user activity (also called by the API layer for cache hits).
  touch(): void {
    this.lastUserActivity = Date.now();
  }

  get idle(): boolean {
    return this.userInFlight === 0 && Date.now() - this.lastUserActivity > IDLE_MS;
  }

  // Serialise requests so the gap holds even under concurrent API calls
  // (MAX_IN_FLIGHT of them may be open at once; only their starts are spaced).
  private _slot(): Promise<void> {
    const run = this.queue.then(async () => {
      for (let wait = MIN_INTERVAL_MS - (performance.now() - this.lastRequest); wait > 0; wait = MIN_INTERVAL_MS - (performance.now() - this.lastRequest)) {
        await new Promise<void>((r) => setTimeout(r, wait));
      }
      this.lastRequest = performance.now();
    });
    this.queue = run.catch(() => {});
    return run;
  }

  private async _acquire(): Promise<void> {
    if (this.inFlight < MAX_IN_FLIGHT) {
      this.inFlight++;
      return;
    }
    await new Promise<void>((r) => this.waiters.push(r));
    this.inFlight++;
  }

  private _release(): void {
    this.inFlight--;
    const next = this.waiters.shift();
    if (next) next();
  }

  async fetch(url: string, { retries = 4, priority = 'high', headers = {}, method = 'GET' }: FetchOptions = {}): Promise<Response> {
    if (priority === 'low') {
      // background work yields to anything the user is waiting for
      while (!this.idle) await new Promise<void>((r) => setTimeout(r, 500));
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
  lowPriority(): Fetcher {
    return {
      text: (url: string, opts: RequestOptions = {}) => this.text(url, { ...opts, priority: 'low' }),
      json: <T,>(url: string, opts: RequestOptions = {}) => this.json<T>(url, { ...opts, priority: 'low' }),
      buffer: (url: string, opts: RequestOptions = {}) => this.buffer(url, { ...opts, priority: 'low' }),
      head: (url: string, opts: RequestOptions = {}) => this.head(url, { ...opts, priority: 'low' }),
    };
  }

  private async _fetchWithRetry(url: string, retries: number, headers: Record<string, string>, method: string): Promise<Response> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt < retries; attempt++) {
      await this._slot();
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
      try {
        let res: Response;
        try {
          res = await fetch(url, {
            method,
            headers: { 'User-Agent': this.userAgent, 'Accept-Encoding': 'gzip, deflate', ...headers },
            signal: ctrl.signal,
          });
        } catch (err) {
          // network hiccup / timeout: back off and try again
          const e = err as Error & { cause?: { message?: string } };
          lastErr = new Error(`${e.cause?.message || e.message} while fetching ${url}`);
          await new Promise<void>((r) => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        if (res.status === 429 || res.status >= 500) {
          lastErr = new Error(`SEC returned ${res.status} for ${url}`);
          await new Promise<void>((r) => setTimeout(r, 2000 * (attempt + 1)));
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

  private async _cached<T>(url: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const hit = this.cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }
    const value = await loader();
    if (ttlMs > 0) {
      this.cache.set(url, { expires: Date.now() + ttlMs, value });
      if (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value!);
    }
    return value;
  }

  text(url: string, { ttlMs = 0, priority }: RequestOptions = {}): Promise<string> {
    return this._cached(url, ttlMs, async () => (await this.fetch(url, { priority })).text());
  }

  json<T = unknown>(url: string, { ttlMs = 0, priority }: RequestOptions = {}): Promise<T> {
    return this._cached(url, ttlMs, async () => (await this.fetch(url, { priority })).json() as Promise<T>);
  }

  // Raw bytes; with `range` ([from, to], inclusive) only that slice of the
  // file is requested - used to pull one member out of a large zip.
  async buffer(url: string, { priority, range }: RequestOptions = {}): Promise<Buffer> {
    const headers: Record<string, string> = range ? { Range: `bytes=${range[0]}-${range[1]}` } : {};
    const res = await this.fetch(url, { priority, headers });
    if (range && res.status !== 206) throw new Error(`SEC did not honour the Range request for ${url}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // Content-Length (null when the server does not say).
  async head(url: string, { priority }: RequestOptions = {}): Promise<{ size: number | null }> {
    const res = await this.fetch(url, { priority, method: 'HEAD' });
    const len = res.headers.get('content-length');
    return { size: len ? Number(len) : null };
  }
}
