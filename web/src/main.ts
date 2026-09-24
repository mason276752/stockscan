import { createApp } from 'vue';
import App from './App.vue';
import { setApi } from './api';
import { url } from './base';
import './style.css';

// VITE_STATIC=1: the pure-frontend build (no server; data from static files)
const provider = import.meta.env.VITE_STATIC === '1' ? import('./api.static.ts') : import('./api.http.ts');
provider.then((m) => {
  setApi(m.api);
  createApp(App).mount('#app');
  registerServiceWorker();
});

// The static build installs a service worker (public/sw.js: app shell and
// offline fallback); the server build makes sure none is left over from one
// on the same origin.
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const isStatic = import.meta.env.VITE_STATIC === '1';
  if (isStatic && import.meta.env.PROD) {
    navigator.serviceWorker.register(url('/sw.js'), { updateViaCache: 'none' }).catch(() => {});
  } else {
    navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  }
}
