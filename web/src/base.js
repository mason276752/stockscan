// Where the app is served from ('' at the root, '/stockscan' under a prefix).
// The server injects window.__STOCKSCAN_BASE__ into index.html; the Vite dev
// server (no injection) uses its own base; a bundle opened without either is
// relative to the page's directory (the build uses relative asset URLs).
const injected = typeof window !== 'undefined' ? window.__STOCKSCAN_BASE__ : undefined;
const vite = import.meta.env.BASE_URL || '/';
const raw = injected != null ? injected : vite === './' || vite === '' ? location.pathname.replace(/\/[^/]*$/, '') : vite;
export const BASE = String(raw).replace(/\/+$/, '');
// absolute path under the prefix: url('/api/status') -> '/stockscan/api/status'
export const url = (p) => `${BASE}${p}`;
