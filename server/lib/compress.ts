// Response compression, in two places with different trade-offs.
//
// The app's payloads are large and highly compressible - the screener's 500
// rows are 2 MB of JSON that brotli takes down to under a fifth - and
// nothing in front of the server is doing it (the Docker image serves
// straight to the browser). So:
//
//   apiCompression()  the /api JSON answers, compressed per request on the
//                     zlib threadpool (never on the event loop). Hooks
//                     res.send, which res.json goes through; the NDJSON
//                     streams write with res.write and are left alone, so a
//                     basket's progress events still arrive one at a time.
//   staticCompression() the built assets, compressed once and kept in
//                     memory: their names carry a content hash, so a file
//                     never changes under the same URL and one brotli pass
//                     at a high setting is paid once per process.
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

/** Which encoding to use for a request, best first, or null for none. */
function encodingFor(req: Request): 'br' | 'gzip' | null {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

// Per-request compression: quality 4 costs about 10 ms on a 2 MB answer and
// beats gzip's default on both size and time, so there is no reason to go
// higher for a body that is compressed once and sent once.
const API_BR = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } };
// Cached for the life of the process: quality 9 is ~15 ms and within 7% of
// the maximum, where 11 costs 25 times that for the last few KB.
const STATIC_BR = { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9 } };
// Below this a compressed body saves less than the round-trip it costs to
// describe (and a packet is 1.4 KB anyway).
const MIN_BYTES = 1024;

/**
 * Compress the JSON answers of /api. `res.send` is wrapped rather than
 * `res.json` so the content type res.json set is kept, and so a handler
 * that sends a string directly is covered too; Buffers and streams pass
 * through untouched.
 */
export function apiCompression(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const encoding = encodingFor(req);
    if (!encoding) return next();
    const send = res.send.bind(res);
    res.send = function (body?: unknown) {
      // only a string body, only once, and not over an encoding a handler chose itself
      if (typeof body !== 'string' || Buffer.byteLength(body) < MIN_BYTES || res.headersSent || res.getHeader('content-encoding')) return send(body as string);
      res.send = send; // whatever happens below, do not come back through here
      res.vary('Accept-Encoding');
      const raw = Buffer.from(body, 'utf8');
      (encoding === 'br' ? brotli(raw, API_BR) : gzip(raw, { level: 6 }))
        .then((buf) => {
          res.setHeader('Content-Encoding', encoding);
          // express fills in Content-Length and the ETag from the buffer, and
          // the ETag of the compressed bytes is the right one to revalidate
          // against: Vary above keeps a shared cache from mixing encodings
          send(buf as unknown as string);
        })
        .catch(() => send(body)); // compression failed: send it plain
      return res;
    } as typeof res.send;
    next();
  };
}

/** One file's compressed copies, and what it was when they were made. */
interface Cached {
  size: number;
  mtimeMs: number;
  br?: Buffer;
  gzip?: Buffer;
}

// what is worth compressing: text, and wasm (the zstd decoder is 250 KB)
const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|map|wasm|txt|ico)$/i;
const MAX_CACHED = 16 * 1024 * 1024; // a file bigger than this is served as it is

/**
 * Serve the built assets compressed, from a memory cache keyed by the file's
 * size and mtime (so a rebuild while the server runs is picked up). Mount it
 * before express.static: what it does not handle falls through to that.
 */
export function staticCompression(dir: string): RequestHandler {
  const cache = new Map<string, Cached>();
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const encoding = encodingFor(req);
    if (!encoding || !COMPRESSIBLE.test(req.path)) return next();
    // resolve inside dir: a path that climbs out of it is not ours to serve
    const file = path.join(dir, path.normalize(req.path).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(path.resolve(dir) + path.sep) && file !== path.resolve(dir)) return next();
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
      if (!st.isFile() || st.size > MAX_CACHED) return next();
    } catch {
      return next(); // not a file here: express.static will answer (or 404)
    }
    let hit = cache.get(file);
    if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) cache.set(file, (hit = { size: st.size, mtimeMs: st.mtimeMs }));
    const ready = hit[encoding];
    if (ready) return respond(ready);
    const raw = fs.readFileSync(file);
    (encoding === 'br' ? brotli(raw, STATIC_BR) : gzip(raw, { level: 6 }))
      .then((buf) => {
        // only keep it when it actually helped, and only while the file is unchanged
        const live = cache.get(file);
        if (live === hit && buf.length < raw.length) live[encoding] = buf;
        respond(buf.length < raw.length ? buf : raw, buf.length < raw.length);
      })
      .catch(() => next());
    function respond(buf: Buffer, compressed = true) {
      if (res.headersSent) return;
      res.vary('Accept-Encoding');
      if (compressed) res.setHeader('Content-Encoding', encoding!);
      res.setHeader('Content-Type', contentType(file));
      res.setHeader('Content-Length', String(buf.length));
      res.setHeader('Cache-Control', cacheControl(req.path));
      if (req.method === 'HEAD') return void res.end();
      res.end(buf);
    }
  };
}

// the few types the build produces; express.static's own table is not reachable from here
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
};
const contentType = (file: string) => TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';

/**
 * How long a built file may be kept. Vite's asset names carry a content hash,
 * so those never change under the same URL and can be cached for good;
 * anything else (the service worker, icons) is revalidated.
 */
export const cacheControl = (urlPath: string): string => (/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/.test(urlPath) ? 'public, max-age=31536000, immutable' : 'no-cache');
