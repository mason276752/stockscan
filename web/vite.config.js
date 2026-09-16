import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// BASE_URL (same variable as the server): dev server and proxy live under the
// prefix too, so `BASE_URL=/stockscan npm run dev` mirrors production. The
// production build always uses relative asset URLs and takes the prefix from
// the server at runtime, so one build serves any BASE_URL.
const base = `/${String(process.env.BASE_URL || '').trim().replace(/^\/+|\/+$/g, '')}`.replace(/^\/$/, '');
const backend = process.env.VITE_BACKEND || 'http://localhost:3000';

export default defineConfig(({ command }) => ({
  plugins: [vue()],
  base: command === 'build' ? './' : `${base}/`,
  server: {
    port: 5173,
    proxy: Object.fromEntries(['/api', '/tradingview'].map((p) => [`${base}${p}`, backend])),
  },
}));
