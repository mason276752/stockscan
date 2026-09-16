import { createApp } from 'vue';
import App from './App.vue';
import { setApi } from './api';
import './style.css';

// VITE_STATIC=1: the pure-frontend build (no server; data from static files)
const provider = import.meta.env.VITE_STATIC === '1' ? import('./api.static.js') : import('./api.http.js');
provider.then((m) => {
  setApi(m.api);
  createApp(App).mount('#app');
});
