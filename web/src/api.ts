// The app's data layer. Two implementations with the same methods:
//   api.http.ts    talks to the Node server (/api/...)
//   api.static.ts  the pure-frontend build: reads the saved filings and
//                  prebuilt indexes as static files and computes in the browser
// main.ts picks one (VITE_STATIC=1 at build time) before mounting the app.
import type { Api } from './apiTypes.ts';

export type { Api };

let impl: Api | null = null;

export function setApi(x: Api): void {
  impl = x;
}

export const api: Api = new Proxy({} as Api, {
  get(_, name: string) {
    if (!impl) throw new Error('api not ready');
    const v = impl[name];
    return typeof v === 'function' ? (...args: unknown[]) => (v as (...a: unknown[]) => unknown)(...args) : v;
  },
});
