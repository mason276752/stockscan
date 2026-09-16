// The app's data layer. Two implementations with the same methods:
//   api.http.js    talks to the Node server (/api/...)
//   api.static.js  the pure-frontend build: reads the saved filings and
//                  prebuilt indexes as static files and computes in the browser
// main.js picks one (VITE_STATIC=1 at build time) before mounting the app.
let impl = null;

export function setApi(x) {
  impl = x;
}

export const api = new Proxy(
  {},
  {
    get(_, name) {
      if (!impl) throw new Error('api not ready');
      const v = impl[name];
      return typeof v === 'function' ? (...args) => v(...args) : v;
    },
  },
);
