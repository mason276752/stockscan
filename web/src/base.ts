// Where the app is served from ('' at the root, '/stockscan' under a prefix).
// The server injects window.__STOCKSCAN_BASE__ into index.html; the Vite dev
// server (no injection) uses its own base; a bundle opened without either is
// relative to the page's directory (the build uses relative asset URLs). The
// data-layer worker (api.static.worker.ts) is started with the page's value
// as its name: its own location is the script under assets/.
declare global {
  interface Window {
    /** the path prefix the server injects into index.html */
    __STOCKSCAN_BASE__?: string;
  }
}

const injected = typeof window !== 'undefined' ? window.__STOCKSCAN_BASE__ : typeof WorkerGlobalScope !== 'undefined' ? self.name : undefined;
const vite = import.meta.env.BASE_URL || '/';
const raw = injected != null ? injected : vite === './' || vite === '' ? location.pathname.replace(/\/[^/]*$/, '') : vite;
export const BASE = String(raw).replace(/\/+$/, '');
// absolute path under the prefix: url('/api/status') -> '/stockscan/api/status'
export const url = (p: string): string => `${BASE}${p}`;
